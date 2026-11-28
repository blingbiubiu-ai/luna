import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { config, setLunaHome } from "../../src/shared";
import { PlatformSettingsStore } from "../../src/platform/platform-settings-store";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionCommandService } from "../../src/messaging/session-command-service";
import { SessionReplyDispatcher } from "../../src/messaging/session-reply-dispatcher";
import { ProviderDeliveryRejected } from "../../src/messaging/provider-delivery-error";
import { sessionDispatcherFor } from "../../src/sessions/session-dispatcher";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { SessionTurnStore } from "../../src/sessions/session-turn-store";
import { AgentStore } from "../../src/agents/agent-store";
import { BotBindingStore } from "../../src/agents/bot-binding-store";
import { resolveMessageTarget } from "../../src/messaging/delivery-target";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { feishuIdentityMetadata } from "../../src/identity/feishu-identity-scopes";
import type { ReplyChannel } from "../../src/channels/outbound";
let home: string, connection: DataConnection<typeof schema>, source: string, target: string;
const actor = () => ({ userId: "u", sourceSessionId: source, originId: "turn" });
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "luna-commands-"));
    setLunaHome(home);
    connection = new DataConnection(schema);
    const scope = fixtureSessionOwnership(connection.db, "feishu", "test");
    connection.db.insert(schema.users).values({ id: "u", agentId: scope.agent_id, kind: "human", displayName: "User", status: "active", createdAt: "now", updatedAt: "now" }).run();
    const store = new SessionStore(connection.db);
    source = store.resolveByChannelSurface({ channelType: "feishu", channelId: "test", groupId: "source" }).id;
    target = store.resolveByChannelSurface({ channelType: "feishu", channelId: "test", groupId: "target" }).id;
});
afterEach(() => { connection.close(); rmSync(home, { recursive: true, force: true }); });
function runtime(executeTrigger?: ConstructorParameters<typeof SessionCommandService>[0]["executeTrigger"]) {
    const sent: string[] = [];
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({ send: async (_input, op) => { sent.push(op.content); return { ...op, id: `out-${sent.length}`, channelId: "test" }; } }), ...(executeTrigger ? { executeTrigger } : {}) });
    return { service, sent };
}

function observeRecipient(channelId: string, ids: {open_id: string; user_id?: string; union_id?: string}, scope: {tenantKey?: string; developerId?: string} = {}) {
    const appId = `test:feishu:${channelId}`;
    const identity = {externalId: ids.open_id, kind: "user" as const, providerIds: ids,
        ...feishuIdentityMetadata({environment: "feishu", appId, ...scope}, ids)};
    const stored = new ChannelDirectoryStore(connection.db).upsertIdentity({channel: {type: "feishu", id: channelId}, identity});
    const userId = connection.db.select().from(schema.channelUserBindings).where(eq(schema.channelUserBindings.channelIdentityId, stored.id)).get()!.userId;
    return {identity, userId};
}

function processingTurn() {
    const messages = new MessageStore(connection.db);
    const inbox = new SessionInboxStore(connection.db);
    const append = (key: string) => {
        const message = messages.append({ sessionId: source, channelMessageKey: key, role: "user", senderUserId: "u", content: [{ type: "text", text: key }] });
        return inbox.enqueueOnce({ sessionId: source, message }).row;
    };
    const first = append("input-1"), second = append("input-2");
    const turns = new SessionTurnStore(connection.db);
    turns.createExecutionTurn({ id: "turn", sessionId: source, triggerEntryId: first.entry_id, reason: "test" });
    turns.attachEntries("turn", [{ entryId: second.entry_id, role: "coalesced_input" }]);
    inbox.claimBatch({ turnId: "turn", inboxIds: [first.id, second.id] });
    const pending = append("later-input");
    // Visible context is not an input answered by this turn.
    turns.attachEntries("turn", [{ entryId: pending.entry_id, role: "context" }]);
    return { turns, inbox, pending };
}

test("delivered answer clears only its turn inputs while execution and later input stay pending", async () => {
    const { turns, inbox, pending } = processingTurn();
    const cleared: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let sends = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({
        send: async () => { throw new Error("CLI should use sendTo"); },
        sendTo: async (_target, op) => { sends++; await gate; return { ...op, id: "reply", channelId: "test" }; },
        completeProcessing: async inbound => { cleared.push(inbound.id); },
    }) });
    const cmd = service.accept(actor(), source, "message.send", "reply", { content: "done", purpose: "answer" });
    await service.tick();
    expect(cleared).toEqual([]);
    release();
    await service.waitForIdle();
    expect(cleared.sort()).toEqual(["input-1", "input-2"]);
    expect(service.get(cmd.id)?.status).toBe("sent");
    expect(turns.getById("turn")?.status).toBe("running");
    expect(inbox.listPendingForSession(source).map(row => row.id)).toEqual([pending.id]);
    await service.waitForIdle();
    expect(sends).toBe(1);
});

test.each(["progress", "notification", "cross-session", "failed", "unknown"])("%s delivery does not clear the turn's processing markers", async kind => {
    processingTurn();
    const cleared: string[] = [];
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({
        send: async (_input, op) => {
            if (kind === "failed") throw new ProviderDeliveryRejected("rejected");
            if (kind === "unknown") throw new Error("receipt lost");
            return { ...op, id: "reply", channelId: "test" };
        },
        completeProcessing: async inbound => { cleared.push(inbound.id); },
    }) });
    const cmd = service.accept(actor(), kind === "cross-session" ? target : source, "message.send", "reply", { content: "update", purpose: kind === "progress" || kind === "notification" ? kind : "answer" });
    await service.waitForIdle();
    expect(cleared).toEqual([]);
    expect(service.get(cmd.id)?.status).toBe(kind === "failed" || kind === "unknown" ? kind : "sent");
});

test("processing marker failure preserves sent receipt and never resends the answer", async () => {
    processingTurn();
    let sends = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({
        send: async (_input, op) => { sends++; return { ...op, id: "reply", channelId: "test" }; },
        completeProcessing: async () => { throw new Error("marker API unavailable"); },
    }) });
    const cmd = service.accept(actor(), source, "message.send", "reply", { content: "done", purpose: "answer" });
    await service.waitForIdle();
    await service.waitForIdle();
    expect(service.get(cmd.id)).toMatchObject({ status: "sent", providerMessageId: "reply" });
    expect(sends).toBe(1);
});
test("accept is durable and atomic, replay does not resend and cross-session send does not invoke Main", async () => {
    let calls = 0;
    const { service, sent } = runtime(async () => { calls++; });
    const cmd = service.accept(actor(), target, "message.send", "one", { content: "hello" });
    expect(cmd.status).toBe("pending");
    expect(sent).toEqual([]);
    expect(cmd.messageId).toBeTruthy();
    expect(service.accept(actor(), target, "message.send", "one", { content: "hello" }).id).toBe(cmd.id);
    expect(() => service.accept(actor(), target, "message.send", "one", { content: "changed" })).toThrow("different payload");
    await service.waitForIdle();
    expect(sent).toEqual(["hello"]);
    expect(calls).toBe(0);
    expect(service.get(cmd.id)?.status).toBe("sent");
    expect(connection.db.select().from(schema.messages).where(eq(schema.messages.id, cmd.messageId!)).get()?.rawPayloadJson).toMatchObject({ deliveryStatus: "sent" });
});
test("inactive actors fail before provider delivery", async () => {
    const { service, sent } = runtime();
    const cmd = service.accept(actor(), target, "message.send", "one", { content: "hello" });
    connection.db.update(schema.users).set({ status: "blocked" }).where(eq(schema.users.id, "u")).run();
    await service.waitForIdle();
    expect(service.get(cmd.id)?.status).toBe("failed");
    expect(sent).toEqual([]);
    expect(() => service.accept(actor(), target, "message.send", "two", { content: "hello" })).toThrow("active_user_required");
});
test("handoff shares session lane and delivery continues while Main is waiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    const events: string[] = [];
    const lane = sessionDispatcherFor(connection.db).dispatch({ kind: "user_messages", sessionId: target }, async () => { events.push("user"); await gate; });
    const { service, sent } = runtime(async () => { events.push("trigger"); });
    const trigger = service.accept(actor(), target, "session.invoke", "handoff", { content: "continue" });
    service.accept(actor(), target, "message.send", "progress", { content: "progress" });
    await service.tick();
    await new Promise(r => setTimeout(r, 10));
    expect(sent).toEqual(["progress"]);
    expect(events).toEqual(["user"]);
    release();
    await lane;
    await service.waitForIdle();
    expect(events).toEqual(["user", "trigger"]);
    expect(service.get(trigger.id)?.status).toBe("completed");
});
test("pending delivery survives restart; ambiguous running delivery is not replayed", async () => {
    const first = runtime();
    const pending = first.service.accept(actor(), target, "message.send", "pending", { content: "pending" });
    const ambiguous = first.service.accept(actor(), target, "message.send", "ambiguous", { content: "ambiguous" });
    connection.db.update(schema.sessionCommands).set({ status: "running", claim: "old" }).where(eq(schema.sessionCommands.id, ambiguous.id)).run();
    const second = runtime();
    second.service.start();
    await second.service.waitForIdle();
    await second.service.stop();
    expect(second.sent).toEqual(["pending"]);
    expect(second.service.get(pending.id)?.status).toBe("sent");
    expect(second.service.get(ambiguous.id)?.status).toBe("unknown");
    expect(connection.db.select().from(schema.messages).where(eq(schema.messages.id, ambiguous.messageId!)).get()?.rawPayloadJson).toMatchObject({ deliveryStatus: "unknown" });
});
test("provider timeout is unknown, never automatically retried", async () => {
    let calls = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({ send: async () => { calls++; throw new Error("response lost"); } }) });
    const cmd = service.accept(actor(), target, "message.send", "one", { content: "hello" });
    await service.waitForIdle();
    await service.tick();
    expect(service.get(cmd.id)?.status).toBe("unknown");
    expect(calls).toBe(1);
});
test("schedule occurrence is deduplicated, fixed reminders bypass Main, missed intervals coalesce", async () => {
    let calls = 0;
    const { service, sent } = runtime(async () => { calls++; });
    const now = Date.now();
    connection.db.insert(schema.sessionSchedules).values({ id: "schedule", actorUserId: "u", sourceSessionId: source, targetSessionId: target, action: { kind: "message.send", content: "reminder" }, timezone: "Asia/Singapore", nextAt: now - 180000, intervalMs: 60000, enabled: true, revision: 1, overlap: "skip", misfire: "latest", expiresAfterMs: 86400000, createdAt: now }).run();
    service.materializeSchedules(now);
    service.materializeSchedules(now);
    await service.waitForIdle();
    expect(sent).toEqual(["reminder"]);
    expect(calls).toBe(0);
    const occurrences = connection.db.select().from(schema.scheduleOccurrences).all();
    expect(occurrences).toHaveLength(2);
    expect(occurrences.filter(o => o.status === "skipped")).toHaveLength(1);
});
test("scheduled analysis invokes Main and hop budget cannot be reset", async () => {
    let calls = 0;
    const { service } = runtime(async () => { calls++; });
    const now = Date.now();
    connection.db.insert(schema.sessionSchedules).values({ id: "schedule", actorUserId: "u", sourceSessionId: source, targetSessionId: target, action: { kind: "session.invoke", content: "analyze" }, timezone: "UTC", nextAt: now, intervalMs: null, enabled: true, revision: 1, overlap: "skip", misfire: "latest", expiresAfterMs: 10000, createdAt: now }).run();
    await service.waitForIdle();
    expect(calls).toBe(1);
    expect(connection.db.select().from(schema.sessionSchedules).get()?.enabled).toBe(false);
    expect(() => service.accept({ ...actor(), hops: 0 }, target, "session.invoke", "loop", { content: "loop" })).toThrow("hop limit");
});
test("command trigger and user adapters share the durable trigger ledger", async () => {
    const { service } = runtime(async () => { });
    const command = service.accept(actor(), target, "session.invoke", "ledger", { content: "continue" });
    expect(connection.db.select().from(schema.sessionTriggers).where(eq(schema.sessionTriggers.id, command.id)).get()?.status).toBe("pending");
    await service.waitForIdle();
    expect(connection.db.select().from(schema.sessionTriggers).where(eq(schema.sessionTriggers.id, command.id)).get()?.status).toBe("completed");
    expect(connection.db.select().from(schema.contextPacks).where(eq(schema.contextPacks.createdForInvocationId, command.id)).all()).toHaveLength(1);
});
test("schedule editor requires the Agent owner, enforces revisions and permanently deletes schedules", async () => {
    const { Hono } = await import("hono");
    const { createSessionCommandAdminRoutes } = await import("../../src/server/routes/session-commands");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("dashboardAuthSession" as never, { authenticated: true, account: { id: "fixture-owner", name: "Owner", provider: "local" } } as never); c.set("lunaRequestAuthKind" as never, (c.req.header("x-runner") ? "luna-access-token" : "dashboard-cookie") as never); await next(); });
    app.route("/", createSessionCommandAdminRoutes({ db: connection.db }));
    expect((await app.request("/schedules", { headers: { "x-runner": "1" } })).status).toBe(401);
    const agentId = new SessionStore(connection.db).getById(target)!.agent_id;
    const body = { title: "Reminder", targetSessionId: target, action: { kind: "message.send", content: "reminder" }, timezone: "Asia/Singapore", nextAt: Date.now() + 60000 };
    const created = await app.request(`/schedule-editor?agentId=${agentId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const row = await created.json() as {
        id: string;
    };
    const editor = `/schedule-editor/${row.id}?agentId=${agentId}`;
    const save = (revision: number) => app.request(editor, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, revision, nextAt: Date.now() + 120000 }) });
    const updated = await save(1);
    expect(updated.status).toBe(200);
    expect((await save(1)).status).toBe(409);
    expect(connection.db.select().from(schema.sessionSchedules).where(eq(schema.sessionSchedules.id, row.id)).get()?.revision).toBe(2);
    expect((await app.request(`/schedules/${row.id}?agentId=${agentId}`, { method: "DELETE" })).status).toBe(200);
    expect(connection.db.select().from(schema.sessionSchedules).where(eq(schema.sessionSchedules.id, row.id)).get()).toBeUndefined();
});
test("Feishu proactive delivery uses chat creation rather than a synthetic reply anchor", async () => {
    const { FeishuMessageChannel } = await import("../../extensions/channels/feishu");
    const channel = new FeishuMessageChannel("feishu", { chatId: "unused", appId: "cli_test", appSecret: "test" });
    let request: unknown;
    (channel as unknown as {
        _client: unknown;
    })._client = { im: { message: { create: async (input: unknown) => { request = input; return { data: { message_id: "provider-id" } }; }, reply: () => { throw new Error("must not reply"); } } } };
    const result = await channel.sendTo({ channelId: "feishu", surfaceId: "target-chat" }, { replyMode: "channel_message", content: "hello", idempotencyKey: "command-id" });
    expect(request).toMatchObject({ params: { receive_id_type: "chat_id" }, data: { receive_id: "target-chat", uuid: "command-id" } });
    expect(result.id).toBe("provider-id");
});

test("first Feishu contact persists recipient, binds receipt, reuses session for replies and retries", async () => {
    const { SessionResolver } = await import("../../src/sessions/session-resolver");
    const targetAddress = { kind: "feishu_user" as const, channelId: "test", idType: "open_id" as const, id: "ou_new" };
    expect(() => resolveMessageTarget(connection.db, targetAddress)).toThrow("Resolve this recipient");
    const { identity } = observeRecipient("test", {open_id: "ou_new"});
    const id = resolveMessageTarget(connection.db, targetAddress, source, true);
    expect(resolveMessageTarget(connection.db, targetAddress, source, true)).toBe(id);
    const deliveries: unknown[] = [];
    const adapter: ReplyChannel = { send: async () => { throw new Error("Must not synthesize reply"); }, sendTo: async (target, op) => {
        deliveries.push(target);
        // A reply can arrive before the HTTP send response; it must resolve the same session.
        const inbound = { id: "reply", channel: { id: "test", type: "feishu" }, surface: { externalId: "oc_created", kind: "p2p" as const }, sender: identity, text: "hello", mentions: [], addressing: { addressedToBot: true, reason: "p2p" as const } };
        expect(new SessionResolver(new SessionStore(connection.db)).resolveFromNormalizedInbound(inbound).id).toBe(id);
        return { ...op, id: "om_first", channelId: "test", deliveredSurfaceId: "oc_created" };
    } };
    const dispatcher = new SessionReplyDispatcher(connection.db, () => adapter);
    const service = new SessionCommandService({ db: connection.db, channelFor: channelId => dispatcher.channel(channelId) });
    const cmd = service.accept(actor(), id, "message.send", "first", { content: "hello" });
    service.accept(actor(), id, "message.send", "already-queued", { content: "queued before receipt" });
    await service.waitForIdle();
    expect(service.get(cmd.id)?.status).toBe("sent");
    expect(deliveries[0]).toMatchObject({ recipient: { idType: "open_id", id: "ou_new" } });
    expect(new SessionStore(connection.db).resolveByChannelSurface({ channelType: "feishu", channelId: "test", groupId: "oc_created" }).id).toBe(id);
    expect(connection.db.select().from(schema.directRecipients).get()?.surfaceId).toBe("oc_created");
    expect(service.accept(actor(), id, "message.send", "first", { content: "hello" }).id).toBe(cmd.id);
    service.accept(actor(), id, "message.send", "second", { content: "again" });
    await service.waitForIdle();
    expect(deliveries).toHaveLength(3);
    expect(deliveries[1]).toMatchObject({ recipient: { idType: "open_id", id: "ou_new" } });
    expect(deliveries[2]).toMatchObject({ surfaceId: "oc_created" });
    expect((deliveries[2] as { recipient?: unknown }).recipient).toBeUndefined();
});

test("Feishu first-contact adapter uses typed user ID and preserves conversation receipt", async () => {
    const { FeishuMessageChannel } = await import("../../extensions/channels/feishu");
    const { ProviderDeliveryRejected } = await import("../../src/messaging/provider-delivery-error");
    const channel = new FeishuMessageChannel("feishu", { chatId: "unused", appId: "cli_test", appSecret: "test" });
    let request: unknown, reject = false;
    (channel as unknown as { _client: unknown })._client = { im: { message: { create: async (input: unknown) => { request = input; return reject ? { code: 230013 } : { code: 0, data: { message_id: "om_first", chat_id: "oc_first" } }; } } } };
    const address = { channelId: "feishu", surfaceId: "placeholder", recipient: { idType: "open_id" as const, id: "ou_first" } };
    const op = { replyMode: "channel_message" as const, content: "hi", idempotencyKey: "stable" };
    expect(await channel.sendTo(address, op)).toMatchObject({ id: "om_first", deliveredSurfaceId: "oc_first" });
    expect(request).toMatchObject({ params: { receive_id_type: "open_id" }, data: { receive_id: "ou_first", uuid: "stable" } });
    const longKey = JSON.stringify(["session-delivery", "session-reply:" + "a".repeat(36), "binding:" + "b".repeat(36) + ":feishu-default"]);
    await channel.sendTo(address, { ...op, idempotencyKey: longKey });
    const providerKey = (request as { data: { uuid: string } }).data.uuid;
    expect(providerKey.length).toBeLessThanOrEqual(50);
    await channel.sendTo(address, { ...op, idempotencyKey: longKey });
    expect((request as { data: { uuid: string } }).data.uuid).toBe(providerKey);
    await channel.sendTo(address, { ...op, idempotencyKey: longKey + "different" });
    expect((request as { data: { uuid: string } }).data.uuid).not.toBe(providerKey);
    reject = true;
    await expect(channel.sendTo(address, op)).rejects.toBeInstanceOf(ProviderDeliveryRejected);
});

test("explicit provider rejection fails, lost first-contact receipt remains unknown without retry", async () => {
    const { ProviderDeliveryRejected } = await import("../../src/messaging/provider-delivery-error");
    observeRecipient("test", {open_id: "ou_tenant", user_id: "new_user"}, {tenantKey: "tenant-a"});
    const id = resolveMessageTarget(connection.db, { kind: "feishu_user", channelId: "test", idType: "user_id", id: "new_user" }, source, true);
    let calls = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({ send: async () => { throw Error("fallback"); }, sendTo: async () => { calls++; if (calls === 1) throw new ProviderDeliveryRejected("not available"); throw Error("connection lost"); } }) });
    const first = service.accept(actor(), id, "message.send", "rejected", { content: "first" });
    await service.waitForIdle(); expect(service.get(first.id)?.status).toBe("failed");
    const second = service.accept(actor(), id, "message.send", "lost", { content: "second" });
    await service.waitForIdle(); expect(service.get(second.id)?.status).toBe("unknown");
    await service.waitForIdle(); expect(calls).toBe(2);
    expect(connection.db.select().from(schema.directRecipients).get()?.surfaceId).toBeNull();
});

test("canonical delivery selects the current app's open ID and rejects a different app's ID", async () => {
    fixtureSessionOwnership(connection.db, "feishu", "other-bot");
    const a = observeRecipient("test", {open_id: "ou_a", user_id: "same"}, {tenantKey: "tenant-a"});
    const b = observeRecipient("other-bot", {open_id: "ou_b", user_id: "same"}, {tenantKey: "tenant-a"});
    expect(a.userId).toBe(b.userId);
    expect(() => resolveMessageTarget(connection.db, {kind: "feishu_user", channelId: "test", idType: "open_id", id: "ou_b"}, source, true)).toThrow("Resolve this recipient");
    const received: unknown[] = [];
    const service = new SessionCommandService({db: connection.db, channelFor: id => ({send: async () => {throw Error("fallback");}, sendTo: async (address, op) => {
        received.push([id, address.recipient]);
        return {...op, id: "provider-id", channelId: id, deliveredSurfaceId: `chat-${id}`};
    }})});
    const otherSource = new SessionStore(connection.db).resolveByChannelSurface({channelType: "feishu", channelId: "other-bot", groupId: "source"}).id;
    for (const sourceSessionId of [source, otherSource]) {
        const recipient = resolveMessageTarget(connection.db, {kind: "user", userId: a.userId}, sourceSessionId, true);
        service.accept({...actor(), sourceSessionId}, recipient, "message.send", "send", {content: "hello"});
    }
    await service.waitForIdle();
    expect(received).toEqual([["test", {idType: "open_id", id: "ou_a"}], ["other-bot", {idType: "open_id", id: "ou_b"}]]);
});

test("explicit recipient claims require verified scopes and are checked again before delivery", async () => {
    const platformSettings = new PlatformSettingsStore(connection.db);
    platformSettings.patch({
        messaging: { feishuDevelopers: {"test:feishu:test": "developer-a"} },
    });
    {
        observeRecipient("test", {open_id: "ou_no_scope", user_id: "without_tenant", union_id: "without_developer"});
        for (const [idType, id] of [["user_id", "without_tenant"], ["union_id", "without_developer"]] as const) {
            expect(() => resolveMessageTarget(connection.db, {kind: "feishu_user", channelId: "test", idType, id}, source, true)).toThrow("Resolve this recipient");
        }
        observeRecipient("test", {open_id: "ou_verified", user_id: "scoped_user", union_id: "scoped_union"}, {tenantKey: "tenant-a", developerId: "developer-a"});
        const address = {kind: "feishu_user" as const, channelId: "test", idType: "user_id" as const, id: "scoped_user"};
        const sessionId = resolveMessageTarget(connection.db, address, source, true);
        const unionAddress = {...address, idType: "union_id" as const, id: "scoped_union"};
        const unionSessionId = resolveMessageTarget(connection.db, unionAddress, source, true);
        platformSettings.patch({
            messaging: { feishuDevelopers: {"test:feishu:test": "developer-b"} },
        });
        expect(() => resolveMessageTarget(connection.db, unionAddress, source, true)).toThrow("Resolve this recipient");
        platformSettings.patch({
            messaging: { feishuDevelopers: {"test:feishu:test": "developer-a"} },
        });
        const received: unknown[] = [];
        const service = new SessionCommandService({db: connection.db, channelFor: id => ({send: async () => {throw Error("fallback");}, sendTo: async (address, op) => {
            received.push(address.recipient);
            return {...op, id: "provider-id", channelId: id, deliveredSurfaceId: "union-chat"};
        }})});
        const queued = service.accept(actor(), sessionId, "message.send", "tenant", {content: "hello"});
        service.accept(actor(), unionSessionId, "message.send", "union", {content: "hello"});
        observeRecipient("test", {open_id: "ou_other_tenant", user_id: "scoped_user"}, {tenantKey: "tenant-b"});
        expect(() => resolveMessageTarget(connection.db, address, source, true)).toThrow("Resolve this recipient");
        await service.waitForIdle();
        expect(service.get(queued.id)).toMatchObject({status: "failed", error: expect.stringContaining("Resolve this recipient")});
        expect(received).toEqual([{idType: "union_id", id: "scoped_union"}]);
    }
});

test("retired binding cannot deliver its queued address or reuse its recipient session", async () => {
    observeRecipient("test", {open_id: "ou_recipient"});
    const address = {kind: "feishu_user" as const, channelId: "test", idType: "open_id" as const, id: "ou_recipient"};
    const recipient = resolveMessageTarget(connection.db, address, source, true);
    const { service, sent } = runtime();
    const queued = service.accept(actor(), recipient, "message.send", "retired", {content: "hello"});
    const bindings = new BotBindingStore(connection.db);
    const current = bindings.requireActive("test");
    bindings.retire("fixture-owner", current.id);
    const next = new AgentStore(connection.db).createShadow("fixture-owner", current.agentId, {name: "Replacement"}, "replacement");
    bindings.bind("fixture-owner", next.id, "test");
    const nextSource = new SessionStore(connection.db).resolveByChannelSurface({channelType: "feishu", channelId: "test", groupId: "source"});
    expect(resolveMessageTarget(connection.db, address, nextSource.id, true)).not.toBe(recipient);
    await service.waitForIdle();
    expect(service.get(queued.id)).toMatchObject({status: "failed", error: expect.stringContaining("session_binding_mismatch")});
    expect(sent).toEqual([]);
});

function creationGrant() {
}
const groupRequest = () => ({ content: "Project", group: { channelId: "test", name: "Project", idType: "open_id" as const, memberIds: ["ou_a"] } });

test("cross-Shadow recipient resolution and group creation have no side effects", () => {
    fixtureSessionOwnership(connection.db, "feishu", "other-bot");
    const { service } = runtime();
    expect(() => resolveMessageTarget(connection.db, {kind: "feishu_user", channelId: "other-bot", idType: "open_id", id: "ou_target"}, source, true))
        .toThrow("Channel is outside the current session's binding");
    const request = groupRequest();
    expect(() => service.accept(actor(), source, "group.create", "other", {...request, group: {...request.group, channelId: "other-bot"}}))
        .toThrow("Group creation must use the current session's Feishu binding");
    expect(connection.db.select().from(schema.sessions).all()).toHaveLength(2);
    expect(connection.db.select().from(schema.directRecipients).all()).toHaveLength(0);
    expect(connection.db.select().from(schema.sessionCommands).all()).toHaveLength(0);
});

test("disabled bot cannot deliver an already accepted command", async () => {
    const { service, sent } = runtime();
    const command = service.accept(actor(), target, "message.send", "disable", {content: "hello"});
    connection.db.update(schema.channelConfigs).set({enabled: false}).where(eq(schema.channelConfigs.id, "test")).run();
    await service.waitForIdle();
    expect(sent).toEqual([]);
    expect(service.get(command.id)).toMatchObject({status: "failed", error: expect.stringContaining("channel_disabled")});
});

test("group creation is durable, idempotent and binds a session without followup authority", async () => {
    creationGrant(); let creates = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({ send: async (_i, op) => ({ ...op, id: "sent", channelId: "test" }), createGroup: async input => { creates++; expect(input.requestId).toBeTruthy(); return { externalId: "oc_new", kind: "group", displayName: input.name }; } }) });
    const command = service.accept(actor(), source, "group.create", "create", groupRequest());
    expect(creates).toBe(0); expect(command.messageId).toBeNull();
    expect(service.accept(actor(), source, "group.create", "create", groupRequest()).id).toBe(command.id);
    expect(() => service.accept(actor(), source, "group.create", "create", { ...groupRequest(), group: { ...groupRequest().group, name: "changed" } })).toThrow("different payload");
    await service.waitForIdle(); expect(creates).toBe(1);
    const done = service.get(command.id)!; expect(done.status).toBe("completed");
    const result = done.payload.result as { groupId: string; chatId: string; sessionId: string };
    expect(result.chatId).toBe("oc_new");
    expect(new SessionStore(connection.db).resolveByChannelSurface({ channelType: "feishu", channelId: "test", groupId: "oc_new" }).id).toBe(result.sessionId);
    const nextActor = actor();
    const message = service.accept(nextActor, result.sessionId, "message.send", "welcome", { content: "welcome" });
    await service.waitForIdle(); expect(service.get(message.id)?.status).toBe("sent");
    expect(service.accept(nextActor, result.sessionId, "message.send", "late", { content: "late" }).status).toBe("pending");
});

test("group creation rejects inactive actors at execution without authority records", async () => {
    let calls = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({ send: async () => { throw Error("unused"); }, createGroup: async () => { calls++; return { externalId: "oc_new", kind: "group" }; } }) });
    const cmd = service.accept(actor(), source, "group.create", "create", groupRequest());
    connection.db.update(schema.users).set({status:"blocked"}).where(eq(schema.users.id,"u")).run();
    await service.waitForIdle(); expect(calls).toBe(0); expect(service.get(cmd.id)?.status).toBe("failed");
});

test("interrupted group creation becomes unknown and never creates a duplicate after restart", async () => {
    creationGrant(); const first = runtime();
    const cmd = first.service.accept(actor(), source, "group.create", "create", groupRequest());
    connection.db.update(schema.sessionCommands).set({ status: "running", claim: "interrupted" }).where(eq(schema.sessionCommands.id, cmd.id)).run();
    let calls = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({ send: async () => { throw Error("unused"); }, createGroup: async () => { calls++; throw Error("unexpected"); } }) });
    service.start(); await service.waitForIdle(); await service.stop();
    expect(service.get(cmd.id)?.status).toBe("unknown"); expect(calls).toBe(0);
});

test("Feishu group adapter uses provider idempotency, typed members and private internal groups", async () => {
    const { FeishuMessageChannel } = await import("../../extensions/channels/feishu");
    const channel = new FeishuMessageChannel("feishu", { chatId: "unused", appId: "cli_test", appSecret: "test" });
    let request: unknown;
    (channel as unknown as { _client: unknown })._client = { im: { chat: { create: async (input: unknown) => { request = input; return { code: 0, data: { chat_id: "oc_new", name: "Project" } }; }, get: async () => ({ code: 0, data: { chat_mode: "group", name: "Project" } }) } } };
    expect(await channel.createGroup({ name: "Project", idType: "open_id", memberIds: ["ou_a"], requestId: "stable" })).toMatchObject({ externalId: "oc_new", kind: "group" });
    expect(request).toMatchObject({ params: { user_id_type: "open_id", uuid: "stable" }, data: { user_id_list: ["ou_a"], chat_mode: "group", chat_type: "private", external: false } });
    expect(await channel.lookupGroup("oc_new")).toMatchObject({ externalId: "oc_new", displayName: "Project" });
});

test("group invitations preserve partial results, reject invalid members and deduplicate replay", async () => {
    let calls = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({ send: async () => { throw Error("unused"); }, inviteGroupMembers: async () => { calls++; return { acceptedMemberIds: ["ou_a"], invalidMemberIds: ["ou_b"], notExistedMemberIds: [], pendingApprovalMemberIds: ["ou_c"] }; } }) });
    const payload = { content: "Invite group members", invitation: { channelId: "test", chatId: "target", idType: "open_id" as const, memberIds: ["ou_c", "ou_a", "ou_b"] } };
    expect(() => service.accept(actor(), target, "group.invite", "bad", { ...payload, invitation: { ...payload.invitation, memberIds: [] } })).toThrow();
    const command = service.accept(actor(), target, "group.invite", "invite", payload);
    await service.waitForIdle(); expect(calls).toBe(1);
    expect(service.get(command.id)).toMatchObject({ status: "partial", payload: { result: { acceptedMemberIds: ["ou_a"], invalidMemberIds: ["ou_b"], pendingApprovalMemberIds: ["ou_c"] } } });
    expect(service.accept(actor(), target, "group.invite", "invite", { ...payload, invitation: { ...payload.invitation, memberIds: ["ou_b", "ou_a", "ou_c"] } }).id).toBe(command.id);
    await service.waitForIdle(); expect(calls).toBe(1);
    expect(() => service.accept(actor(), target, "group.invite", "wrong", { ...payload, invitation: { ...payload.invitation, chatId: "other" } })).toThrow("authorized group");
});

test("group invitation transport ambiguity is not automatically retried", async () => {
    let calls = 0;
    const service = new SessionCommandService({ db: connection.db, channelFor: () => ({ send: async () => { throw Error("unused"); }, inviteGroupMembers: async () => { calls++; throw Error("connection lost"); } }) });
    const command = service.accept(actor(), target, "group.invite", "invite", { content: "Invite", invitation: { channelId: "test", chatId: "target", idType: "open_id", memberIds: ["ou_a"] } });
    await service.waitForIdle(); await service.waitForIdle();
    expect(service.get(command.id)?.status).toBe("unknown"); expect(calls).toBe(1);
});

test("Feishu invitation adapter retains failed and pending members instead of reporting full success", async () => {
    const { FeishuMessageChannel } = await import("../../extensions/channels/feishu");
    const channel = new FeishuMessageChannel("feishu", { chatId: "unused", appId: "cli_test", appSecret: "test" });
    let request: unknown;
    (channel as unknown as { _client: unknown })._client = { im: { chatMembers: { create: async (input: unknown) => { request = input; return { code: 0, data: { invalid_id_list: ["ou_bad"], not_existed_id_list: ["ou_missing"], pending_approval_id_list: ["ou_pending"] } }; } } } };
    const result = await channel.inviteGroupMembers({ chatId: "oc_group", idType: "open_id", memberIds: ["ou_ok", "ou_bad", "ou_missing", "ou_pending"], requestId: "stable" });
    expect(result).toEqual({ acceptedMemberIds: ["ou_ok"], invalidMemberIds: ["ou_bad"], notExistedMemberIds: ["ou_missing"], pendingApprovalMemberIds: ["ou_pending"] });
    expect(request).toMatchObject({ path: { chat_id: "oc_group" }, params: { member_id_type: "open_id", succeed_type: 1 } });
});

test("group creation freezes trigger plus four neighbors and supplements, before handoff", async () => {
    const db = connection.db;
    const store = new MessageStore(db);
    const rows = Array.from({length: 7}, (_, i) => store.append({sessionId: source, channelMessageKey: `context-${i}`, role: "user", senderUserId: "u", content: [{type: "text", text: `Fact ${i}`}]}));
    let creates = 0;
    const service = new SessionCommandService({db, channelFor: () => ({send: async () => {throw Error("Must not repost history");}, createGroup: async input => {
        creates++; expect(input).not.toHaveProperty("contextMessageIds"); return {externalId: "oc_context", kind: "group"};
    }})});
    const request = {...groupRequest(), contextMessageIds: [rows[0]!.id, rows[0]!.id]};
    const command = service.accept({...actor(), triggerMessageId: rows[6]!.id}, source, "group.create", "context-group", request);
    const expectedIds = [...rows.slice(2).map(row => row.id), rows[0]!.id];
    expect(command.payload.launchMessageIds).toEqual(expectedIds);
    const late = store.append({sessionId: source, channelMessageKey: "later-context", role: "user", senderUserId: "u", content: [{type: "text", text: "Arrived after acceptance"}]});
    expect(service.accept({...actor(), triggerMessageId: late.id}, source, "group.create", "context-group", request).payload.launchMessageIds).toEqual(expectedIds);
    await service.waitForIdle();
    expect(service.get(command.id)?.status).toBe("completed"); expect(creates).toBe(1);
    const targetId = (service.get(command.id)!.payload.result as {sessionId: string}).sessionId;
    const {ContextPackStore} = await import("../../src/context/context-pack-store");
    const packs = new ContextPackStore(db);
    const launch = packs.listPacksForOwner("session", targetId).filter(pack => pack.kind === "group_launch");
    expect(launch).toHaveLength(1);
    expect(launch[0]?.triggerMessageId).toBe(rows[6]!.id);
    expect(packs.listItemsForPack(launch[0]!.id).map(item => item.sourceMessageId)).toEqual(expectedIds);
    expect(db.select().from(schema.sessionTimelineEntries).where(eq(schema.sessionTimelineEntries.sessionId, targetId)).all()).toHaveLength(6);
    expect(db.select().from(schema.messages).where(eq(schema.messages.ownerSessionId, targetId)).all()).toHaveLength(0);
    const {MainRunnerContextBuilder} = await import("../../src/main-runner/context-builder");
    expect(new MainRunnerContextBuilder(db).buildForSession(targetId).launchSeed?.items.map(item => item.messageId).sort()).toEqual([...expectedIds].sort());
    expect(db.select().from(schema.sessionCommands).all()).toHaveLength(1);
    expect(service.accept(actor(), source, "group.create", "context-group", request).id).toBe(command.id);
    expect(() => service.accept(actor(), source, "group.create", "context-group", {...request, contextMessageIds: [rows[1]!.id]})).toThrow("different payload");
    await service.waitForIdle(); expect(creates).toBe(1);
});

test("invalid group context is atomic and deleted queued context fails before provider creation", async () => {
    const db = connection.db, store = new MessageStore(db);
    const row = store.append({sessionId: source, channelMessageKey: "context-source", role: "user", senderUserId: "u", content: [{type: "text", text: "Source"}]});
    const foreign = store.append({sessionId: target, channelMessageKey: "context-foreign", role: "user", senderUserId: "u", content: [{type: "text", text: "Foreign"}]});
    let creates = 0;
    const service = new SessionCommandService({db, channelFor: () => ({send: async () => {throw Error("unused");}, createGroup: async () => {creates++;return {externalId: "oc_invalid", kind: "group"};}})});
    for (const id of [foreign.id, "missing"]) expect(() => service.accept(actor(), source, "group.create", id, {...groupRequest(), contextMessageIds: [id]})).toThrow("visible messages");
    expect(() => service.accept(actor(), source, "group.create", "too-many", {...groupRequest(), contextMessageIds: Array(101).fill(row.id)})).toThrow();
    expect(db.select().from(schema.sessionCommands).all()).toHaveLength(0);
    const command = service.accept({...actor(), triggerMessageId: row.id}, source, "group.create", "queued", groupRequest());
    db.update(schema.messages).set({deletedAt: Date.now()}).where(eq(schema.messages.id, row.id)).run();
    expect(() => service.accept(actor(), source, "group.create", "deleted", {...groupRequest(), contextMessageIds: [row.id]})).toThrow("visible messages");
    await service.waitForIdle();
    expect(service.get(command.id)?.status).toBe("failed"); expect(creates).toBe(0);
});
test("a trigger that runs on the Main Runner settles its invocation with the command", async () => {
    const { InvocationStore } = await import("../../src/runners/invocation-store");
    const { RunnerContextStore } = await import("../../src/runners/runner-context-store");
    let invocationId = "";
    const { service } = runtime(async (command) => {
        const context = new RunnerContextStore(connection.db).resolveForSession(command.sessionId, "codex");
        const inputSnapshot = { version: 1 as const, kind: "main", input: {
            input: { type: "session_trigger", triggerId: command.id, instruction: "reflect", requesterUserId: command.actorUserId, context: { sessionId: command.sessionId, candidateOpenTasks: [] }, artifactRefs: [], sourceSessionId: command.sessionId, correlationId: "corr", hops: 0 },
            runnerContext: context, turnId: command.id,
        } };
        invocationId = new InvocationStore(connection.db).register({ id: "main-trigger", runnerKind: "main", actorUserId: command.actorUserId, runnerContextId: context.id,
            sessionId: command.sessionId, taskId: null, taskRunId: null, originId: command.id, contextPackIds: [],
            inputSnapshot }).id;
    });
    const command = service.accept(actor(), target, "session.invoke", "main-reflection", { content: "reflect" });
    await service.waitForIdle();
    expect(service.get(command.id)?.status).toBe("completed");
    expect(new InvocationStore(connection.db).require(invocationId).state).toBe("settled");
});
