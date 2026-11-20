import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { config, setLunaHome } from "@/shared";
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
    work: { progressCard: { show: true, style: "card" } },
    main: { taskProgressCard: { send: true, style: "native" } },
    task: { runLimitHours: 10 },
    pty: { idleTimeoutMinutes: 10 },
    messages: {},
    listening: { defaultEnabled: false, quietMs: 30000, batchSize: 10, maxWaitMs: 180000, backoffMaxMs: 600000, maxTurnsPerHour: 12 },
  });
});

test("the owner saves settings; omitted groups keep their defaults and bad values are refused", () => {
  const store = new AgentSettingsStore(connection.db);
  expect(store.save("owner", agentId, { work: { progressCard: { show: false } } })).toEqual({
    inbound: { processingReaction: true },
    work: { progressCard: { show: false, style: "card" } },
    main: { taskProgressCard: { send: true, style: "native" } },
    task: { runLimitHours: 10 },
    pty: { idleTimeoutMinutes: 10 },
    messages: {},
    listening: { defaultEnabled: false, quietMs: 30000, batchSize: 10, maxWaitMs: 180000, backoffMaxMs: 600000, maxTurnsPerHour: 12 },
  });
  expect(store.save("owner", agentId, { pty: { idleTimeoutMinutes: 60 } }).pty.idleTimeoutMinutes).toBe(60);
  expect(store.save("owner", agentId, { pty: { idleTimeoutMinutes: 0 } }).pty.idleTimeoutMinutes).toBe(0);
  expect(() => store.save("owner", agentId, { pty: { idleTimeoutMinutes: -1 } })).toThrow();
  expect(store.save("owner", agentId, { work: { progressCard: { show: false } } }).work.progressCard.show).toBe(false);
  expect(() => store.save("owner", agentId, { work: { progressCard: { style: "fancy" } } })).toThrow();
  expect(() => store.save("owner", agentId, { unknown: true })).toThrow();
  expect(() => store.save("other", agentId, {})).toThrow();
  expect(() => store.read("other", agentId)).toThrow();
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
  expect(await (await call("owner")).json()).toEqual({ settings: DEFAULT_AGENT_SETTINGS, messageDefaults: messageDefaults(config.session) });
  const saved = await call("owner", "PUT", { main: { taskProgressCard: { send: false, style: "card" } } });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { settings: typeof DEFAULT_AGENT_SETTINGS }).settings.main.taskProgressCard).toEqual({ send: false, style: "card" });
  expect((await call("owner", "PUT", { main: { taskProgressCard: { style: 1 } } })).status).toBe(400);
  expect((await call("other")).status).not.toBe(200);
  expect((await call("other", "PUT", {})).status).not.toBe(200);
});

test("a Task run gets the Agent's run limit; Main and Work turns keep the Service limit", () => {
  const store = new AgentSettingsStore(connection.db);
  expect(jobTimeoutMs(connection.db, { runnerKind: "task", agentId })).toBe(10 * 3_600_000);
  expect(store.save("owner", agentId, { task: { runLimitHours: 3 } }).task.runLimitHours).toBe(3);
  expect(jobTimeoutMs(connection.db, { runnerKind: "task", agentId })).toBe(3 * 3_600_000);
  for (const runnerKind of ["main", "work"]) expect(jobTimeoutMs(connection.db, { runnerKind, agentId })).toBe(config.sandbox.containerTimeoutMs);
  for (const runLimitHours of [0, 1.5, 169, "10"]) expect(() => store.save("owner", agentId, { task: { runLimitHours } })).toThrow();
});

test("an Agent's message settings replace the Service configuration for its own sessions only", () => {
  const store = new AgentSettingsStore(connection.db);
  const base = config.session;
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
