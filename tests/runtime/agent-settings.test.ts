import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import { DEFAULT_SESSION_CONFIG, setLunaHome } from "@/shared";
import { AgentSettingsStore, DEFAULT_AGENT_SETTINGS, messageDefaults, sessionConfigForAgent, sessionConfigForSession } from "@/agents/agent-settings-store";
import { decideInboundAddressing } from "@/sessions/inbound/group-addressing";
import type { NormalizedInboundMessage } from "@/channels";
import { jobTimeoutMs } from "@/runners/runtime-agent-transport";
import { createPlatformAgentRoutes } from "@/server/routes/platform-agents";
import { fixtureNamedSession, fixtureScope } from "../helpers/platform-fixtures";

let home: string, connection: DataConnection<typeof schema>, agentId: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-agent-settings-")); setLunaHome(home);
  connection = new DataConnection(schema);
  agentId = fixtureScope(connection.db, "owner").agentId; fixtureScope(connection.db, "other");
});
afterEach(() => { connection.close(); rmSync(home, { recursive: true, force: true }); });

test("an Agent without settings gets today's behaviour as defaults", () => {
  expect(new AgentSettingsStore(connection.db).get(agentId)).toEqual(DEFAULT_AGENT_SETTINGS);
  expect(DEFAULT_AGENT_SETTINGS).toEqual({
    inbound: { processingReaction: true },
    main: { taskProgressCard: { send: true, sendOnQuietRuns: true, style: "native" } },
    pty: { idleTimeoutMinutes: 10 },
    messages: {},
    listening: { defaultEnabled: false, quietMs: 30000, batchSize: 10, maxWaitMs: 180000, backoffMaxMs: 600000, maxTurnsPerHour: 12 },
    proactivity: {},
  });
});

test("the owner saves settings; omitted groups keep their defaults and bad values are refused", () => {
  const store = new AgentSettingsStore(connection.db);
  expect(store.save("owner", agentId, { main: { taskProgressCard: { send: false } } })).toEqual({
    inbound: { processingReaction: true },
    main: { taskProgressCard: { send: false, sendOnQuietRuns: true, style: "native" } },
    pty: { idleTimeoutMinutes: 10 },
    messages: {},
    listening: { defaultEnabled: false, quietMs: 30000, batchSize: 10, maxWaitMs: 180000, backoffMaxMs: 600000, maxTurnsPerHour: 12 },
    proactivity: {},
  });
  expect(store.save("owner", agentId, { pty: { idleTimeoutMinutes: 60 } }).pty.idleTimeoutMinutes).toBe(60);
  expect(store.save("owner", agentId, { pty: { idleTimeoutMinutes: 0 } }).pty.idleTimeoutMinutes).toBe(0);
  expect(() => store.save("owner", agentId, { pty: { idleTimeoutMinutes: -1 } })).toThrow();
  expect(store.save("owner", agentId, { main: { taskProgressCard: { send: false } } }).main.taskProgressCard.send).toBe(false);
  expect(() => store.save("owner", agentId, { main: { taskProgressCard: { style: "fancy" } } })).toThrow();
  expect(() => store.save("owner", agentId, { unknown: true })).toThrow();
  expect(() => store.save("other", agentId, {})).toThrow();
  expect(() => store.read("other", agentId)).toThrow();
  // Legacy rows containing retired `work` settings still parse cleanly with their other saved fields intact.
  connection.db.insert(schema.agentSettings).values({
    agentId,
    settings: { inbound: { processingReaction: false }, work: { progressCard: { show: false, style: "card" } } } as never,
    updatedByAccountId: "owner",
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: schema.agentSettings.agentId,
    set: { settings: { inbound: { processingReaction: false }, work: { progressCard: { show: false, style: "card" } } } as never },
  }).run();
  expect(store.get(agentId).inbound.processingReaction).toBe(false);
});

test("the settings API is the owner's: read, save, reject others and invalid input", async () => {
  const app = new Hono().use("*", async (c, next) => {
    const id = c.req.header("Test-Actor");
    if (id) { (c as never as { set: (k: string, v: unknown) => void }).set("dashboardAuthSession", { authenticated: true, account: { id, name: id, provider: "test" } });
      (c as never as { set: (k: string, v: unknown) => void }).set("lunaRequestAuthKind", "dashboard-cookie"); }
    await next();
  }).route("/agents", createPlatformAgentRoutes(connection.db));
  const call = (actor: string, method = "GET", body?: unknown) => app.request(`/agents/${agentId}/settings`, {
    method, headers: { "Test-Actor": actor, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(await (await call("owner")).json()).toEqual({
    settings: DEFAULT_AGENT_SETTINGS,
    messageDefaults: messageDefaults(DEFAULT_SESSION_CONFIG),
    proactivityDefaults: new PlatformSettingsStore(connection.db).get().proactivity,
  });
  const saved = await call("owner", "PUT", { main: { taskProgressCard: { send: false, style: "card" } } });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { settings: typeof DEFAULT_AGENT_SETTINGS }).settings.main.taskProgressCard).toEqual({ send: false, sendOnQuietRuns: true, style: "card" });
  expect((await call("owner", "PUT", { main: { taskProgressCard: { style: 1 } } })).status).toBe(400);
  expect((await call("other")).status).not.toBe(200);
  expect((await call("other", "PUT", {})).status).not.toBe(200);
});

test("Task runs and Main/Work turns both read platform-level execution timeouts; legacy Agent task rows still parse", () => {
  const platform = new PlatformSettingsStore(connection.db);
  expect(jobTimeoutMs(connection.db, { runnerKind: "task", agentId })).toBe(600 * 60_000);
  platform.patch({ execution: { taskTimeoutMs: 180 * 60_000, containerTimeoutMs: 25 * 60_000 } });
  expect(jobTimeoutMs(connection.db, { runnerKind: "task", agentId })).toBe(180 * 60_000);
  for (const runnerKind of ["main", "work"]) expect(jobTimeoutMs(connection.db, { runnerKind, agentId })).toBe(25 * 60_000);
  for (const taskTimeoutMs of [0, 59_999, 7 * 24 * 3_600_000 + 1, "600"]) {
    expect(() => platform.patch({ execution: { taskTimeoutMs: taskTimeoutMs as number } })).toThrow();
  }
  connection.db.insert(schema.agentSettings).values({
    agentId,
    settings: { pty: { idleTimeoutMinutes: 45 }, task: { runLimitHours: 12 } },
    updatedByAccountId: "owner",
    updatedAt: Date.now(),
  }).run();
  expect(new AgentSettingsStore(connection.db).get(agentId).pty.idleTimeoutMinutes).toBe(45);
});

test("an Agent's message settings replace the Service configuration for its own sessions only", () => {
  const store = new AgentSettingsStore(connection.db);
  const base = DEFAULT_SESSION_CONFIG;
  const other = fixtureScope(connection.db, "third").agentId;
  expect(sessionConfigForAgent(connection.db, agentId, base)).toEqual(base);
  expect(messageDefaults(base)).toMatchObject({ coalesceIdleMs: base.coalesce_idle_ms, maxBatchSize: base.max_batch_size, groupBotAliases: base.group_bot_aliases });

  store.save("owner", agentId, { messages: { coalesceIdleMs: 3000, coalesceMaxWaitMs: 20000, maxBatchSize: 2, groupBotAliases: ["小助手"],
    followupWindowMs: 0, followupSenders: "requester_only", contextMaxMessages: 30 } }, base);
  const mine = sessionConfigForAgent(connection.db, agentId, base);
  expect(mine).toMatchObject({ coalesce_idle_ms: 3000, coalesce_max_wait_ms: 20000, max_batch_size: 2, group_bot_aliases: ["小助手"],
    group_activation_followup_window_ms: 0, group_activation_followup_senders: "requester_only", activation_context_max_messages: 30,
    // What the Agent left unset follows the Service.
    activation_context_max_chars: base.activation_context_max_chars, stale_claim_ms: base.stale_claim_ms });
  expect(sessionConfigForAgent(connection.db, other, base)).toEqual(base);

  // A session resolves to its Agent's settings.
  const scoped = fixtureNamedSession(connection.db, "s1", "fourth");
  store.save("fourth", scoped.agentId, { messages: { maxBatchSize: 3 } }, base);
  expect(sessionConfigForSession(connection.db, "s1", base).max_batch_size).toBe(3);
  expect(sessionConfigForSession(connection.db, "missing", base)).toEqual(base);

  // The Agent's alias addresses it in a group; another Agent's does not.
  const group = (text: string): NormalizedInboundMessage => ({ id: "m", channel: { id: "c", type: "feishu" }, surface: { externalId: "oc", kind: "group" },
    sender: { externalId: "u", kind: "user" }, text, mentions: [], addressing: { addressedToBot: false, reason: "silent_group" } });
  expect(decideInboundAddressing({ message: group("小助手 帮我看下"), config: mine, repliesToBotMessage: false })).toEqual({ addressedToBot: true, reason: "alias" });
  expect(decideInboundAddressing({ message: group("小助手 帮我看下"), config: base, repliesToBotMessage: false }).addressedToBot).toBe(false);

  // Out-of-range values and a max wait shorter than the idle wait are refused.
  for (const messages of [{ coalesceIdleMs: 50 }, { maxBatchSize: 0 }, { followupSenders: "everyone" }, { groupBotAliases: [""] }, { unknown: 1 }])
    expect(() => store.save("owner", agentId, { messages }, base)).toThrow();
  expect(() => store.save("owner", agentId, { messages: { coalesceIdleMs: 6000, coalesceMaxWaitMs: 5000 } }, base)).toThrow("invalid_message_coalesce");
  // Clearing the group goes back to the Service configuration.
  store.save("owner", agentId, { messages: {} }, base);
  expect(sessionConfigForAgent(connection.db, agentId, base)).toEqual(base);
});

test("the owner switches listening on the page of a group chat's session; other sessions have no switch", async () => {
  const { SessionStore } = await import("@/sessions/session-store");
  const { ChatListeningStore } = await import("@/sessions/chat-listening-store");
  const { fixtureSessionOwnership } = await import("../helpers/platform-fixtures");
  const owned = fixtureSessionOwnership(connection.db, "feishu", "feishu-main");
  const owner = connection.db.select().from(schema.lunaAgents).all().find(agent => agent.id === owned.agent_id)!.ownerAccountId;
  const group = new SessionStore(connection.db).resolveByChannelSurface({ channelType: "feishu", channelId: "feishu-main", groupId: "oc_group" });
  const direct = new SessionStore(connection.db).resolveByChannelSurface({ channelType: "feishu", channelId: "feishu-main", groupId: "oc_p2p" });
  const now = new Date().toISOString();
  for (const [externalId, surfaceKind] of [["oc_group", "group"], ["oc_p2p", "p2p"]] as const)
    connection.db.insert(schema.channelSurfaces).values({ id: externalId, channelType: "feishu", channelId: "feishu-main", externalId, surfaceKind,
      firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now }).run();
  const app = new Hono().use("*", async (c, next) => {
    const id = c.req.header("Test-Actor")!;
    (c as never as { set: (k: string, v: unknown) => void }).set("dashboardAuthSession", { authenticated: true, account: { id, name: id, provider: "test" } });
    (c as never as { set: (k: string, v: unknown) => void }).set("lunaRequestAuthKind", "dashboard-cookie");
    await next();
  }).route("/agents", createPlatformAgentRoutes(connection.db));
  const call = async (actor: string, sessionId: string, enabled?: boolean) => {
    const response = await app.request(`/agents/${owned.agent_id}/sessions/${sessionId}/listening`, { method: enabled === undefined ? "GET" : "PUT",
      headers: { "Test-Actor": actor, "content-type": "application/json" }, ...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }) });
    return { status: response.status, body: await response.json() as { listening?: boolean | null } };
  };
  expect(await call(owner, group.id)).toEqual({ status: 200, body: { listening: false } });
  expect(await call(owner, group.id, true)).toEqual({ status: 200, body: { listening: true } });
  expect(new ChatListeningStore(connection.db).enabled(group)).toBe(true);
  expect((await call(owner, group.id)).body.listening).toBe(true);
  expect((await call(owner, direct.id)).body.listening).toBeNull();
  expect((await call(owner, direct.id, true)).status).toBe(404);
  expect((await call("other", group.id, false)).status).not.toBe(200);
  expect(new ChatListeningStore(connection.db).enabled(group)).toBe(true);
});
