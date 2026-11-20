import { fixtureOwnerUserId, fixtureScope, fixtureSessionOwnership } from "../helpers/platform-fixtures";
/** The Dashboard account acts in its Agent as the owner's user. */
const dashboardUserId = fixtureOwnerUserId("dashboard-user");
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { feishuIdentityMetadata } from "../../src/identity/feishu-identity-scopes";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { config, DEFAULT_SESSION_CONFIG, setLunaHome } from "../../src/shared";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionResolver } from "../../src/sessions/session-resolver";
import { createSessionChatRoutes } from "../../src/server/routes/session-chat";
import { DashboardChannel } from "../../src/channels/dashboard/dashboard-channel";
import { LunaMessageIngress } from "./support/main-command-harness";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import type { MainRunner, MainRunnerRunInput } from "../../src/main-runner/main-runner";
import type { NormalizedInboundMessage } from "../../src/channels";
let home: string, previousHome: string, db: DataConnection<typeof schema>, sessionId: string;
let feishuReplyUserId: string;
let ingress: LunaMessageIngress, channel: DashboardChannel, feishu: FakeFeishuChannel;
let calls: MainRunnerRunInput[];
beforeEach(async () => {
  previousHome = config.paths.home;
  home = mkdtempSync(join(tmpdir(), "luna-chat-")); setLunaHome(home);
  db = new DataConnection(schema);
  feishuReplyUserId = fixtureSessionOwnership(db.db, "feishu", "test", "dashboard-user").bot_user_id;
  sessionId = new SessionStore(db.db).resolveByChannelSurface({ channelType: "feishu", channelId: "test", groupId: "chat" }).id;
  calls = [];
  feishu = new FakeFeishuChannel("test");
  channel = new DashboardChannel(db.db);
  ingress = new LunaMessageIngress({ db: db.db, runnerType: "mock",
    sessionConfig: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 100, coalesce_max_wait_ms: 300 },
    mainRunner: { run: async (input: MainRunnerRunInput) => { calls.push(input); return { operation: "message.send", reply: "你好，Tester", reason: "test" }; } } as unknown as MainRunner,
  });
  await ingress.registerChannel(feishu);
  await ingress.registerChannel(channel);
});
afterEach(async () => { await ingress?.stop(); db.close(); setLunaHome(previousHome); rmSync(home, { recursive: true, force: true }); });
function app(kind = "dashboard-cookie") {
  return new Hono<{ Variables: Record<string, unknown> }>().use("*", async (c, next) => {
    c.set("dashboardAuthSession", { authenticated: true, account: { id: "dashboard-user", name: "Tester", provider: "test" } });
    c.set("lunaRequestAuthKind", kind);
    if (kind === "luna-access-token") c.set("lunaAccessTokenClaims", { source: "runner" });
    await next();
  }).route("/sessions", createSessionChatRoutes({ db: db.db, channel }));
}
const send = (server: Pick<Hono, "request">, text = "hello", key = "test-message", id = sessionId) => server.request(`/sessions/${id}/messages`, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ text }),
});
test("dashboard uses ordinary inbox, user-message Main input, turn entries and bot reply persistence", async () => {
  const server = app();
  const first = await send(server); expect(first.status).toBe(202);
  const result = await first.json() as { messageId: string };
  expect(await (await send(server)).json()).toEqual(result);
  expect((await send(server, "different")).status).toBe(409);
  await ingress.waitForIdle();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.input.type).toBe("user_messages");
  expect(db.db.select().from(schema.sessionCommands).all()).toHaveLength(1);
  const inbox = db.db.select().from(schema.sessionInbox).all();
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({ message_id: result.messageId, session_id: sessionId, status: "completed" });
  const entries = db.db.select().from(schema.sessionTurnEntries).all();
  expect(entries.filter(row => row.turn_id === inbox[0]!.turn_id).length).toBeGreaterThanOrEqual(1);
  const rows = db.db.select().from(schema.messages).all();
  expect(rows.find(row => row.id === result.messageId)).toMatchObject({ channelType: "dashboard", senderUserId: dashboardUserId });
  const dashboardIdentity = db.db.select().from(schema.channelIdentities)
    .where(eq(schema.channelIdentities.channelType, "dashboard")).all()
    .find(row => row.externalId === dashboardUserId)!;
  expect(db.db.select().from(schema.channelUserBindings)
    .where(eq(schema.channelUserBindings.channelIdentityId, dashboardIdentity.id)).get()?.userId).toBe(dashboardUserId);
  expect(db.db.select().from(schema.userIdentityLinks)
    .where(eq(schema.userIdentityLinks.identityNamespace, "dashboard")).all())
    .toEqual([expect.objectContaining({ userId: dashboardUserId, identityValue: dashboardUserId })]);
  const reply = rows.find(row => row.role === "assistant")!;
  expect(reply.senderUserId).toBe(feishuReplyUserId);
  expect(db.db.select().from(schema.channelIdentities).all().filter(row => row.channelType === "dashboard" && row.identityKind === "bot")).toHaveLength(0);
  expect(db.db.select().from(schema.users).where(eq(schema.users.id, reply.senderUserId)).get()?.kind).toBe("shadow");
  expect(new SessionStore(db.db).channelBindings(sessionId).map(row => row.channelId)).toEqual(["test"]);
  expect(db.db.select().from(schema.sessionCommands).all()[0]).toMatchObject({status: "sent", providerMessageId: expect.any(String)});
  expect(feishu.outbound).toHaveLength(1);
  expect(feishu.outbound[0]).toMatchObject({ content: "你好，Tester", replyMode: "channel_message" });
  expect(feishu.outbound[0]?.mention).toBeUndefined();
  expect((await server.request(`/sessions/${sessionId}/messages/${result.messageId}/status`)).status).toBe(200);
});
test("direct session input and provider surface share the normal queue", async () => {
  const server = app();
  const [one, retry, two] = await Promise.all([send(server), send(server), send(server, "second", "two")]);
  expect(one.status).toBe(202); expect(await retry.json()).toEqual(await one.json()); expect(two.status).toBe(202);
  await ingress.waitForIdle();
  expect(db.db.select().from(schema.sessions).all()).toHaveLength(1);
  const raw = db.db.select().from(schema.messages).all().find(row => row.role === "user")!.rawPayloadJson as NormalizedInboundMessage;
  expect(new SessionResolver(new SessionStore(db.db)).resolveFromNormalizedInbound(raw).id).toBe(sessionId);
  expect(new SessionStore(db.db).resolveByChannelSurface({ channelType: "feishu", channelId: "test", groupId: "chat" }).id).toBe(sessionId);
  expect(db.db.select().from(schema.sessionInbox).all()).toHaveLength(2);
  expect(calls).toHaveLength(1);
});
test("thread replies use the bound provider root, never dashboard message IDs", async () => {
  sessionId = new SessionStore(db.db).resolveByChannelSurface({ channelType: "feishu", channelId: "test", groupId: "chat", threadId: "thread", rootMessageId: "om_root" }).id;
  expect((await send(app())).status).toBe(202);
  await ingress.waitForIdle();
  expect(feishu.outbound[0]).toMatchObject({ replyMode: "reply_in_thread", targetMessageId: "om_root" });
  const reply = db.db.select().from(schema.messages).all().find(row => row.role === "assistant")!;
  expect(db.db.select().from(schema.sessionTimelineEntries).where(eq(schema.sessionTimelineEntries.messageId, reply.id)).get()?.sessionId).toBe(sessionId);
  expect(db.db.select().from(schema.sessions).all()).toHaveLength(2);
});
test("rejects unauthenticated and runner access, empty input, unavailable sessions and inactive actors", async () => {
  expect((await send(new Hono().route("/sessions", createSessionChatRoutes({ db: db.db, channel })))).status).toBe(401);
  expect((await send(app("luna-access-token"))).status).toBe(403);
  expect((await send(app(), "   ")).status).toBe(400);
  expect((await send(app(), "hello", "test", "missing")).status).toBe(404);
  db.db.update(schema.users).set({ status: "blocked" }).where(eq(schema.users.id, dashboardUserId)).run();
  expect((await send(app())).status).toBe(403);
  db.db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, dashboardUserId)).run();
  db.db.update(schema.sessions).set({ status: "closed" }).where(eq(schema.sessions.id, sessionId)).run();
  expect((await send(app())).status).toBe(404);
});

test("provider failure is retained in the message command and reported by the inbox", async () => {
  feishu.send = async () => { throw new Error("provider offline"); };
  const server = app();
  const result = await (await send(server)).json() as { messageId: string };
  await ingress.waitForIdle();
  const status = await (await server.request(`/sessions/${sessionId}/messages/${result.messageId}/status`)).json();
  expect(status).toMatchObject({ status: "failed", error: expect.stringContaining("provider offline") });
  expect(db.db.select().from(schema.sessionTurns).all()[0]?.status).toBe("failed");
  expect(db.db.select().from(schema.sessionCommands).all()[0]).toMatchObject({status: "unknown", error: expect.stringContaining("provider offline")});
});

test("execution rejection accepts the message and persists one error reply while the turn stays failed", async () => {
  await ingress.stop();
  feishu = new FakeFeishuChannel("test");
  channel = new DashboardChannel(db.db);
  const { ExecutionError } = await import("@luna/execution-store");
  ingress = new LunaMessageIngress({ db: db.db, runnerType: "mock",
    sessionConfig: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 1 },
    mainRunner: { run: async () => { throw new ExecutionError(403, "agent_worker_access_denied"); } } as unknown as MainRunner,
  });
  await ingress.registerChannel(feishu);
  await ingress.registerChannel(channel);
  sessionId = new SessionStore(db.db).createLocalSession(dashboardUserId,fixtureScope(db.db,"dashboard-user")).id;
  const server = app();
  const response = await send(server);
  expect(response.status).toBe(202);
  const result = await response.json() as {messageId: string};
  await ingress.waitForIdle();
  const replies = db.db.select().from(schema.messages).all().filter(row => row.role === "assistant");
  expect(replies).toHaveLength(1);
  expect(JSON.stringify(replies[0]!.contentJson)).toContain("暂停接单");
  expect(replies[0]!.senderUserId).toBe(new SessionStore(db.db).requireReplyUserId(sessionId));
  expect(db.db.select().from(schema.sessionTimelineEntries).where(eq(schema.sessionTimelineEntries.messageId, replies[0]!.id)).get()?.sessionId).toBe(sessionId);
  expect(await (await server.request(`/sessions/${sessionId}/messages/${result.messageId}/status`)).json())
    .toMatchObject({status: "failed", error: expect.stringContaining("agent_worker_access_denied")});
  expect((await send(server)).status).toBe(202);
  await ingress.waitForIdle();
  expect(db.db.select().from(schema.messages).all().filter(row => row.role === "assistant")).toHaveLength(1);
  expect(feishu.outbound).toHaveLength(0);
});

test("direct session access survives adapter recreation without adding bindings", async () => {
  await send(app()); await ingress.waitForIdle();
  const bindingCount = db.db.select().from(schema.sessionSurfaceAliases).all().length;
  const replacement = new DashboardChannel(db.db);
  const replacementIngress = new LunaMessageIngress({ db: db.db, runnerType: "mock", sessionConfig: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 1 },
    mainRunner: { run: async () => ({ operation: "message.send", reply: "after restart", reason: "test" }) } as unknown as MainRunner });
  const replacementFeishu = new FakeFeishuChannel("test");
  await replacementIngress.registerChannel(replacementFeishu);
  await replacementIngress.registerChannel(replacement);
  try {
    const first = await replacement.submit(sessionId, { id: "dashboard-user", name: "Tester", provider: "test" }, "hello", "test-message");
    expect(first.messageId).toBeTruthy();
    await replacement.submit(sessionId, { id: "dashboard-user", name: "Tester", provider: "test" }, "after restart", "restart");
    await replacementIngress.waitForIdle();
    expect(db.db.select().from(schema.sessionSurfaceAliases).all()).toHaveLength(bindingCount);
    expect(new SessionStore(db.db).getById(sessionId)).toMatchObject({ channel_type: "feishu", channel_id: "test", group_id: "chat" });
    expect(feishu.outbound).toHaveLength(1);
    expect(replacementFeishu.outbound).toHaveLength(1);
  } finally { await replacementIngress.stop(); }
});

test("Feishu and Dashboard replies share the canonical bot established before delivery", async () => {
  feishu.getBotIdentity = () => ({ externalId: "real-bot", kind: "bot", displayName: "Shared Assistant" });
  const originalSend = feishu.send.bind(feishu);
  feishu.send = async (inbound, operation) => {
    const botId = new SessionStore(db.db).getById(sessionId)?.bot_user_id;
    expect(botId).toBeTruthy();
    expect(botId).toBe(feishuReplyUserId);
    const receipt = await originalSend(inbound, operation);
    // Neither a missing nor an incorrect delivery sender determines the business identity.
    return { ...receipt, sender: { externalId: "wrong-receipt-bot", kind: "bot", displayName: "Wrong" } };
  };
  const native: NormalizedInboundMessage = {
    id: "native-message", channel: { type: "feishu", id: "test" }, surface: { externalId: "chat", kind: "group" },
    sender: { externalId: "native-user", kind: "user",
      ...feishuIdentityMetadata({ environment: "feishu", appId: "test:feishu:test" }, { open_id: "native-user" }) },
    text: "hello", mentions: [], addressing: { addressedToBot: true, reason: "p2p" },
  };
  await ingress.handleInboundMessageForTest(feishu, native);
  await ingress.waitForIdle();
  expect((await send(app())).status).toBe(202);
  await ingress.waitForIdle();
  const botId = new SessionStore(db.db).getById(sessionId)!.bot_user_id;
  const replies = db.db.select().from(schema.messages).all().filter(m => m.role === "assistant");
  expect(replies).toHaveLength(2);
  expect(new Set(replies.map(m => m.senderUserId))).toEqual(new Set([botId!]));
  expect(db.db.select().from(schema.channelIdentities).all().some(i => i.externalId === "wrong-receipt-bot")).toBe(false);
});
test("Dashboard-only sessions reply as Luna without any external bot", async () => {
  const local = new SessionStore(db.db).createLocalSession(dashboardUserId,fixtureScope(db.db,"dashboard-user"));
  sessionId = local.id;
  const localReplyUserId = new SessionStore(db.db).requireReplyUserId(sessionId);
  expect(localReplyUserId).not.toBe(feishuReplyUserId);
  expect((await send(app())).status).toBe(202);
  await ingress.waitForIdle();
  expect(feishu.outbound).toHaveLength(0);
  expect(new SessionStore(db.db).channelBindings(sessionId)).toHaveLength(0);
  expect(db.db.select().from(schema.sessionChannelDeliveries).all()).toHaveLength(0);
  expect(db.db.select().from(schema.messages).all().find(row=>row.role==="assistant")?.senderUserId).toBe(localReplyUserId);
});
test("adapter identity changes preserve the Shadow reply identity", async () => {
  expect((await send(app())).status).toBe(202);
  await ingress.waitForIdle();
  feishu.getBotIdentity = () => ({ externalId: "other-bot", kind: "bot", displayName: "Other" });
  await channel.submit(sessionId, { id: "dashboard-user", name: "Tester", provider: "test" }, "other", "other");
  await ingress.waitForIdle();
  expect(new SessionStore(db.db).getById(sessionId)!.bot_user_id).toBe(feishuReplyUserId);
});

test("Agent owner can create a standalone Dashboard session without external channels",async()=>{
  const {agentId, shadowId} = fixtureScope(db.db, "dashboard-user");
  const result = await app().request("/sessions/dashboard", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({agentId}),
  });
  expect(result.status).toBe(201);
  const {sessionId:created}=await result.json() as {sessionId:string};
  expect(new SessionStore(db.db).getById(created)).toMatchObject({channel_id:"luna-dashboard",shadow_id:shadowId,created_by_user_id:dashboardUserId});
  expect(new SessionStore(db.db).channelBindings(created)).toHaveLength(0);
  expect(db.db.select().from(schema.sessionSurfaceAliases).all().filter(row => row.session_id === created)).toHaveLength(0);
  expect((await send(app(),"hello","standalone",created)).status).toBe(202);await ingress.waitForIdle();expect(feishu.outbound).toHaveLength(0);
});

test("Dashboard cannot be attached as an outbound channel", () => {
  expect(() => new SessionStore(db.db).bindChannelSurface(sessionId, {
    channelType: "dashboard", channelId: "luna-dashboard", groupId: sessionId,
  })).toThrow("Dashboard is not a delivery channel");
});


test("startup skips deleted sessions while binding channel bots", async () => {
  const { deleteDashboardSession } = await import("../../src/dashboard-api/deletion");
  const local = new SessionStore(db.db).createLocalSession(dashboardUserId,fixtureScope(db.db,"dashboard-user"));
  deleteDashboardSession(db.db, sessionId);
  deleteDashboardSession(db.db, local.id);
  await ingress.start();
  expect(new SessionStore(db.db).getById(local.id)).toBeUndefined();
  expect(db.db.select().from(schema.sessionChannelBindings).all()).toHaveLength(0);
  expect(db.db.select().from(schema.sessionSurfaceAliases).all()).toHaveLength(0);
});

test("reply identity is explicit and invalid identity prevents command acceptance", async () => {
  const { SessionCommandService } = await import("../../src/messaging/session-command-service");
  const store = new SessionStore(db.db);
  expect(store.requireReplyUserId(sessionId)).toBe(feishuReplyUserId);
  expect(() => db.db.update(schema.sessions).set({ bot_user_id: null }).where(eq(schema.sessions.id, sessionId)).run())
    .toThrow("session_scope_immutable");
  db.db.update(schema.users).set({ status: "removed" }).where(eq(schema.users.id, feishuReplyUserId)).run();
  const commands = new SessionCommandService({ db: db.db, channelFor: () => feishu });
  expect(() => commands.accept({ userId: dashboardUserId, sourceSessionId: sessionId, originId: "test" }, sessionId, "message.send", "missing-identity", { content: "Must not be sent" }))
    .toThrow("Shadow reply identity is unavailable");
  expect(db.db.select().from(schema.messages).all()).toHaveLength(0);
  expect(db.db.select().from(schema.sessionCommands).all()).toHaveLength(0);
  expect(feishu.outbound).toHaveLength(0);
});
