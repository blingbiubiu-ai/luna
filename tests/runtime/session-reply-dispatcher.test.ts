import { beforeEach, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { config, setLunaHome } from "@/shared";
import { SessionStore } from "@/sessions/session-store";
import { SessionReplyDispatcher } from "@/messaging/session-reply-dispatcher";
import { DashboardChannel } from "@/channels/dashboard/dashboard-channel";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";
import type { NormalizedInboundMessage } from "@/channels";
import type { ReplyChannel } from "@/channels/outbound";

let previousHome: string, home: string, db: DataConnection<typeof schema>, store: SessionStore, sessionId: string;
let channels: Map<string, ReplyChannel>, dispatcher: SessionReplyDispatcher;
let native: FakeFeishuChannel, peer: FakeFeishuChannel, dashboardCalls: number;
let inbound: NormalizedInboundMessage;

beforeEach(() => {
  previousHome = config.paths.home;
  home = mkdtempSync(join(tmpdir(), "luna-dispatch-"));
  setLunaHome(home);
  db = new DataConnection(schema);
  fixtureSessionOwnership(db.db, "feishu", "native", "owner");
  fixtureSessionOwnership(db.db, "feishu", "peer", "owner");
  store = new SessionStore(db.db);
  sessionId = store.resolveByChannelSurface({channelType: "feishu", channelId: "native", groupId: "native-chat"}).id;
  native = new FakeFeishuChannel("native");
  peer = new FakeFeishuChannel("peer");
  const dashboard = new DashboardChannel(db.db);
  dashboardCalls = 0;
  const send = dashboard.send.bind(dashboard);
  dashboard.send = async (input, op) => {
    dashboardCalls++;
    return send(input, op);
  };
  channels = new Map<string, ReplyChannel>([["native", native], ["luna-dashboard", dashboard], ["peer", peer]]);
  dispatcher = new SessionReplyDispatcher(db.db, id => channels.get(id));
  inbound = {
    id: "native-message", channel: {type: "feishu", id: "native"}, surface: {externalId: "native-chat", kind: "group"},
    sender: {externalId: "user", kind: "user"}, text: "hi", mentions: [], addressing: {addressedToBot: true, reason: "p2p"},
  };
});
afterEach(() => {
  db.close();
  setLunaHome(previousHome);
  rmSync(home, {recursive: true, force: true});
});

const operation = () => ({sessionId, replyMode: "channel_message" as const, idempotencyKey: "reply", content: "hello"});

test("either input source dispatches to the session's assigned bot", async () => {
  expect(() => store.bindChannelSurface(sessionId, {channelType: "feishu", channelId: "peer", groupId: "peer-chat"}))
    .toThrow("session_binding_mismatch");
  const receipt = await dispatcher.send(inbound, operation());
  expect(receipt.resolvedSessionId).toBe(sessionId);
  const fromDashboard = {...inbound, id: "dashboard:input", channel: {type: "dashboard", id: "luna-dashboard"},
    surface: {externalId: sessionId, kind: "p2p" as const}};
  await dispatcher.send(fromDashboard, {...operation(), idempotencyKey: "reply2"});
  expect(native.outbound).toHaveLength(2);
  expect(native.outbound[1]!.targetMessageId).toBe("native-chat");
  expect(peer.outbound).toHaveLength(0);
  expect(dashboardCalls).toBe(0);
  expect(db.db.select().from(schema.sessionChannelDeliveries).all().map(row => row.status)).toEqual(["sent", "sent"]);
});

test("failed delivery resumes after restart and a successful retry is durable", async () => {
  channels.set("native", {send: async () => { throw new Error("bot offline"); }});
  await expect(dispatcher.send(inbound, operation())).rejects.toThrow("bot offline");
  expect(db.db.select().from(schema.sessionChannelDeliveries).all().map(row => row.status)).toEqual(["failed"]);
  channels.set("native", native);
  const restarted = new SessionReplyDispatcher(db.db, id => channels.get(id));
  const receipt = await restarted.send(inbound, operation());
  expect(await restarted.send(inbound, operation())).toEqual(receipt);
  expect(native.outbound).toHaveLength(1);
  expect(peer.outbound).toHaveLength(0);
  await expect(restarted.send(inbound, {...operation(), content: "changed"})).rejects.toThrow("idempotency conflict");
});

test("logical card updates resolve the bound bot's physical card ID", async () => {
  const first = await dispatcher.send(inbound, {...operation(), statusCard: {taskId: "task"}});
  const nativeId = native.outbound[0]!.id;
  const updated = await dispatcher.send(inbound, {...operation(), idempotencyKey: "update", replyMode: "update_status_card",
    targetMessageId: first.id, statusCard: {taskId: "task", status: "completed"}});
  expect(native.outbound[1]!.targetMessageId).toBe(nativeId);
  expect(updated.id).toBe(first.id);
  expect(peer.outbound).toHaveLength(0);
});

test("a provider thread inherits the source Shadow and bot binding", async () => {
  const reply = await dispatcher.send(inbound, {...operation(), replyMode: "reply_in_thread"});
  const child = reply.resolvedSessionId!;
  expect(child).not.toBe(sessionId);
  expect(store.channelBindings(child)).toEqual([expect.objectContaining({channelId: "native", threadId: "fake-thread-native-message"})]);
  const parent = store.getById(sessionId)!;
  expect(store.getById(child)).toMatchObject({agent_id: parent.agent_id, shadow_id: parent.shadow_id,
    binding_id: parent.binding_id, bot_user_id: parent.bot_user_id});
});

test("concurrent retries share one in-flight delivery", async () => {
  await Promise.all([dispatcher.send(inbound, operation()), dispatcher.send(inbound, operation())]);
  expect(native.outbound).toHaveLength(1);
  expect(peer.outbound).toHaveLength(0);
});

test("Dashboard adapter never sends through another channel", async () => {
  await channels.get("luna-dashboard")!.send(inbound, operation());
  expect(native.outbound).toHaveLength(0);
  expect(peer.outbound).toHaveLength(0);
});

test("only an explicit direct target on the assigned bot is used for delivery", async () => {
  const addresses: string[] = [];
  channels.set("native", {
    getBotIdentity: native.getBotIdentity.bind(native),
    send: native.send.bind(native),
    sendTo: async (target, op) => {
      addresses.push(target.surfaceId);
      if (addresses.length === 1) throw new Error("direct delivery failed");
      return {...op, id: "direct-result", channelId: "native", deliveredSurfaceId: target.surfaceId};
    },
  });
  const wrapped = dispatcher.channel("native")!;
  await expect(wrapped.sendTo!({channelId: "peer", surfaceId: "peer-chat"}, operation()))
    .rejects.toThrow("session_binding_mismatch");
  expect(addresses).toEqual([]);
  const target = {channelId: "native", surfaceId: "native-chat"};
  await expect(wrapped.sendTo!(target, operation())).rejects.toThrow("direct delivery failed");
  const restarted = new SessionReplyDispatcher(db.db, id => channels.get(id)).channel("native")!;
  const result = await restarted.sendTo!(target, operation());
  expect(result.deliveredSurfaceId).toBe("native-chat");
  const retry = await restarted.sendTo!(target, operation());
  expect(retry).toEqual(result);
  await dispatcher.send({...inbound, rawPayload: {dispatchTarget: {channelId: "peer", surfaceId: "peer-chat"}}},
    {...operation(), idempotencyKey: "ordinary"});
  expect(addresses).toEqual(["native-chat", "native-chat"]);
  expect(native.outbound).toHaveLength(1);
  expect(peer.outbound).toHaveLength(0);
  await wrapped.send(inbound, {replyMode: "direct_message", idempotencyKey: "private-control", content: "private control response"});
  expect(native.outbound).toHaveLength(2);
});
