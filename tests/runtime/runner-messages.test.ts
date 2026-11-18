import { registerTestRunnerJob, startTestRunnerJob } from "./support/runner-job";
import { encodeInvocation } from "../../src/runners/invocation-codec";
import { InvocationStore } from "../../src/runners/invocation-store";
import { eq } from "drizzle-orm";
import { createRunnerGroupRoutes } from "../../src/server/routes/runner-groups";
import { createRunnerUserRoutes } from "../../src/server/routes/runner-users";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { sessionCommandsFor } from "../../src/messaging/session-command-service";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { setLunaHome } from "../../src/shared";
import { SessionResolver } from "../../src/sessions/session-resolver";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { mainInvocations } from "../../src/runners/main-invocation-registry";
import { runnerMessageEnvelopeFromRow } from "../../src/runners/message-envelope";
import { createRunnerMessageRoutes } from "../../src/server/routes/runner-messages";
import type { LunaAccessTokenClaims } from "../../src/server/auth/access-token-service";
import type { NormalizedInboundMessage } from "../../src/channels";
import type { WorkReplyChannel } from "../../src/work/types";
import { fixtureSessionOwnership, fixtureUser } from "../helpers/platform-fixtures";
import { feishuIdentityMetadata } from "../../src/identity/feishu-identity-scopes";

let home: string;
let connection: DataConnection<typeof schema>;
afterEach(() => { connection?.close(); if (home) rmSync(home, { recursive: true, force: true }); });

function fixture(withActiveJob = true, runnerKind: "main" | "work" = "main", botLookup?: WorkReplyChannel["listGroupBots"]) {
  home = mkdtempSync(join(tmpdir(), "luna-message-api-")); setLunaHome(home);
  connection = new DataConnection(schema); const db = connection.db;
  const scope = fixtureSessionOwnership(db, "feishu", "test");
  fixtureUser(db, scope.agent_id, "user");
  fixtureSessionOwnership(db, "feishu", "private");
  const inbound: NormalizedInboundMessage = { id: "external-1", channel: { id: "test", type: "feishu" }, surface: { externalId: "chat", kind: botLookup ? "group" : "p2p" }, sender: { externalId: "user", kind: "user" }, text: "hello", mentions: [], addressing: { addressedToBot: true, reason: botLookup ? "mention" : "p2p" } };
  if (botLookup) new ChannelDirectoryStore(db).upsertSurface({ channel: inbound.channel, surface: inbound.surface });
  const session = new SessionResolver(new SessionStore(db)).resolveFromNormalizedInbound(inbound);
  const row = new MessageStore(db).appendOnce({ sessionId: session.id, channelMessageKey: inbound.id, role: "user", senderUserId: "user", content: [{ type: "text", text: "hello" }], inbound, channel: inbound.channel, surface: inbound.surface, sender: inbound.sender }).row;
  const context = new RunnerContextStore(db).resolveForSession(session.id, "codex");
  const controller = new AbortController();
  const store = new InvocationStore(db);
  controller.signal.addEventListener("abort", () => store.revoke("invocation", "test cancelled"));
  mainInvocations(db).set("invocation", { invocationId: "invocation", turnId: "logical-turn", runnerContext: context, signal: controller.signal, input: { type: "user_messages", messages: [{ ...runnerMessageEnvelopeFromRow({ row, rawMessage: inbound }), rawMessage: inbound }], latestMessage: inbound, context: { sessionId: session.id, candidateOpenTasks: [] } } });
  const claims: LunaAccessTokenClaims = { tokenId: "token", actorUserId: "user", source: "runner", role: "runner", runnerKind, agentId: session.agent_id, shadowId: session.shadow_id, sessionId: session.id, runnerJobId: context.id, issuedAt: 1, expiresAt: Date.now() + 10000 };
  db.insert(schema.accessTokens).values({ id: "token", agentId: claims.agentId, tokenHash: "hash", userId: "user", source: "runner", name: "test", role: "runner", issuedAt: 1, expiresAt: Date.now() + 10000, createdAt: 1, metadataJson: { invocationId: "invocation" } }).run();
  if (withActiveJob) {
    const snapshot = runnerKind === "main" ? encodeInvocation("main", mainInvocations(db).get("invocation")!)
      : encodeInvocation("work", {sessionId: session.id, runnerContextId: context.id, turnId: "logical-turn"});
    registerTestRunnerJob(db, "invocation", claims, snapshot, "logical-turn");
  }
  let sends = 0;
  sessionCommandsFor(db, () => ({ send: async (_inbound, operation) => { sends++; return { ...operation, id: `out-${sends}`, channelId: "test" }; } }));
  const app = new Hono<{ Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims } }>();
  app.use("*", async (c, next) => { c.set("lunaAccessTokenClaims", claims); await next(); });
  app.route("/api/runner", createRunnerMessageRoutes({ db, channelFor: () => ({ send: async (_inbound, operation) => { sends++; return { ...operation, id: `out-${sends}`, channelId: "test" }; } }) }));
  app.route("/api/runner", createRunnerUserRoutes({ db, channelFor: channelId => ({ send: async () => { throw Error("unexpected send"); }, ...(botLookup ? { listGroupBots: botLookup } : {}), lookupUser: async (_type, id) => ({ externalId: id, kind: "user", displayName: "New Recipient", providerIds: { open_id: id }, ...feishuIdentityMetadata({environment: "feishu", appId: `test:feishu:${channelId}`}, {open_id: id}) }) }) }));
  app.route("/api/runner", createRunnerGroupRoutes({ db, channelFor: () => ({ send: async () => { throw Error("unexpected send"); }, lookupGroup: async id => ({ externalId: id, kind: "group", displayName: "Project Group" }) }) }));
  const send = (text = "progress", key = "stable", target: unknown = { kind: "current_session" }) => app.request("/api/runner/messages", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ target, content: [{ type: "text", text }] }) });
  return { app, send, controller, claims, context, session, row, inbound, sends: () => sends };
}

test("message API sends once, rejects conflicting replay and cancelled invocations", async () => {
  const f = fixture();
  const first = await f.send(); expect(first.status).toBe(202);
  expect(await first.json()).toMatchObject({ deliveryStatus: "pending" });
  await sessionCommandsFor(connection.db,()=>undefined).waitForIdle();
  expect((await f.send()).status).toBe(200); expect(f.sends()).toBe(1);
  expect((await f.send("changed")).status).toBe(409);
  expect((await f.send("hello", "other", { kind: "session", sessionId: "elsewhere" })).status).toBe(404);
  f.controller.abort(); expect((await f.send("late", "late")).status).toBe(409);
  expect(f.sends()).toBe(1);
});

test("non-main runner and expired process capabilities cannot send", async () => {
  const f = fixture();
  (f.claims as { runnerKind: string }).runnerKind = "task";
  expect((await f.send()).status).toBe(403);
  (f.claims as { runnerKind: string }).runnerKind = "main";
  new InvocationStore(connection.db).revoke("invocation", "test exit");
  expect((await f.send()).status).toBe(409); expect(f.sends()).toBe(0);
});

test("runner directory is minimal, scoped, searchable, paginated and guarded independently from admin", async () => {
  const f = fixture();
  const directory = new ChannelDirectoryStore(connection.db);
  for (const [channel, id, name] of [["test", "ou_one", "Alice"], ["test", "ou_two", "Alice"], ["private", "ou_hidden", "Hidden"]]) {
    directory.upsertIdentity({ channel: { id: channel!, type: "feishu" }, identity: { externalId: id!, kind: "user", displayName: name!, providerIds: { open_id: id!, tenant_key: "private-metadata" }, rawProfile: { secret: true } } });
  }
  const response = await f.app.request("/api/runner/users?q=Alice&limit=1");
  expect(response.status).toBe(200);
  const page = await response.json() as { total: number; users: { id: string }[]; nextOffset: number };
  expect(page.total).toBe(2); expect(page.users).toHaveLength(1); expect(page.nextOffset).toBe(1);
  expect(JSON.stringify(page)).not.toContain("private-metadata"); expect(JSON.stringify(page)).not.toContain("rawProfile");
  expect((await f.app.request(`/api/runner/users/${page.users[0]!.id}`)).status).toBe(200);
  expect((await f.app.request("/api/runner/users?channelId=private")).status).toBe(403);
  expect((await f.app.request("/api/runner/users/lookup?channelId=private&idType=open_id&id=ou_hidden")).status).toBe(403);
  const lookup = await f.app.request("/api/runner/users/lookup?channelId=test&idType=open_id&id=ou_new");
  expect(lookup.status).toBe(200); expect(((await lookup.json()) as { user: { displayName: string } }).user.displayName).toBe("New Recipient");
  expect((await f.app.request("/api/runner/users?limit=999")).status).toBe(400);
  f.controller.abort(); expect((await f.app.request("/api/runner/users")).status).toBe(409);
});

test("runner bot search refreshes the current group once and returns only the observer's address", async () => {
  let lookups = 0;
  const f = fixture(true, "main", async groupId => {
    expect(groupId).toBe("chat");
    lookups++;
    return [{ kind: "bot", externalId: "ou_current", displayName: "Monkey King\u200c", providerIds: { open_id: "ou_current" } }];
  });
  new ChannelDirectoryStore(connection.db).upsertIdentity({
    channel: { id: "private", type: "feishu" },
    identity: { kind: "bot", externalId: "ou_other", displayName: "Monkey King", providerIds: { open_id: "ou_other" } },
  });
  const path = "/api/runner/users?q=Monkey+King";
  expect(await (await f.app.request(path + "&kind=user")).json()).toMatchObject({ total: 0 });
  expect((await f.app.request(path + "&kind=bot&channelId=private")).status).toBe(403);
  const response = await f.app.request(path);
  expect(response.status).toBe(200);
  const page = await response.json() as {users: {id: string}[]};
  expect(page).toMatchObject({ total: 1, users: [{ identities: [{ channelId: "test", providerIds: { open_id: "ou_current" } }] }] });
  expect(JSON.stringify(page)).not.toContain("ou_other");
  const detail = await f.app.request(`/api/runner/users/${page.users[0]!.id}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({user: page.users[0]});
  expect(await (await f.app.request(path + "&kind=bot")).json()).toEqual(page);
  expect(lookups).toBe(1);
});

test("native bot mentions use the current channel and allow explicit bot handoffs", async () => {
  const f = fixture(true, "main", async () => []);
  const db = connection.db;
  const bot = new ChannelDirectoryStore(db).upsertIdentity({
    channel: f.inbound.channel,
    identity: { kind: "bot", externalId: "ou_bot", displayName: "Peer bot", providerIds: { open_id: "ou_bot" } },
  });
  const botUserId = db.select().from(schema.channelUserBindings).where(eq(schema.channelUserBindings.channelIdentityId, bot.id)).get()!.userId;
  const nextBot = new ChannelDirectoryStore(db).upsertIdentity({
    channel: f.inbound.channel,
    identity: { kind: "bot", externalId: "ou_next", displayName: "Next bot", providerIds: { open_id: "ou_next" } },
  });
  const nextBotUserId = db.select().from(schema.channelUserBindings).where(eq(schema.channelUserBindings.channelIdentityId, nextBot.id)).get()!.userId;
  const mentions: (string | undefined)[] = [];
  const inlineMentions: (readonly string[] | undefined)[] = [];
  const { SessionCommandService } = await import("../../src/messaging/session-command-service");
  const commands = new SessionCommandService({ db, channelFor: () => ({ send: async (_inbound, operation) => {
    mentions.push(operation.mention?.requesterUserId);
    inlineMentions.push(operation.inlineMentions);
    return { ...operation, channelId: "test", id: "sent-bot-mention" };
  } }) });
  const actor = { userId: "user", sourceSessionId: f.session.id, originId: "human-turn" };
  commands.accept(actor, f.session.id, "message.send", "mention", { content: "Please review", mentionBotUserId: botUserId });
  await commands.waitForIdle();
  expect(mentions).toEqual(["ou_bot"]);
  const botActor = { ...actor, userId: botUserId, originId: "bot-turn" };
  commands.accept(botActor, f.session.id, "message.send", "handoff", {
    content: "Check the deployment plan", mentionBotUserId: nextBotUserId,
  });
  await commands.waitForIdle();
  commands.accept(botActor, f.session.id, "message.send", "answer", { content: "Done" });
  await commands.waitForIdle();
  expect(mentions).toEqual(["ou_bot", "ou_next", undefined]);
  commands.accept(actor, f.session.id, "message.send", "inline", { content: "Review", reply: {
    type: "luna.reply", version: 1, presentation: "message", content: [
      { type: "mention", userId: nextBotUserId }, { type: "text", text: " and " }, { type: "mention", userId: botUserId },
    ],
  } });
  await commands.waitForIdle();
  expect(inlineMentions.at(-1)).toEqual(["ou_next", "ou_bot"]);
});

test("the message CLI accepts JSON mentions for both human and bot Luna user IDs", async () => {
  const f = fixture(true, "main", async () => []);
  const db = connection.db;
  const directory = new ChannelDirectoryStore(db);
  const {runMessagesCli} = await import("@luna/cli/commands/messages");
  const server = Bun.serve({port: 0, fetch: request => f.app.fetch(request)});
  const commands = sessionCommandsFor(db, () => undefined);
  commands.start();
  try {
    const env = {LUNA_SERVICE_URL: server.url.origin, LUNA_ACCESS_TOKEN: "test"};
    for (const flag of ["--mention", "--mention-bot"]) {
      const result = await runMessagesCli(["send", flag, "user", "--text", "Check this"], env);
      expect(result.code).toBe("invalid_message_command");
    }
    expect(f.sends()).toBe(0);
    for (const kind of ["user", "bot"] as const) {
      const openId = "ou_mention_" + kind;
      const identity = directory.upsertIdentity({
        channel: f.inbound.channel,
        identity: {kind, externalId: openId, providerIds: {open_id: openId}},
      });
      const binding = db.select().from(schema.channelUserBindings)
        .where(eq(schema.channelUserBindings.channelIdentityId, identity.id)).get()!;
      const reply = JSON.stringify([{mention: binding.userId}, {text: " Check this"}]);
      const result = await runMessagesCli(["send", "--json", "--text", reply], env);
      expect(result.status).toBe("ok");
      const {commandId} = JSON.parse(result.output!);
      expect(db.select().from(schema.sessionCommands).where(eq(schema.sessionCommands.id, commandId)).get()?.payload.reply)
        .toMatchObject({content: [{type: "mention", userId: binding.userId}, {type: "text", text: " Check this"}]});
    }
  } finally {
    await commands.stop();
    server.stop(true);
  }
});

test("first-contact runner API accepts first-contact provider targets without authority", async () => {
  const f = fixture();
  const target = { kind: "feishu_user" as const, channelId: "test", idType: "open_id" as const, id: "ou_first" };

  const request = () => f.app.request("/api/runner/messages", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "first" }, body: JSON.stringify({ target, content: [{ type: "text", text: "hello" }] }) });
  expect((await request()).status).toBe(409);
  expect(connection.db.select().from(schema.directRecipients).all()).toHaveLength(0);
  expect((await f.app.request("/api/runner/users/lookup?channelId=test&idType=open_id&id=ou_first")).status).toBe(200);
  expect((await request()).status).toBe(202);
  const result = await request(); expect(result.status).toBe(202);
  expect(await result.json()).toMatchObject({ deliveryStatus: "pending" });
  expect(connection.db.select().from(schema.directRecipients).all()).toHaveLength(1);
  expect((await request()).status).toBe(202);
});

test("signed Runner HTTP calls use the invocation's bound Feishu application", async () => {
  const f = fixture(false);
  const db = connection.db;
  const {createDashboardAuthMiddleware, DashboardAuthService} = await import("../../src/server/auth");
  const {AccessTokenService} = await import("../../src/server/auth/access-token-service");
  const signingSecret = "runner-http-test-secret";
  const {token, claims} = new AccessTokenService({db, signingSecret}).issueToken({
    userId: "user", name: "Runner HTTP fixture", source: "runner", role: "runner", runnerKind: "main",
    sourceSessionId: f.session.id, sourceRunnerJobId: f.context.id, ttlMs: 60_000, now: Date.now(),
    metadata: {invocationId: "invocation"},
  });
  registerTestRunnerJob(db, "invocation", claims, encodeInvocation("main", mainInvocations(db).get("invocation")!), "logical-turn");
  const directory = new ChannelDirectoryStore(db);
  for (const [channelId, openId] of [["test", "ou_current"], ["private", "ou_other"]] as const) {
    const ids = {open_id: openId, user_id: "same-tenant-user"};
    directory.upsertIdentity({channel: {type: "feishu", id: channelId}, identity: {externalId: openId, kind: "user", providerIds: ids,
      ...feishuIdentityMetadata({environment: "feishu", appId: `test:feishu:${channelId}`, tenantKey: "tenant"}, ids)}});
  }
  const adapter = {send: async () => { throw Error("Provider must not be called in this HTTP test"); }};
  const app = new Hono().use("*", createDashboardAuthMiddleware(new DashboardAuthService(), {db}))
    .route("/api/runner", createRunnerUserRoutes({db, channelFor: () => adapter}))
    .route("/api/runner", createRunnerMessageRoutes({db, channelFor: () => adapter}));
  const server = Bun.serve({port: 0, fetch: app.fetch});
  const previous = process.env.LUNA_ACCESS_TOKEN_SECRET;
  process.env.LUNA_ACCESS_TOKEN_SECRET = signingSecret;
  const request = (path: string, target?: unknown) => fetch(new URL(path, server.url), {headers: {
    authorization: `Bearer ${token}`, ...(target ? {"content-type": "application/json", "idempotency-key": "http-delivery"} : {}),
  }, ...(target ? {method: "POST", body: JSON.stringify({target, content: [{type: "text", text: "Fixture"}]})} : {})});
  try {
    const response = await request("/api/runner/users");
    expect(response.status).toBe(200);
    const {users} = await response.json() as {users: {id: string; identities: {externalId: string}[]}[]};
    const recipient = users.find(user => user.identities.some(identity => identity.externalId === "ou_current"));
    expect(recipient?.identities).toHaveLength(1);
    expect((await request("/api/runner/users?channelId=private")).status).toBe(403);
    expect((await request("/api/runner/messages", {kind: "feishu_user", channelId: "private", idType: "open_id", id: "ou_other"})).status).toBe(403);
    expect((await request("/api/runner/messages", {kind: "feishu_user", channelId: "test", idType: "open_id", id: "ou_other"})).status).toBe(409);
    expect(db.select().from(schema.directRecipients).all()).toHaveLength(0);
    expect(db.select().from(schema.sessionCommands).all()).toHaveLength(0);
    expect((await request("/api/runner/messages", {kind: "user", userId: recipient!.id})).status).toBe(202);
    expect(db.select().from(schema.sessionCommands).get()?.payload.directAddress).toMatchObject({channelId: "test", idType: "open_id", recipientId: "ou_current"});
    db.update(schema.users).set({status:"blocked"}).where(eq(schema.users.id,"user")).run();
    expect((await request("/api/runner/users")).status).toBe(401);
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env.LUNA_ACCESS_TOKEN_SECRET;
    else process.env.LUNA_ACCESS_TOKEN_SECRET = previous;
  }
});

test("runner group directory imports provider groups, isolates channels and accepts creation without authority", async () => {
  const f = fixture();
  expect((await f.app.request("/api/runner/groups/lookup?channelId=private&chatId=oc_hidden")).status).toBe(403);
  const lookup = await f.app.request("/api/runner/groups/lookup?channelId=test&chatId=oc_project");
  expect(lookup.status).toBe(200);
  const body = await lookup.json() as { group: { id: string; sessionId: string; chatId: string } };
  expect(body.group.chatId).toBe("oc_project"); expect(body.group.sessionId).toBeTruthy();
  expect((await f.app.request(`/api/runner/groups/${body.group.id}`)).status).toBe(200);
  expect(await (await f.app.request("/api/runner/groups?q=Project&limit=1")).json()).toMatchObject({ total: 1 });
  const create = () => f.app.request("/api/runner/groups", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "new-group" }, body: JSON.stringify({ channelId: "test", name: "New Group", memberIds: ["ou_member"] }) });
  expect((await create()).status).toBe(202);
  expect((await create()).status).toBe(202);
  expect((await create()).status).toBe(202);
  const invite = () => f.app.request("/api/runner/groups/invite", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "invite-member" }, body: JSON.stringify({ channelId: "test", chatId: "oc_project", memberIds: ["ou_member"] }) });
  expect((await invite()).status).toBe(202);
  expect((await invite()).status).toBe(202);
  f.controller.abort(); expect((await f.app.request("/api/runner/groups")).status).toBe(409);
});

test("runner group search filters by a bot's locally recorded groups within the caller's channel", async () => {
  const f = fixture();
  const db = connection.db;
  const directory = new ChannelDirectoryStore(db);
  const store = new SessionStore(db);
  for (const [channelId, chatId] of [["test", "oc_shared"], ["test", "oc_caller_only"], ["private", "oc_shared"], ["private", "oc_bot_only"]] as const) {
    directory.upsertSurface({channel: {type: "feishu", id: channelId}, surface: {externalId: chatId, kind: "group"}});
    store.resolveByChannelSurface({channelType: "feishu", channelId, groupId: chatId});
  }
  const botUserId = store.resolveByChannelSurface({channelType: "feishu", channelId: "private", groupId: "oc_shared"}).bot_user_id!;
  const query = "/api/runner/groups?userId=" + encodeURIComponent(botUserId);
  const response = await f.app.request(query);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({total: 1, groups: [{channelId: "test", chatId: "oc_shared"}]});
  expect(await (await f.app.request(query + "&q=oc_caller_only")).json()).toMatchObject({total: 0});
  expect((await f.app.request(query + "&channelId=private")).status).toBe(403);
  expect(await (await f.app.request("/api/runner/groups?userId=unknown")).json()).toMatchObject({total: 0});
});

test("runner group search matches only visible groups with recorded messages from the requested user", async () => {
  const f = fixture();
  const db = connection.db;
  const directory = new ChannelDirectoryStore(db);
  const store = new SessionStore(db);
  const messageStore = new MessageStore(db);
  for (const [channelId, chatId, kind, hasMessage] of [
    ["test", "oc_visible", "group", true],
    ["test", "oc_empty", "group", false],
    ["test", "oc_direct", "p2p", true],
    ["private", "oc_hidden", "group", true],
  ] as const) {
    const channel = {type: "feishu", id: channelId};
    const surface = {externalId: chatId, kind};
    directory.upsertSurface({channel, surface});
    const session = store.resolveByChannelSurface({channelType: "feishu", channelId, groupId: chatId});
    if (hasMessage) messageStore.appendOnce({
      sessionId: session.id, channelMessageKey: chatId, senderUserId: "user", role: "user", channel, surface,
      content: [{type: "text", text: "Recorded message"}],
    });
  }
  const response = await f.app.request("/api/runner/groups?userId=user");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({total: 1, groups: [{channelId: "test", chatId: "oc_visible"}]});
  expect(await (await f.app.request("/api/runner/groups?userId=user&q=oc_empty")).json()).toMatchObject({total: 0});
});

test("private recipient resolution prefers root over its threads and preserves genuine ambiguity", async () => {
  const f = fixture();
  const db = connection.db;
  const store = new SessionStore(db);
  const { resolveMessageTarget } = await import("../../src/messaging/delivery-target");
  const directory = new ChannelDirectoryStore(db);
  const identity = directory.upsertIdentity({channel:{type:"feishu",id:"test"},identity:{externalId:"ou_recipient",kind:"user",providerIds:{open_id:"ou_recipient"},...feishuIdentityMetadata({environment:"feishu",appId:"test:feishu:test"},{open_id:"ou_recipient"})}});
  const canonical = db.select().from(schema.channelUserBindings).all().find(row=>row.channelIdentityId===identity.id)!.userId;
  directory.upsertSurface({channel:{type:"feishu",id:"test"},surface:{externalId:"oc_private",kind:"p2p"}});
  const root = store.resolveByChannelSurface({channelType:"feishu",channelId:"test",groupId:"oc_private"});
  const thread = store.resolveByChannelSurface({channelType:"feishu",channelId:"test",groupId:"oc_private",threadId:"thread",rootMessageId:"root"});
  for(const session of [root,thread]) new MessageStore(db).appendOnce({sessionId:session.id,channelMessageKey:session.id,role:"user",senderUserId:canonical,content:[{type:"text",text:"hello"}],channel:{type:"feishu",id:"test"}});
  expect(resolveMessageTarget(db,{kind:"user",userId:canonical,channelId:"test"})).toBe(root.id);
  expect(resolveMessageTarget(db,{kind:"feishu_user",channelId:"test",idType:"open_id",id:"ou_recipient"})).toBe(root.id);
  const response = await f.send("private reply","private",{kind:"user",userId:canonical,channelId:"test"});
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({sessionId:root.id});
  directory.upsertSurface({channel:{type:"feishu",id:"test"},surface:{externalId:"oc_other",kind:"p2p"}});
  const other=store.resolveByChannelSurface({channelType:"feishu",channelId:"test",groupId:"oc_other"});
  new MessageStore(db).appendOnce({sessionId:other.id,channelMessageKey:other.id,role:"user",senderUserId:canonical,content:[{type:"text",text:"hi"}],channel:{type:"feishu",id:"test"}});
  expect(()=>resolveMessageTarget(db,{kind:"user",userId:canonical,channelId:"test"})).toThrow("Specify an existing private session");
});

test("runner calendar schedules share timing, persist recurrence, advance and retry without duplication", async () => {
  const f = fixture();
  const { calendarOccurrence } = await import("@luna/service-client/schedule-timing");
  const recurrence = {kind: "custom" as const, frequency: "monthly" as const, every: 1, startDate: "2026-01-01", time: "09:00", days: [], monthDays: [15,1,1]};
  const body = {target: {kind:"current_session"}, timezone:"Asia/Singapore", recurrence, action:{kind:"session.invoke",content:"monthly analysis"}};
  const post = (value: unknown = body, key = "calendar") => f.app.request("/api/runner/schedules", {method:"POST",headers:{"content-type":"application/json","idempotency-key":key},body:JSON.stringify(value)});
  const before = Date.now();
  const response = await post();
  expect(response.status).toBe(201);
  const saved = await response.json() as typeof schema.sessionSchedules.$inferSelect;
  expect(saved.recurrence?.monthDays).toEqual([1,15]);
  expect(saved.nextAt).toBe(calendarOccurrence({...recurrence,monthDays:[1,15]},body.timezone,before));
  expect(saved.intervalMs).toBeNull();
  const service = sessionCommandsFor(connection.db,()=>undefined);
  service.materializeSchedules(saved.nextAt);
  service.materializeSchedules(saved.nextAt);
  const rows = connection.db.select().from(schema.sessionSchedules).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.nextAt).toBe(calendarOccurrence(saved.recurrence!,saved.timezone,saved.nextAt));
  expect(connection.db.select().from(schema.scheduleOccurrences).all()).toHaveLength(1);
  expect(connection.db.select().from(schema.sessionCommands).all()[0]?.kind).toBe("session.invoke");
  expect((await post()).status).toBe(200);
  expect((await post({...body, recurrence:{...recurrence,monthDays:[2]}})).status).toBe(409);
  for (const invalid of [
    {...body,intervalMs:60000}, {...body,timezone:"invalid/zone"},
    {...body,recurrence:{...recurrence,monthDays:[]}},
    {...body,recurrence:{...recurrence,frequency:"yearly",month:2,monthDays:[30]}},
    {...body,recurrence:{...recurrence,every:0}},
    {...body,recurrence:{...recurrence,startDate:"2026-02-30"}},
  ]) expect((await post(invalid,"invalid")).status).toBe(400);
  f.controller.abort();
  expect((await post(body,"expired")).status).toBe(409);
});

test("runner schedules retain legacy one-shot and interval forms with stable retries", async () => {
  const f = fixture();
  const post = (extra: object, key: string) => f.app.request("/api/runner/schedules",{method:"POST",headers:{"content-type":"application/json","idempotency-key":key},body:JSON.stringify({target:{kind:"current_session"},timezone:"UTC",action:{kind:"message.send",content:"reminder"},...extra})});
  expect((await post({nextAt:Date.now()+60000},"once")).status).toBe(201);
  const response = await post({intervalMs:1800000},"interval");
  expect(response.status).toBe(201);
  const row = await response.json() as {nextAt:number};
  expect(row.nextAt).toBeGreaterThan(Date.now()+1790000);
  const replay = await post({intervalMs:1800000},"interval");
  expect(replay.status).toBe(200);
  expect((await replay.json() as {nextAt:number}).nextAt).toBe(row.nextAt);
  expect((await post({nextAt:1},"past")).status).toBe(400);
  expect((await post({},"empty")).status).toBe(400);
  (f.claims as {runnerKind:string}).runnerKind="task";
  expect((await post({intervalMs:60000},"task")).status).toBe(403);
});

test("CLI calendar creation reaches Runner API and matches dashboard recurrence timing", async () => {
  const { fixtureScope } = await import("../helpers/platform-fixtures");
  const { runSchedulesCli } = await import("@luna/cli/commands/schedules");
  const { createSessionCommandAdminRoutes } = await import("../../src/server/routes/session-commands");
  const { decodeInvocation } = await import("../../src/runners/invocation-codec");
  const { InvocationResources } = await import("../../src/runners/invocation-resources");
  const { AgentResourceBuilder } = await import("../../src/runners/agent-resource-builder");
  const { PluginRegistry } = await import("../../src/plugins/registry");
  const { AccessTokenService } = await import("../../src/server/auth/access-token-service");
  home = mkdtempSync(join(tmpdir(), "luna-schedule-cli-"));
  setLunaHome(home);
  connection = new DataConnection(schema);
  const db = connection.db;
  // The Dashboard signs in as the account; the Runner acts as its owner user in the Agent.
  const accountId = "schedule-owner";
  const scope = fixtureScope(db, accountId);
  const userId = scope.ownerUserId;
  const session = new SessionStore(db).createLocalSession(userId, scope);
  const context = new RunnerContextStore(db).resolveForSession(session.id, "codex");
  const invocationId = "schedule-invocation";
  const invocations = new InvocationStore(db);
  invocations.register({ id: invocationId, actorUserId: userId, runnerKind: "work",
    runnerContextId: context.id, sessionId: session.id, taskId: null, taskRunId: null,
    originId: "schedule-turn", contextPackIds: [],
    inputSnapshot: decodeInvocation({ version: 1, kind: "work", input: {
      sessionId: session.id, runnerContextId: context.id, turnId: "schedule-turn",
    } }),
  });
  const { selection } = new InvocationResources(db, home).pin(invocationId, new AgentResourceBuilder(db, home, new PluginRegistry()));
  invocations.createJob("test-runtime", {
    version: 2, jobId: "schedule-job", invocationId, environmentId: "luna",
    runnerContextId: context.id, scopeKey: `session:${context.id}`, runnerKind: "work", sessionId: session.id,
    scope: { agentId: scope.agentId, shadowId: scope.shadowId, placementGeneration: 1 }, resources: selection, resourceRevision: selection.digest,
    input: { runnerType: "codex", prompt: "Schedule test" }, credentialsRevision: 1, timeoutMs: 60_000,
  });
  const { claims } = new AccessTokenService({ db, signingSecret: "schedule-test" }).issueToken({
    userId, name: "Schedule fixture", source: "runner", role: "runner", runnerKind: "work",
    sourceSessionId: session.id, sourceRunnerJobId: context.id, ttlMs: 60_000, now: Date.now(),
    metadata: { invocationId },
  });
  const app = new Hono().use("*", async (c, next) => {
    c.set("lunaAccessTokenClaims" as never, claims as never);
    c.set("dashboardAuthSession" as never, { authenticated: true, account: { id: accountId, name: "Test", provider: "local" } } as never);
    c.set("lunaRequestAuthKind" as never, "dashboard-cookie" as never);
    await next();
  }).route("/api/runner", createRunnerMessageRoutes({ db, channelFor: () => undefined }))
    .route("/", createSessionCommandAdminRoutes({ db }));
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const result = await runSchedulesCli(["create","--repeat","monthly","--month-days","1,15","--time","09:00","--start-date","2026-01-01","--timezone","Asia/Singapore","--text","shared calendar","--invoke","--request-id","cli-e2e"],{LUNA_SERVICE_URL:`http://127.0.0.1:${server.port}`,LUNA_ACCESS_TOKEN:"test"});
    expect(result.status).toBe("ok");
    const runner = JSON.parse(result.output!) as typeof schema.sessionSchedules.$inferSelect;
    const response = await app.request(`/schedule-editor?agentId=${scope.agentId}&shadowId=${scope.shadowId}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"dashboard parity",targetSessionId:runner.targetSessionId,action:{kind:"session.invoke",content:"shared calendar"},timezone:runner.timezone,intervalMs:null,recurrence:runner.recurrence})});
    expect(response.status).toBe(201);
    const dashboard = await response.json() as typeof schema.sessionSchedules.$inferSelect;
    expect(dashboard.nextAt).toBe(runner.nextAt);
    expect(dashboard.recurrence).toEqual(runner.recurrence);
  } finally { server.stop(true); }
});


test("Work commands deliver during invocation, deduplicate, and expire with the invocation", async () => {
  const f = fixture(true, "work");
  (f.claims as { runnerKind: string }).runnerKind = "main";
  expect((await f.send()).status).toBe(409);
  (f.claims as { runnerKind: string }).runnerKind = "work";
  const { runMessagesCli } = await import("@luna/cli/commands/messages");
  const service = sessionCommandsFor(connection.db, () => undefined);
  const server = Bun.serve({ port: 0, fetch: req => f.app.fetch(req) });
  service.start();
  try {
    const args = ["send", "--text", "Work answer before exit", "--purpose", "answer", "--request-id", "work-answer"];
    const env = { LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test" };
    const result = await runMessagesCli(args, env);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    expect(JSON.parse(result.output!)).toMatchObject({ deliveryStatus: "sent", providerMessageId: "out-1" });
    expect(f.sends()).toBe(1);
    expect((await runMessagesCli(args, env)).status).toBe("ok");
    expect(f.sends()).toBe(1);
    f.controller.abort();
    expect((await f.send("late", "late")).status).toBe(409);
    expect((await f.send()).status).toBe(409);
  } finally { await service.stop(); server.stop(true); }
});

test("Main consumes command answer before terminal sentinel and keeps replay deduplicated", async () => {
  const f = fixture(false);
  const { MainRunner } = await import("../../src/main-runner/main-runner");
  const { RunnerMessageService } = await import("../../src/messaging/runner-message-service");
  const { AccessTokenService } = await import("../../src/server/auth/access-token-service");
  const auth = new AccessTokenService({ db: connection.db, signingSecret: "main-command-test-secret" });
  let liveClaims: LunaAccessTokenClaims | undefined;
  const main = new MainRunner({
    serviceAuthDb: connection.db, accessTokenSigningSecret: "main-command-test-secret",
    runner: { type: "fake", async *stream(message, options) {
      const finish = startTestRunnerJob(connection.db, options.env!.LUNA_INVOCATION_ID!);
      liveClaims = auth.verifyBearer(options.env!.LUNA_ACCESS_TOKEN!, { now: Date.now() })!.claims;
      const command = await new RunnerMessageService(connection.db, () => undefined)
        .send(liveClaims, "answer-1", "Delivered during execution", "answer");
      await sessionCommandsFor(connection.db, () => undefined).waitForIdle();
      expect(command.originId).toBe("logical-turn");
      expect(f.sends()).toBe(1);
      finish();
      yield { id: "final", session_id: message.session_id, role: "assistant", content: [{type: "text", text: "LUNA_NOTHING_TO_SEND"}] };
    } },
  });
  const input = mainInvocations(connection.db).get("invocation")!;
  // Explicit requester uses the canonical user on this local test channel.
  const runInput = { ...input, input: { ...input.input, requesterUserId: "user" } };
  expect(await main.run(runInput)).toMatchObject({ status: "completed", followupReleased: false });
  expect(await main.run(runInput)).toMatchObject({ status: "completed", followupReleased: false });
  expect(f.sends()).toBe(1);
  expect(() => new RunnerMessageService(connection.db, () => undefined).actor(liveClaims)).toThrow("No active Job");
});


test("message CLI reads stdin and waits for the delivery receipt", async () => {
  const f = fixture();
  const service = sessionCommandsFor(connection.db, () => undefined);
  const server = Bun.serve({port: 0, fetch: req => f.app.fetch(req)});
  service.start();
  const modulePath = import.meta.resolve("@luna/cli/commands/messages");
  const script = `import {runMessagesCli} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await runMessagesCli(["send","--stdin","--purpose","answer","--request-id","stdin-answer"],process.env)));`;
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: {...process.env, LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test"},
      stdin: new Blob(["First line\n第二行\n"]), stdout: "pipe", stderr: "pipe",
    });
    const result = JSON.parse(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.output)).toMatchObject({deliveryStatus: "sent"});
    expect(connection.db.select().from(schema.sessionCommands).all()[0]?.payload.content).toBe("First line\n第二行\n");
    expect(f.sends()).toBe(1);
  } finally { await service.stop(); server.stop(true); }
});


test("task command creates and dispatches before Main exits, returns receipt and rejects conflicts", async () => {
  const f = fixture();
  const { RunnerOperationService } = await import("../../src/runners/operation-service");
  const { createRunnerOperationRoutes } = await import("../../src/server/routes/runner-operations");
  const { runRunnerOperationsCli } = await import("@luna/cli/commands/runner-operations");
  const { TaskRunStore } = await import("../../src/tasks/task-run-store");
  const { SessionStateStore } = await import("../../src/main-runner/session-state-store");
  const active = mainInvocations(connection.db).get("invocation")!;
  mainInvocations(connection.db).set("invocation", {...active, input: {...active.input,
    latestMessage: {...f.inbound, sender: {...f.inbound.sender, requesterIdentity: {provider: "local", externalUserId: "user", canonicalUserId: "user"}}}}} as never);
  let dispatches = 0;
  const { TaskRunSupervisor } = await import("../../src/tasks/task-run-supervisor");
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const supervisor = new TaskRunSupervisor({db: connection.db, runnerType: "mock", executeRun: async () => {
    dispatches++;
    await gate;
    return {finalReportArtifactId: "test-report"};
  }});
  const service = new RunnerOperationService(connection.db, supervisor);
  f.app.route("/api/runner", createRunnerOperationRoutes(service));
  const server = Bun.serve({port: 0, fetch: req => f.app.fetch(req)});
  const env = {LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test"};
  const body = {title: "Command task", summary: "Investigate issue", facts: ["Known fact"]};
  const call = (value = body) => runRunnerOperationsCli("task", ["create", "--json", JSON.stringify(value), "--request-id", "create-1"], env);
  try {
    const first = await call();
    expect(first.status).toBe("ok");
    const receipt = JSON.parse(first.output!);
    expect(receipt.status).toBe("applied");
    expect(receipt.taskIds).toHaveLength(1);
    expect(connection.db.select().from(schema.tasks).all()).toHaveLength(1);
    expect(dispatches).toBe(1);
    expect(mainInvocations(connection.db).has("invocation")).toBe(true);
    const replay = await call();
    expect(replay).toMatchObject({status: "ok"});
    expect(JSON.parse(replay.output!)).toEqual(receipt);
    expect(dispatches).toBe(1);
    expect((await call({...body, title: "Conflict"})).status).toBe("error");
    const status = await runRunnerOperationsCli("task", ["status", receipt.commandId], env);
    expect(JSON.parse(status.output!)).toEqual(receipt);
    const attachArgs = ["update", "--json", JSON.stringify({taskId: receipt.taskIds[0], updateSummary: "Additional evidence"}), "--request-id", "attach-1"];
    const attached = await runRunnerOperationsCli("task", attachArgs, env);
    expect(attached).toMatchObject({status: "ok"});
    expect(JSON.parse(attached.output!).taskIds).toEqual(receipt.taskIds);
    expect((await runRunnerOperationsCli("task", attachArgs, env)).status).toBe("ok");
    expect(new TaskRunStore(connection.db).listRunsForTask(receipt.taskIds[0])).toHaveLength(2);
    const taskBeforeRestart = connection.db.select().from(schema.tasks).all()[0]!;
    const restart = await runRunnerOperationsCli("task", ["restart", "--json", JSON.stringify({taskId: receipt.taskIds[0]}), "--request-id", "retry-1"], env);
    expect(restart.status).toBe("ok");
    const taskAfterRestart = connection.db.select().from(schema.tasks).all()[0]!;
    expect(taskAfterRestart.summary).toBe(taskBeforeRestart.summary);
    expect(taskAfterRestart.context_json).toEqual(taskBeforeRestart.context_json);
    expect(new TaskRunStore(connection.db).listRunsForTask(receipt.taskIds[0])).toHaveLength(3);
    expect((await runRunnerOperationsCli("task", ["restart", "--json", JSON.stringify({taskId: receipt.taskIds[0], updatedTaskSummary: "not allowed"}), "--request-id", "bad-retry"], env)).status).toBe("error");
    expect((await f.app.request("/api/runner/tasks/attach", {method: "POST"})).status).toBe(404);
    const clarification = await runRunnerOperationsCli("session", ["clarify", "--request-id", "clarify-1", "--json", JSON.stringify({pendingIntent: "question", missingFields: ["time"], collectedFacts: ["fact"], question: "When?", reason: "Missing time"})], env);
    expect(clarification.status).toBe("ok");
    expect(new SessionStateStore(connection.db).getClarification(f.session.id)?.missingFields).toEqual(["time"]);
    expect((await f.app.request("/api/runner/actions", {method: "POST"})).status).toBe(404);
    const obsolete = await runRunnerOperationsCli("task", ["create", "--request-id", "obsolete", "--json", JSON.stringify({...body, action: "create_task_and_dispatch"})], env);
    expect(obsolete.status).toBe("error");
    const second = await runRunnerOperationsCli("task", ["create", "--request-id", "create-2", "--json", JSON.stringify(body)], env);
    expect(second.status).toBe("ok");
    expect(JSON.parse(second.output!).taskIds[0]).not.toBe(receipt.taskIds[0]);
    expect(connection.db.select().from(schema.tasks).all()).toHaveLength(2);
    // Simulate a crash after dispatch but before recording the operation receipt.
    const { eq } = await import("drizzle-orm");
    connection.db.update(schema.runnerOperations).set({status: "prepared"}).where(eq(schema.runnerOperations.id, receipt.commandId)).run();
    expect(await new RunnerOperationService(connection.db, supervisor).recoverPending()).toBe(1);
    expect(new TaskRunStore(connection.db).listRunsForTask(receipt.taskIds[0])).toHaveLength(3);

    (f.claims as {runnerKind: string}).runnerKind = "task";
    expect((await call()).status).toBe("error");
    (f.claims as {runnerKind: string}).runnerKind = "work";
    expect((await call()).status).toBe("error");
    (f.claims as {runnerKind: string}).runnerKind = "main";
    f.controller.abort();
    expect((await call()).status).toBe("error");
  } finally {release(); await supervisor.waitForIdle(); server.stop(true);}
});


test("Main displays ordinary JSON as content and deduplicates later terminal output", async () => {
  const f = fixture(false);
  const { MainRunner } = await import("../../src/main-runner/main-runner");
  let output = JSON.stringify({action: "create_task_and_dispatch", taskType: "task", title: "Never create", summary: "Terminal payload", facts: ["fact"], dispatchReply: "starting", reason: "test"});
  const main = new MainRunner({serviceAuthDb: connection.db, accessTokenSigningSecret: "test-secret",
    runner: {type: "fake", async *stream(message) {
      yield {id: "final", session_id: message.session_id, role: "assistant", content: [{type: "text", text: output}]};
    }}});
  const active = mainInvocations(connection.db).get("invocation")!;
  const input = {...active, input: {...active.input, requesterUserId: "user"}};
  expect(await main.run(input)).toMatchObject({status: "completed"});
  expect(connection.db.select().from(schema.sessionCommands).all()[0]?.payload.content).toBe(output);
  expect(connection.db.select().from(schema.tasks).all()).toHaveLength(0);
  output = "LUNA_NOTHING_TO_SEND";
  expect(await main.run(input)).toMatchObject({status: "completed", followupReleased: false});
  expect(f.sends()).toBe(0);
});

test("domain operation recovers a dispatch failure without duplicating prepared task facts", async () => {
  const f = fixture();
  const { RunnerOperationService, OperationExecutionError } = await import("../../src/runners/operation-service");
  const { TaskRunSupervisor } = await import("../../src/tasks/task-run-supervisor");
  const { TaskRunStore } = await import("../../src/tasks/task-run-store");
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const real = new TaskRunSupervisor({db: connection.db, runnerType: "mock", executeRun: async () => {await gate; return {finalReportArtifactId: "test-report"};}});
  let fail = true;
  const service = new RunnerOperationService(connection.db, {
    startInitialRun(input) {if (fail) throw Error("simulated dispatch outage"); return real.startInitialRun(input);},
    restartTaskRun: input => real.restartTaskRun(input),
    cancelTaskRun: input => real.cancelTaskRun(input),
  });
  try {
    let receipt: any;
    try {await service.execute(f.claims, "task.create", "recover-1", {title: "Recovery", summary: "test", facts: []});}
    catch (error) {expect(error).toBeInstanceOf(OperationExecutionError); if (!(error instanceof OperationExecutionError)) throw error; receipt = error.receipt;}
    expect(receipt.status).toBe("prepared");
    expect(receipt.error).toContain("dispatch outage");
    expect(connection.db.select().from(schema.tasks).all()).toHaveLength(1);
    fail = false;
    expect(await service.recoverPending()).toBe(1);
    expect(service.get(f.claims, receipt.commandId)).toMatchObject({status: "applied", taskIds: receipt.taskIds});
    expect(new TaskRunStore(connection.db).listRunsForTask(receipt.taskIds[0])).toHaveLength(1);
    await service.execute(f.claims, "task.create", "recover-1", {title: "Recovery", summary: "test", facts: []});
    expect(connection.db.select().from(schema.tasks).all()).toHaveLength(1);
    expect(new TaskRunStore(connection.db).listRunsForTask(receipt.taskIds[0])).toHaveLength(1);
  } finally {release(); await real.waitForIdle();}
});

test("Main completion reads focus release from the domain ledger without a legacy decision", async () => {
  fixture(false);
  const { RunnerOperationService } = await import("../../src/runners/operation-service");
  const { AccessTokenService } = await import("../../src/server/auth/access-token-service");
  const { MainRunner } = await import("../../src/main-runner/main-runner");
  const auth = new AccessTokenService({db: connection.db, signingSecret: "focus-test"});
  const service = new RunnerOperationService(connection.db, {startInitialRun() {throw Error("unexpected task");}, restartTaskRun() {throw Error("unexpected task");}, cancelTaskRun() {throw Error("unexpected task");}});
  const main = new MainRunner({serviceAuthDb: connection.db, accessTokenSigningSecret: "focus-test", runner: {type: "fake", async *stream(message, options) {
    const finish = startTestRunnerJob(connection.db, options.env!.LUNA_INVOCATION_ID!);
    const claims = auth.verifyBearer(options.env!.LUNA_ACCESS_TOKEN!, {now: Date.now()})!.claims;
    await service.execute(claims, "session.release", "release-1", {reason: "Addressed to somebody else"});
    finish();
    yield {id: "final", session_id: message.session_id, role: "assistant", content: [{type: "text", text: "已结束跟进。"}]};
  }}});
  const active = mainInvocations(connection.db).get("invocation")!;
  if (active.input.type !== "user_messages") throw Error("Expected user invocation");
  expect(await main.run({...active, input: {...active.input, requesterUserId: "user"}})).toMatchObject({status: "completed", followupReleased: true});
});


test("task command source selection preserves the selected message rather than the latest batch message", async () => {
  const f = fixture();
  const { RunnerOperationService } = await import("../../src/runners/operation-service");
  const later = {...f.inbound, id: "later-message", text: "Unrelated task B"};
  const row = new MessageStore(connection.db).appendOnce({sessionId: f.session.id, channelMessageKey: later.id,
    role: "user", senderUserId: "user", content: [{type: "text", text: later.text}], inbound: later,
    channel: later.channel, surface: later.surface, sender: later.sender}).row;
  const active = mainInvocations(connection.db).get("invocation")!;
  if (active.input.type !== "user_messages") throw Error("Expected user input");
  mainInvocations(connection.db).set("invocation", {...active, input: {...active.input, latestMessage: later,
    messages: [...active.input.messages, {...runnerMessageEnvelopeFromRow({row, rawMessage: later}), rawMessage: later}]}});
  connection.db.update(schema.runnerInvocations)
    .set({ inputSnapshot: encodeInvocation("main", mainInvocations(connection.db).get("invocation")!) })
    .where(eq(schema.runnerInvocations.id, "invocation")).run();
  const service = new RunnerOperationService(connection.db, {startInitialRun() {return {id: "run-test"} as never;}, restartTaskRun() {throw Error("Unexpected restart");}, cancelTaskRun() {throw Error("Unexpected cancel");}});
  await service.execute(f.claims, "task.create", "selected", {title: "Task A", summary: "Selected A", facts: [], sourceMessageIds: [f.row.id]});
  const task = connection.db.select().from(schema.tasks).get()!;
  expect(task.source_message_id).toBe(f.row.id);
  expect(task.context_json).toMatchObject({latestUserMessage: "hello"});
  await expect(service.execute(f.claims, "task.create", "foreign", {title: "Foreign", summary: "denied", facts: [], sourceMessageIds: ["another-session-message"]})).rejects.toThrow("current invocation");
  expect(connection.db.select().from(schema.tasks).all()).toHaveLength(1);
});

test("group CLI supplements creation context without changing handoff", async () => {
  const f = fixture();
  const {runGroupsCli} = await import("@luna/cli/commands/groups");
  const row = connection.db.select().from(schema.messages).where(eq(schema.messages.ownerSessionId, f.session.id)).get()!;
  const server = Bun.serve({port: 0, fetch: req => f.app.fetch(req)});
  const env = {LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test"};
  try {
    const args = ["create", "--channel-id", "test", "--name", "Context group", "--member", "ou_member", "--request-id", "context-cli", "--context-message", row.id, "--context-message", row.id];
    const result = await runGroupsCli(args, env);
    expect(result.status).toBe("ok");
    const command = sessionCommandsFor(connection.db, () => undefined).get(JSON.parse(result.output!).commandId)!;
    expect(command.payload.contextMessageIds).toEqual([row.id]);
    expect(command.payload.launchMessageIds).toEqual([row.id]);
    expect(command.payload.launchAnchorMessageId).toBe(row.id);
    expect(command.payload.group).not.toHaveProperty("contextMessageIds");
    const json = await runGroupsCli(["create", "--json", JSON.stringify({
      name: "JSON group", memberIds: ["ou_two", "ou_member"], contextMessageIds: [row.id],
    })], env);
    expect(json.status).toBe("ok");
    const jsonCommand = sessionCommandsFor(connection.db, () => undefined).get(JSON.parse(json.output!).commandId)!;
    expect(jsonCommand.payload).toMatchObject({
      group: { channelId: "test", idType: "open_id", memberIds: ["ou_member", "ou_two"] },
      contextMessageIds: [row.id], launchAnchorMessageId: row.id,
    });
    expect((await runGroupsCli([...args, "--context-message"], env)).status).toBe("error");
    expect(f.sends()).toBe(0);
  } finally {server.stop(true);}
});

test("invite JSON defaults to the current Feishu group and rejects another channel", async () => {
  const f = fixture(true, "main", async () => []);
  const server = Bun.serve({ port: 0, fetch: req => f.app.fetch(req) });
  try {
    const { runGroupsCli } = await import("@luna/cli/commands/groups");
    const env = { LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test" };
    const invite = { memberIds: ["ou_one", "ou_two"] };
    const result = await runGroupsCli(["invite", "--json", JSON.stringify(invite)], env);
    expect(result.status).toBe("ok");
    const command = sessionCommandsFor(connection.db, () => undefined).get(JSON.parse(result.output!).commandId)!;
    expect(command.payload.invitation).toEqual({ ...invite, channelId: "test", chatId: "chat", idType: "open_id" });
    const wrongChannel = await runGroupsCli(["invite", "--json", JSON.stringify({ ...invite, channelId: "private" })], env);
    expect(wrongChannel.status).toBe("error");
    expect(wrongChannel.code).toBe("http_403");
    expect(JSON.parse(wrongChannel.output!)).toMatchObject({ error: "channel_forbidden" });
  } finally { server.stop(true); }
});
