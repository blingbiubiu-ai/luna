import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parseReply, replyMarkdown } from "@luna/runner-protocol/reply";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { config, reloadConfig, setLunaHome } from "../../src/shared";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionCommandService, registerSessionCommands } from "../../src/messaging/session-command-service";
import { finalizeRunnerReply } from "../../src/messaging/runner-answer";
import { ArtifactRegistry } from "../../src/artifacts/artifact-registry";
import { fixtureOwnerUserId, fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import type { OutboundChannelOperation } from "../../src/channels/outbound";

let previousHome: string, home: string, db: DataConnection<typeof schema>, sessionId: string;
beforeEach(() => {
  previousHome = config.paths.home;
  home = mkdtempSync(join(tmpdir(), "luna-reply-")); setLunaHome(home);
  writeFileSync(join(home, "config.yaml"), "{}\n");
  reloadConfig(); db = new DataConnection(schema);
  fixtureSessionOwnership(db.db, "feishu", "test", "user");
  sessionId = new SessionStore(db.db).resolveByChannelSurface({ channelType: "feishu", channelId: "test", groupId: "room" }).id;
});
afterEach(() => {
  db.close(); setLunaHome(previousHome);
  try { reloadConfig(); } catch { /* The original environment may have no config. */ }
  rmSync(home, { recursive: true, force: true });
});

test("only reply documents opt into presentation and downgrade preserves ordered images", () => {
  expect(replyMarkdown(parseReply('{"answer":42}'))).toBe('{"answer":42}');
  expect(replyMarkdown(parseReply('```json\n{"answer":42}\n```'))).toBe('```json\n{"answer":42}\n```');
  const fencedReply = parseReply('```json\n{"type":"luna.reply","version":1,"presentation":"message","replyTo":"msg-1","content":[{"type":"mention","userId":"u1","label":"王华杰"},{"type":"text","text":"#7401353950 进展已更新"}]}\n```');
  expect(fencedReply.presentation).toBe("message");
  expect(fencedReply.replyTo).toBe("msg-1");
  expect(replyMarkdown(fencedReply)).toBe("@王华杰 #7401353950 进展已更新");
  const bareFencedCard = parseReply('```\n{"type":"luna.reply","version":1,"presentation":"card","title":"处理结果","content":[{"type":"text","text":"已完成。"}]}\n```');
  expect(bareFencedCard.presentation).toBe("card");
  expect(bareFencedCard.title).toBe("处理结果");
  const rawNewlineReply = parseReply('{"type":"luna.reply","version":1,"presentation":"message","replyTo":"msg-2","content":[{"type":"mention","userId":"u1"},{"type":"text","text":"第一段。\n\n第二段。"}],}');
  expect(rawNewlineReply.presentation).toBe("message");
  expect(rawNewlineReply.replyTo).toBe("msg-2");
  expect(rawNewlineReply.content[1]).toEqual({ type: "text", text: "第一段。\n\n第二段。" });
  const reply = parseReply(JSON.stringify({ type: "luna.reply", version: 1, presentation: "card", template: "unsupported",
    content: [{ type: "text", text: "before" }, { type: "image", artifactRef: "artifact:img", alt: "preview" }, { type: "text", text: "after" }] }));
  expect(reply.presentation).toBe("message");
  expect(replyMarkdown(reply)).toBe("before\n\n![preview](artifact:img)\n\nafter");
  expect(() => parseReply('{"type":"luna.reply","content":[{"type":"image","artifactRef":"/etc/passwd"}]}')).toThrow();
  expect(() => parseReply('```json\n{"type":"luna.reply","content":[{"type":"image","artifactRef":"/etc/passwd"}]}\n```')).toThrow();
});

test("final answer persists once before delivery and recovery does not call the provider again", async () => {
  const delivered: string[] = [];
  const channel = { send: async (_inbound: unknown, op: Omit<OutboundChannelOperation, "id" | "channelId">) => {
    delivered.push(op.content); return { ...op, id: "sent", channelId: "test" };
  } };
  const first = new SessionCommandService({ db: db.db, channelFor: () => channel }); registerSessionCommands(db.db, first);
  const input = { sessionId, originId: "turn", actorUserId: fixtureOwnerUserId("user"), allowSilent: false, text: "最终答复" };
  expect(finalizeRunnerReply(db.db, input).kind).toBe("queued");
  expect(delivered).toEqual([]);
  const resumed = new SessionCommandService({ db: db.db, channelFor: () => channel }); registerSessionCommands(db.db, resumed);
  expect(finalizeRunnerReply(db.db, input).kind).toBe("existing");
  await resumed.waitForIdle();
  expect(delivered).toEqual(["最终答复"]);
  expect(finalizeRunnerReply(db.db, input).kind).toBe("existing");
  expect(db.db.select().from(schema.sessionCommands).all()).toHaveLength(1);
});

test.each(["pending", "running", "sent", "unknown"])("CLI answer in %s owns delivery; progress does not", status => {
  const service = new SessionCommandService({ db: db.db, channelFor: () => undefined }); registerSessionCommands(db.db, service);
  const actor = { userId: fixtureOwnerUserId("user"), sourceSessionId: sessionId, originId: "turn" };
  service.accept(actor, sessionId, "message.send", "progress", { content: "working", purpose: "progress" });
  const answer = service.accept(actor, sessionId, "message.send", "answer", { content: "done", purpose: "answer" });
  db.db.update(schema.sessionCommands).set({ status }).where(eq(schema.sessionCommands.id, answer.id)).run();
  expect(finalizeRunnerReply(db.db, { sessionId, originId: "turn", actorUserId: fixtureOwnerUserId("user"), allowSilent: false, text: "duplicate" }).kind).toBe("existing");
  expect(finalizeRunnerReply(db.db, { sessionId, originId: "next", actorUserId: fixtureOwnerUserId("user"), allowSilent: false, text: "next answer" }).kind).toBe("queued");
});

function groupAsker(kind: "user" | "bot" = "user") {
  const directory = new ChannelDirectoryStore(db.db);
  directory.upsertSurface({ channel: { type: "feishu", id: "test" }, surface: { externalId: "room", kind: "group" } });
  const scope = db.db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!;
  const identity = directory.upsertIdentity({ channel: { type: "feishu", id: "test" }, agentId: scope.agent_id,
    identity: { kind, externalId: "ou_asker", displayName: "Asker", providerIds: { open_id: "ou_asker" } } });
  const userId = db.db.select().from(schema.channelUserBindings).where(eq(schema.channelUserBindings.channelIdentityId, identity.id)).get()!.userId;
  db.db.insert(schema.messages).values({ id: "question", agentId: scope.agent_id, shadowId: scope.shadow_id, bindingId: scope.binding_id, ownerSessionId: sessionId,
    channelType: "feishu", channelId: "test", externalMessageId: "om_question", senderUserId: userId, role: "user",
    contentKind: "text", presentationKind: "plain", contentJson: [{ type: "text", text: "问题" }], occurredAt: 1, createdAt: 1 }).run();
  return userId;
}
function capture() {
  const sent: Omit<OutboundChannelOperation, "id" | "channelId">[] = [];
  const service = new SessionCommandService({ db: db.db, channelFor: () => ({ send: async (_inbound, op) => { sent.push(op); return { ...op, id: "sent", channelId: "test" }; } }) });
  registerSessionCommands(db.db, service);
  return { sent, service };
}
const answer = (text: string) =>
  finalizeRunnerReply(db.db, { sessionId, originId: "turn", actorUserId: fixtureOwnerUserId("user"), allowSilent: false, text });

test("Service does not auto-inject quotes or @-mentions into plain group or direct answers", async () => {
  groupAsker(); const { sent, service } = capture();
  answer("好的，已处理。");
  await service.waitForIdle();
  expect(sent[0]?.quoteMessageId).toBeUndefined();
  expect(sent[0]?.inlineMentions).toBeUndefined();
  expect(sent[0]?.reply).toMatchObject({
    presentation: "text",
    content: [{ type: "text", text: "好的，已处理。" }],
  });
});

test("Agent-chosen quotes and inline mentions are delivered as written in group and card replies", async () => {
  const asker = groupAsker(); const { sent, service } = capture();
  const own = JSON.stringify({ type: "luna.reply", version: 1, presentation: "message", replyTo: "question",
    content: [{ type: "text", text: "请 " }, { type: "mention", userId: asker }, { type: "text", text: " 确认" }] });
  answer(own);
  await service.waitForIdle();
  expect(sent[0]?.reply?.content).toHaveLength(3);
  expect(sent[0]?.inlineMentions).toEqual(["ou_asker"]);
  expect(sent[0]?.quoteMessageId).toBe("om_question");
  finalizeRunnerReply(db.db, { sessionId, originId: "card", actorUserId: fixtureOwnerUserId("user"), allowSilent: false,
    text: JSON.stringify({ type: "luna.reply", version: 1, presentation: "card", title: "结果", replyTo: "question", content: [{ type: "text", text: "完成" }] }) });
  await service.waitForIdle();
  expect(sent[1]?.quoteMessageId).toBe("om_question");
  expect(sent[1]?.inlineMentions).toBeUndefined();
});

test("structured card is persisted, forwarded, and authorized with active image artifacts", async () => {
  const artifact = new ArtifactRegistry(db.db).registerContent({ scopeType: "session", scopeId: sessionId, producer: "test", kind: "image", name: "test.png", mimeType: "image/png", content: new Uint8Array([1, 2, 3]) });
  let sent: OutboundChannelOperation["reply"];
  const service = new SessionCommandService({ db: db.db, channelFor: () => ({ send: async (_inbound, op) => { sent = op.reply; return { ...op, id: "sent", channelId: "test" }; } }) });
  registerSessionCommands(db.db, service);
  const text = JSON.stringify({ type: "luna.reply", version: 1, presentation: "card", title: "成果", content: [{ type: "text", text: "预览" }, { type: "image", artifactRef: `artifact:${artifact.id}` }] });
  finalizeRunnerReply(db.db, { sessionId, originId: "turn", actorUserId: fixtureOwnerUserId("user"), allowSilent: false, text });
  expect(db.db.select().from(schema.messages).all()[0]?.presentationKind).toBe("rich_markdown");
  await service.waitForIdle(); expect(sent?.content[1]?.type).toBe("image");
  const missing = text.replace(artifact.id, "missing");
  expect(() => finalizeRunnerReply(db.db, { sessionId, originId: "other", actorUserId: fixtureOwnerUserId("user"), allowSilent: false, text: missing })).toThrow("active image");
});

test.each(["image", "message", "card"])("Feishu %s renders image blocks in order for direct and threaded delivery", async presentation => {
  const { FeishuMessageChannel } = await import("../../extensions/channels/feishu");
  const artifact = new ArtifactRegistry(db.db).registerContent({ scopeType: "session", scopeId: sessionId, producer: "test", kind: "image", name: "test.png", mimeType: "image/png", content: new Uint8Array([1, 2, 3]) });
  const channel = new FeishuMessageChannel("test", { chatId: "room", appId: "test:feishu:test", appSecret: "test", db: db.db });
  const requests: { data: { msg_type: string; content: string } }[] = [];
  const send = async (input: typeof requests[number]) => { requests.push(input); return { code: 0, data: { message_id: "out", chat_id: "room" } }; };
  (channel as unknown as { _client: unknown })._client = { im: { message: { create: send, reply: send } } };
  channel.uploadImage = async () => "image-key";
  const image = { type: "image", artifactRef: `artifact:${artifact.id}`, alt: "preview" };
  const reply = parseReply(JSON.stringify({ type: "luna.reply", version: 1, presentation: presentation === "image" ? "message" : presentation,
    content: presentation === "image" ? [image] : [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] }));
  const operation = { replyMode: "channel_message" as const, content: replyMarkdown(reply), reply, idempotencyKey: "reply" };
  await channel.sendTo({ channelId: "test", surfaceId: "room" }, operation);
  await channel.sendTo({ channelId: "test", surfaceId: "room", threadId: "thread", rootMessageId: "root" }, operation);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.data.msg_type).toBe(presentation === "card" ? "interactive" : presentation === "image" ? "image" : "post");
    expect(request.data.content).toContain("image-key");
    if (presentation !== "image") {
      const value = JSON.parse(request.data.content);
      const elements = presentation === "card" ? value.body.elements : value.zh_cn.content.flat();
      const flattened = JSON.stringify(elements);
      expect(flattened.indexOf("before")).toBeLessThan(flattened.indexOf("image-key"));
      expect(flattened.indexOf("image-key")).toBeLessThan(flattened.lastIndexOf("after"));
    }
  }
});

test("CLI JSON and text use the same purpose-independent message endpoint", async () => {
  const { runSayCli } = await import("@luna/cli/commands/say");
  const requests: Record<string, unknown>[] = [];
  const keys: (string | null)[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    keys.push(request.headers.get("Idempotency-Key"));
    requests.push(await request.json() as Record<string, unknown>);
    return Response.json({ commandId: "cmd", status: "sent", deliveryStatus: "sent" });
  } });
  try {
    const env = { LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test", LUNA_INVOCATION_ID: "inv-reply" };
    for (const purpose of ["answer", "progress", "notification"]) {
      const reply = { type: "luna.reply", version: 1, presentation: "card", content: [{ type: "image", artifactRef: "artifact:img" }] };
      const result = await runSayCli(["--purpose", purpose, "--json", "--text", JSON.stringify(reply)], env);
      expect(result.status).toBe("ok");
      expect(requests.at(-1)).toMatchObject({ to: "current", purpose, reply });
      const parsed = JSON.parse(result.output ?? "{}") as { note?: string };
      if (purpose === "answer") {
        expect(parsed.note).toContain("turn answer");
        expect(parsed.note).toContain("suppressed");
      } else {
        expect(parsed.note).toContain("LUNA_NOTHING_TO_SEND");
        expect(parsed.note).toContain("reply_current_session");
      }
    }
    const defaultProgress = await runSayCli(["--text", "hello"], env);
    expect(defaultProgress.status).toBe("ok");
    expect(JSON.parse(defaultProgress.output ?? "{}")).toMatchObject({
      note: expect.stringContaining("interim progress"),
    });
    expect(requests.at(-1)).toMatchObject({ to: "current", content: [{ type: "text", text: "hello" }] });
    const crossSession = await runSayCli(["--to", "owner", "--text", "ping"], env);
    expect(crossSession.status).toBe("ok");
    expect((JSON.parse(crossSession.output ?? "{}") as { note?: string }).note).toBeUndefined();
    expect((await runSayCli(["--json", "--text", '[{"text":"请 "},{"mention":"peer"},{"text":" 看一下"}]'], env)).status).toBe("ok");
    expect(requests.at(-1)).toMatchObject({ to: "current", purpose: "progress", reply: {
      type: "luna.reply", version: 1, presentation: "message",
      content: [{type: "text", text: "请 "}, {type: "mention", userId: "peer"}, {type: "text", text: " 看一下"}],
    } });
    expect(keys.at(-1)).toMatch(/^v2_[0-9a-f]{32}$/);
  } finally { server.stop(true); }
});

test("Feishu renders inline mentions within Markdown and escapes raw mention markup", async () => {
  const { FeishuMessageChannel } = await import("../../extensions/channels/feishu");
  const channel = new FeishuMessageChannel("test", { chatId: "room", appId: "test", appSecret: "test" });
  let sent: { msg_type: string; content: string } | undefined;
  (channel as unknown as { _client: unknown })._client = { im: { message: { create: async ({ data }: { data: typeof sent }) => {
    sent = data;
    return { code: 0, data: { message_id: "out", chat_id: "room" } };
  } } } };
  const reply = parseReply(JSON.stringify({ type: "luna.reply", version: 1, presentation: "message", content: [
    { type: "text", text: "**请 " }, { type: "mention", userId: "one" },
    { type: "text", text: " 和 " }, { type: "mention", userId: "two" },
    { type: "text", text: " 审阅** <at " }, { type: "text", text: 'user_id="all"></at>' },
  ] }));
  await channel.sendTo({ channelId: "test", surfaceId: "room" }, {
    replyMode: "channel_message", content: replyMarkdown(reply), reply, inlineMentions: ["ou_one", "ou_two"],
  });
  expect(sent?.msg_type).toBe("post");
  expect(JSON.parse(sent!.content).zh_cn.content).toEqual([[{
    tag: "md", text: '**请 <at user_id="ou_one"></at> 和 <at user_id="ou_two"></at> 审阅** &lt;at user_id="all">&lt;/at>',
  }]]);
});

test("p2p chats never @-mention or quote even after profile-less synthetic surface upserts or legacy surface_kind corruption", async () => {
  const directory = new ChannelDirectoryStore(db.db);
  directory.upsertSurface({
    channel: { type: "feishu", id: "test" },
    surface: { externalId: "room", kind: "p2p", rawProfile: { chat_mode: "p2p", chat_type: "private" } },
  });
  const scope = db.db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!;
  const identity = directory.upsertIdentity({
    channel: { type: "feishu", id: "test" },
    agentId: scope.agent_id,
    identity: { kind: "user", externalId: "ou_peer", displayName: "Peer", providerIds: { open_id: "ou_peer" } },
  });
  const peerUserId = db.db
    .select()
    .from(schema.channelUserBindings)
    .where(eq(schema.channelUserBindings.channelIdentityId, identity.id))
    .get()!.userId;
  db.db.insert(schema.messages).values({
    id: "dm-question",
    agentId: scope.agent_id,
    shadowId: scope.shadow_id,
    bindingId: scope.binding_id,
    ownerSessionId: sessionId,
    channelType: "feishu",
    channelId: "test",
    externalMessageId: "om_dm_question",
    senderUserId: peerUserId,
    role: "user",
    contentKind: "text",
    presentationKind: "plain",
    contentJson: [{ type: "text", text: "今天天气怎么样" }],
    occurredAt: 1,
    createdAt: 1,
  }).run();

  // Simulate a profile-less synthetic status-card/result surface upsert guessing "group" from non-null group_id.
  directory.upsertSurface({
    channel: { type: "feishu", id: "test" },
    surface: { externalId: "room", kind: "group" },
  });

  const storedSurface = db.db
    .select()
    .from(schema.channelSurfaces)
    .where(eq(schema.channelSurfaces.externalId, "room"))
    .get();
  expect(storedSurface?.surfaceKind).toBe("p2p");

  const { sent, service } = capture();
  answer("今天晴天，22℃。");
  await service.waitForIdle();
  expect(sent[0]?.inlineMentions).toBeUndefined();
  expect(sent[0]?.quoteMessageId).toBeUndefined();
  expect(sent[0]?.reply?.replyTo).toBeUndefined();
  expect(sent[0]?.reply?.content).toEqual([{ type: "text", text: "今天晴天，22℃。" }]);

  // Service also does not forbid Agent-chosen replyTo or inline user mentions in a p2p Feishu chat.
  finalizeRunnerReply(db.db, {
    sessionId,
    originId: "turn-2",
    actorUserId: fixtureOwnerUserId("user"),
    allowSilent: false,
    text: JSON.stringify({
      type: "luna.reply",
      version: 1,
      presentation: "message",
      replyTo: "dm-question",
      content: [
        { type: "mention", userId: peerUserId },
        { type: "text", text: " 针对你刚才那条天气提问补充一下。" },
      ],
    }),
  });
  await service.waitForIdle();
  expect(sent[1]?.quoteMessageId).toBe("om_dm_question");
  expect(sent[1]?.inlineMentions).toEqual(["ou_peer"]);

  // Simulate an older database row where surface_kind was already corrupted to "group" despite chat_mode="p2p".
  db.db
    .update(schema.channelSurfaces)
    .set({ surfaceKind: "group" })
    .where(eq(schema.channelSurfaces.externalId, "room"))
    .run();

  // Reopening DataConnection repairs legacy corrupted surface_kind rows automatically.
  db.close();
  db = new DataConnection(schema);
  const repaired = db.db
    .select()
    .from(schema.channelSurfaces)
    .where(eq(schema.channelSurfaces.externalId, "room"))
    .get();
  expect(repaired?.surfaceKind).toBe("p2p");
});

test("outbound inline mentions resolve display labels, persist message_mentions, and render legacy UUID mentions in Dashboard DTO", async () => {
  const { toDashboardSessionMessage } = await import("../../src/dashboard-api/sessions");
  const { FeishuMessageChannel } = await import("../../extensions/channels/feishu");
  const asker = groupAsker();
  const { sent, service } = capture();
  const rawReply = JSON.stringify({
    type: "luna.reply",
    version: 1,
    presentation: "message",
    content: [
      { type: "mention", userId: asker },
      { type: "text", text: "snackbar 这条线核实完了。" },
    ],
  });
  expect(answer(rawReply).kind).toBe("queued");
  // Retrying with the same unlabelled mention payload remains idempotent.
  expect(answer(rawReply).kind).toBe("existing");
  await service.waitForIdle();

  expect(sent[0]?.content).toBe("@Asker snackbar 这条线核实完了。");
  expect(sent[0]?.inlineMentions).toEqual(["ou_asker"]);

  const assistantMsg = db.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.role, "assistant"))
    .get()!;
  expect(assistantMsg.contentJson).toEqual([
    { type: "text", text: "@Asker snackbar 这条线核实完了。" },
  ]);

  const mentionRows = db.db
    .select()
    .from(schema.messageMentions)
    .where(eq(schema.messageMentions.messageId, assistantMsg.id))
    .all();
  expect(mentionRows).toHaveLength(1);
  expect(mentionRows[0]?.mentionLabel).toBe("@Asker");
  expect(mentionRows[0]?.targetExternalId).toBe("ou_asker");
  expect(mentionRows[0]?.targetIdentityId).not.toBeNull();

  // Verify Feishu also inserts a separating space when text immediately follows <at>.
  const channel = new FeishuMessageChannel("test", {
    chatId: "room",
    appId: "test",
    appSecret: "test",
  });
  let feishuSent: { msg_type: string; content: string } | undefined;
  (channel as unknown as { _client: unknown })._client = {
    im: {
      message: {
        create: async ({ data }: { data: typeof feishuSent }) => {
          feishuSent = data;
          return { code: 0, data: { message_id: "out", chat_id: "room" } };
        },
      },
    },
  };
  await channel.sendTo(
    { channelId: "test", surfaceId: "room" },
    {
      replyMode: "channel_message",
      content: sent[0]!.content,
      ...(sent[0]!.reply ? { reply: sent[0]!.reply } : {}),
      inlineMentions: ["ou_asker"],
    },
  );
  expect(JSON.parse(feishuSent!.content).zh_cn.content).toEqual([
    [{ tag: "md", text: '<at user_id="ou_asker"></at> snackbar 这条线核实完了。' }],
  ]);

  // Verify Dashboard DTO resolves both the new persisted mention and legacy @UUID assistant messages.
  const entry = db.db
    .select()
    .from(schema.sessionTimelineEntries)
    .where(eq(schema.sessionTimelineEntries.messageId, assistantMsg.id))
    .get()!;
  const dtoInput = {
    identityRows: db.db.select().from(schema.channelIdentities).all(),
    userRows: db.db.select().from(schema.users).all(),
    channelUserBindingRows: db.db.select().from(schema.channelUserBindings).all(),
    mentionRows,
    sessionRows: db.db.select().from(schema.sessions).all(),
    taskRows: [],
    sourceContextItems: [],
    turnEntryRows: [],
    replyTargetExternalIds: new Set<string>(),
    owningSessionIdForMessage: () => sessionId,
    artifactSigner: { previewUrl: () => undefined, contentUrl: () => undefined },
  };
  const persistedDto = toDashboardSessionMessage(
    { entry, row: assistantMsg },
    dtoInput,
  );
  expect(persistedDto.mentions).toHaveLength(1);
  expect(persistedDto.mentions[0]?.label).toBe("@Asker");
  expect(persistedDto.mentions[0]?.targetUser?.displayName).toBe("Asker");

  const legacyRow = {
    ...assistantMsg,
    id: "legacy-msg-id",
    contentJson: [{ type: "text", text: `@${asker}snackbar 这条线核实完了。` }],
  };
  const legacyDto = toDashboardSessionMessage(
    { entry: { ...entry, messageId: legacyRow.id }, row: legacyRow },
    { ...dtoInput, mentionRows: [] },
  );
  expect(legacyDto.content).toEqual([
    { type: "text", text: "@Asker snackbar 这条线核实完了。" },
  ]);
  expect(legacyDto.mentions).toHaveLength(1);
  expect(legacyDto.mentions[0]?.label).toBe("@Asker");
  expect(legacyDto.mentions[0]?.targetUser?.displayName).toBe("Asker");
});
