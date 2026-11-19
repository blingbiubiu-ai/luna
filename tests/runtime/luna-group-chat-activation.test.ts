import type { TestMainPlan } from "./support/main-command-plan";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { FeishuMessageChannel } from "../../extensions/channels/feishu";
import { ContextPackStore, LaunchContextBuilder } from "../../src/context";
import { SessionResolver } from "../../src/sessions/session-resolver";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionTimelineReader } from "../../src/sessions/session-timeline-reader";
import { SessionTurnStore } from "../../src/sessions/session-turn-store";
import type { InboundChannelMessage } from "../../src/sessions/types";
import type { NormalizedInboundMessage } from "../../src/channels";
import { DataConnection, type DrizzleDB } from "../../src/data";
import {
  channelIdentities,
  channelSurfaces,
  sessionInbox,
  messageMentions,
  sessionTimelineEntries,
  sessionTurns,
  sessions,
  messages,
  userIdentityLinks,
  users,
} from "../../src/data/schema";
import * as lunaSchema from "../../src/data/schema";
import type { MainRunnerRunInput } from "../../src/main-runner/main-runner";
import { MainRunner } from "../../src/main-runner/main-runner";
import type {
  MainRunnerUserMessagesInput,
} from "../../src/main-runner/types";
import { SessionStateStore } from "../../src/main-runner/session-state-store";
import { FakeFeishuChannel as BaseFakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import type { SessionConfig } from "../../src/shared";
import { setLunaHome } from "../../src/shared";
import { TaskRunSupervisor } from "../../src/tasks/task-run-supervisor";
import { ArtifactStore } from "../../src/timeline/artifact-store";
import { normalizedInboundFromDirectCallForTest } from "./support/direct-call-inbound-adapter";
import { SessionInboundRouter as BaseSessionInboundRouter } from "./support/main-command-harness";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";

let testHome: string;
let database: DataConnection<typeof lunaSchema>;

function selectTaskSourceContextItems(db: DrizzleDB = database.db) {
  return new ContextPackStore(db).listTaskSourceItems();
}

function canonicalUserIdForOpenId(openId: string): string {
  const links = database.db
    .select()
    .from(userIdentityLinks)
    .where(
      and(
        eq(userIdentityLinks.identityNamespace, "feishu"),
        eq(userIdentityLinks.identityKind, "open_id"),
        eq(userIdentityLinks.identityValue, openId),
      ),
    )
    .all();
  expect(links).toHaveLength(1);
  const userId = links[0]?.userId;
  expect(userId).toBeTruthy();
  if (!userId) {
    throw new Error(`Missing canonical user id for feishu/open_id ${openId}`);
  }
  return userId;
}

class SessionInboundRouter extends BaseSessionInboundRouter {
  async routeDirectInboundForTest(message: InboundChannelMessage): Promise<void> {
    return await this.route(normalizedInboundFromDirectCallForTest(message));
  }
}

class FakeFeishuChannel extends BaseFakeFeishuChannel {
  constructor(
    id: string,
    inbound: readonly (NormalizedInboundMessage | InboundChannelMessage)[] = [],
    options?: ConstructorParameters<typeof BaseFakeFeishuChannel>[2],
  ) {
    super(id, inbound.map(normalizeInboundForFakeFeishuTest), options);
  }

  async emitInbound(message: InboundChannelMessage): Promise<void> {
    await this.emitNormalizedInbound(normalizeInboundForFakeFeishuTest(message));
  }

  async deliver(
    message: NormalizedInboundMessage | InboundChannelMessage,
  ): Promise<void> {
    await super.deliver(normalizeInboundForFakeFeishuTest(message));
  }
}

function normalizeInboundForFakeFeishuTest(
  message: NormalizedInboundMessage | InboundChannelMessage,
): NormalizedInboundMessage {
  return "channel" in message
    ? message
    : normalizedInboundFromDirectCallForTest(message);
}

const fastSessionConfig = {
  coalesce_idle_ms: 1,
  coalesce_max_wait_ms: 25,
  max_batch_size: 8,
  max_task_actions_per_batch: 3,
  processing_notice_after_ms: 1500,
  stale_claim_ms: 120000,
  turn_warn_after_ms: 120000,
  max_queue_depth: 50,
  activation_context_window_ms: 300000,
  activation_context_max_messages: 12,
  activation_context_max_chars: 6000,
  activation_context_recent_unprocessed_messages: 10,
  activation_context_max_cc_reporters: 1,
  group_bot_aliases: [],
  group_activation_followup_window_ms: 300000,
  group_activation_followup_senders: "requester_and_reporters",
  group_activation_followup_max_messages: 8,
  group_activation_followup_recent_messages: 3,
  group_activation_followup_interrupt_on_other_user: true,
} satisfies SessionConfig;

function fakeTaskRunResult(input: { readonly taskId: string }): {
  readonly finalReportArtifactId: string;
} {
  const artifact = new ArtifactStore(database.db).create({
    taskId: input.taskId,
    type: "report",
    name: "final-report.md",
    mimeType: "text/markdown",
    content: "# Fake task report",
  });
  return { finalReportArtifactId: artifact.id };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-group-activation-test-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  fixtureSessionOwnership(database.db, "feishu", "feishu-main");
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("Luna group chat activation", () => {
  test("silent group message persists without enqueueing or processing", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(groupInbound({ id: "m_silent", text: "大家看下这个" }));
    await router.waitForIdle();

    expect(database.db.select().from(messages).all()).toHaveLength(1);
    expect(database.db.select().from(sessionInbox).all()).toHaveLength(0);
    expect(database.db.select().from(sessionTurns).all()).toMatchObject([
      {
        status: "skipped",
        runner_invoked: false,
        reason: "silent_group",
      },
    ]);
    expect(runner.calls).toHaveLength(0);
    expect(channel.outbound).toHaveLength(0);
    expect(channel.beginProcessingCalls).toHaveLength(0);
    expect(channel.completeProcessingCalls).toHaveLength(0);
  });

  test("inbound messages upsert channel user and chat directory records", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_directory_first",
        text: "@Luna 帮我看下",
        senderUserId: "ou_sender_1",
        addressing: { addressedToBot: true, reason: "mention" },
        senderProfile: {
          externalUserId: "ou_sender_1",
          openId: "ou_sender_1",
          userId: "user_sender_1",
          unionId: "on_sender_1",
          name: "示例用户",
          displayName: "示例用户",
          avatarUrl: "https://avatar.example/u1.png",
          tenantKey: "tenant-1",
        },
        chatProfile: {
          externalChatId: "group-alpha",
          name: "Luna 测试群",
          displayName: "Luna 测试群",
          chatType: "group",
          avatarUrl: "https://avatar.example/group.png",
          tenantKey: "tenant-1",
        },
      }),
    );
    await router.waitForIdle();

    expect(database.db.select().from(channelIdentities).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelType: "feishu",
          channelId: "feishu-main",
          externalId: "ou_sender_1",
          identityKind: "user",
          displayName: "示例用户",
          avatarUrl: "https://avatar.example/u1.png",
          providerIdsJson:
            '{"open_id":"ou_sender_1","user_id":"user_sender_1","union_id":"on_sender_1","tenant_key":"tenant-1"}',
        }),
      ]),
    );
    expect(database.db.select().from(channelSurfaces).all()).toMatchObject([
      {
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "group-alpha",
        displayName: "Luna 测试群",
        surfaceKind: "group",
        avatarUrl: "https://avatar.example/group.png",
        providerIdsJson: '{"tenant_key":"tenant-1"}',
      },
    ]);
    const canonicalUsers = database.db.select().from(users).all();
    expect(canonicalUsers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "human",
          displayName: "示例用户",
          avatarUrl: "https://avatar.example/u1.png",
        }),
        expect.objectContaining({
          kind: "bot",
          displayName: "Luna",
        }),
      ]),
    );
    const humanUser = canonicalUsers.find((user) => user.displayName === "示例用户");
    const botUser = canonicalUsers.find((user) => user.kind === "bot");
    expect(humanUser).toBeDefined();
    expect(botUser).toBeDefined();
    expect(database.db.select().from(userIdentityLinks).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: humanUser?.id,
          identityNamespace: "feishu",
          identityKind: "open_id",
          identityValue: "ou_sender_1",
          identityScope: "app:test:feishu-main",
        }),
        expect.objectContaining({
          userId: humanUser?.id,
          identityNamespace: "feishu",
          identityKind: "user_id",
          identityValue: "user_sender_1",
          identityScope: "tenant:tenant-1",
        }),
      ]),
    );
  });

  test("chat profile external id is persisted without group id", async () => {
    fixtureSessionOwnership(database.db, "generic", "generic-main");
    const channel = new RecordingProcessingChannel("generic-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest({
      id: "m_directory_chat_only",
      channelType: "generic",
      channelId: "generic-main",
      senderUserId: "external-user-1",
      text: "hello",
      chatType: "group",
      addressing: { addressedToBot: true, reason: "mention" },
      chatProfile: {
        externalChatId: "room-1",
        name: "Generic Room",
        displayName: "Generic Room",
        chatType: "room",
      },
    });
    await router.waitForIdle();

    expect(database.db.select().from(channelSurfaces).all()).toMatchObject([
      {
        channelType: "generic",
        channelId: "generic-main",
        externalId: "room-1",
        displayName: "Generic Room",
        surfaceKind: "unknown",
      },
    ]);
  });

  test("direct inbound adapter persists rendered mention text and structured target", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_rendered_mention",
        text: "@_user_1 在吗",
        addressing: { addressedToBot: true, reason: "mention" },
        mentions: [
          {
            key: "@_user_1",
            name: "Luna",
            openId: "ou_bot",
            mentionedType: "bot",
          },
        ],
      }),
    );
    await router.waitForIdle();

    const stored = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "m_rendered_mention"))
      .get();
    expect(stored).toBeDefined();
    const textContent = messageTextContent(stored?.contentJson);
    expect(textContent).toBe("@Luna 在吗");
    expect(textContent).not.toContain("@_user_1");

    expect(database.db.select().from(messageMentions).all()).toEqual([
      expect.objectContaining({
        messageId: stored?.id,
        mentionKey: "@_user_1",
        mentionLabel: "@Luna",
        targetExternalId: "ou_bot",
        targetKind: "bot",
        targetIdentityId: expect.any(String),
      }),
    ]);

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_rendered_mention",
        text: "@_user_1 在吗",
        addressing: { addressedToBot: true, reason: "mention" },
        mentions: [
          {
            key: "@_user_1",
            name: "Luna",
            openId: "ou_bot",
            mentionedType: "bot",
          },
        ],
      }),
    );
    await router.waitForIdle();

    expect(database.db.select().from(messageMentions).all()).toHaveLength(1);
  });

  test("direct inbound adapter renders overlapping mention keys safely", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_overlapping_mentions",
        text: "@_user_10 和 @_user_1 在吗",
        addressing: { addressedToBot: true, reason: "mention" },
        mentions: [
          {
            key: "@_user_1",
            name: "Luna",
            openId: "ou_bot",
            mentionedType: "bot",
          },
          {
            key: "@_user_10",
            name: "Reporter",
            openId: "ou_reporter",
            mentionedType: "user",
          },
        ],
      }),
    );
    await router.waitForIdle();

    const stored = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "m_overlapping_mentions"))
      .get();
    const textContent = messageTextContent(stored?.contentJson);
    expect(textContent).toBe("@Reporter 和 @Luna 在吗");
    expect(textContent).not.toContain("@Luna0");
    expect(textContent).not.toContain("@_user_");
  });

  test("direct inbound adapter does not re-render inserted mention labels", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_label_overlaps_key",
        text: "@_user_10 和 @_user_1 在吗",
        addressing: { addressedToBot: true, reason: "mention" },
        mentions: [
          {
            key: "@_user_1",
            name: "Luna",
            openId: "ou_bot",
            mentionedType: "bot",
          },
          {
            key: "@_user_10",
            name: "_user_1",
            openId: "ou_reporter",
            mentionedType: "user",
          },
        ],
      }),
    );
    await router.waitForIdle();

    const stored = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "m_label_overlaps_key"))
      .get();
    const textContent = messageTextContent(stored?.contentJson);
    expect(textContent).toBe("@_user_1 和 @Luna 在吗");
    expect(textContent).not.toBe("@Luna 和 @Luna 在吗");
  });

  test("an Agent that turns off the received reaction still answers, without the reaction", async () => {
    const agent = database.db.select().from(lunaSchema.lunaAgents).get()!;
    database.db.insert(lunaSchema.agentSettings).values({ agentId: agent.id, settings: { inbound: { processingReaction: false } },
      updatedByAccountId: agent.ownerAccountId, updatedAt: 1 }).run();
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db, channel, runnerType: "mock", mainRunner: runner.asMainRunner(), sessionConfig: fastSessionConfig,
    });
    await router.routeDirectInboundForTest(groupInbound({
      id: "m_no_reaction", text: "@Luna 帮我看下", addressing: { addressedToBot: true, reason: "mention" },
    }));
    await router.waitForIdle();
    expect(runner.calls).toHaveLength(1);
    expect(channel.beginProcessingCalls).toEqual([]);
    expect(channel.outbound).toHaveLength(1);
  });

  test("addressed group message enqueues and runs", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_addressed",
        text: "@Luna 帮我看下",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(channel.beginProcessingCalls).toEqual(["m_addressed"]);
    expect(channel.completeProcessingCalls).toEqual(["m_addressed"]);
    expect(channel.outbound).toHaveLength(1);
    expect(database.db.select().from(sessionInbox).all()).toMatchObject([
      { status: "completed" },
    ]);
    expect(database.db.select().from(sessionTurns).all()).toMatchObject([
      { status: "completed" },
    ]);
  });


  test("Feishu mention inbound enables same requester follow-up without mention", async () => {
    const channel = new FeishuMessageChannel("feishu-main", {
      chatId: "oc_chat_1",
      appId: "cli_0000000000000000",
      appSecret: "app-secret",
      botOpenId: "ou_bot",
    });
    const replyMessageIds: string[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async reply(input: { path: { message_id: string } }): Promise<unknown> {
            const messageId = `reply-${replyMessageIds.length + 1}`;
            replyMessageIds.push(input.path.message_id);
            return { data: { message_id: messageId, thread_key: `thread-${messageId}` } };
          },
        },
        v1: {
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-1" } };
            },
            async delete(): Promise<void> {
              return undefined;
            },
          },
        },
      },
    };
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    await channel.subscribeInbound(async (message) => {
      await router.route(message);
    });

    await emitFeishuReceive(channel, {
      messageId: "om_feishu_anchor",
      text: "@_user_1 帮忙看看",
      senderOpenId: "ou_user_a",
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          mentioned_type: "bot",
          name: "Luna",
        },
      ],
    });
    await router.waitForIdle();
    expect(database.db.select().from(messageMentions).all()).toMatchObject([
      {
        mentionKey: "@_user_1",
        mentionLabel: "@Luna",
        targetExternalId: "ou_bot",
        targetKind: "bot",
      },
    ]);
    const anchorMessage = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "om_feishu_anchor"))
      .get();
    expect(messageTextContent(anchorMessage?.contentJson)).toBe("@Luna 帮忙看看");
    expect(messageTextContent(anchorMessage?.contentJson)).not.toContain("@_user_1");
    await emitFeishuReceive(channel, {
      messageId: "om_feishu_followup",
      text: "补充 did=123",
      senderOpenId: "ou_user_a",
    });
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(userMessagesInput(runner).latestMessage.addressing).toEqual({
      addressedToBot: true,
      reason: "activation_followup",
    });
    expect(database.db.select().from(lunaSchema.sessionCommands).all()).toHaveLength(2);
  });

  test("Feishu inbound persists resolved user and chat profile names", async () => {
    const channel = new FeishuMessageChannel("feishu-main", {
      chatId: "oc_chat_1",
      appId: "cli_0000000000000000",
      appSecret: "app-secret",
      botOpenId: "ou_bot",
    });
    (channel as unknown as { _client: unknown })._client = {
      contact: {
        v3: {
          user: {
            async get(input: {
              path: { user_id: string };
              params: { user_id_type: string };
            }): Promise<unknown> {
              expect(input).toMatchObject({
                path: { user_id: "ou_user_named" },
                params: { user_id_type: "open_id" },
              });
              return {
                data: {
                  user: {
                    open_id: "ou_user_named",
                    user_id: "user_named",
                    union_id: "on_user_named",
                    name: "示例用户",
                    avatar: { avatar_72: "https://avatar.example/user.png" },
                  },
                },
              };
            },
          },
        },
      },
      im: {
        message: {
          async reply(): Promise<unknown> {
            return { data: { message_id: "reply-profile", thread_key: "thread-profile" } };
          },
        },
        v1: {
          chat: {
            async get(input: { path: { chat_id: string } }): Promise<unknown> {
              expect(input).toMatchObject({ path: { chat_id: "oc_chat_1" } });
              return {
                data: {
                  name: "Luna 测试群",
                  avatar: "https://avatar.example/chat.png",
                },
              };
            },
          },
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-profile" } };
            },
            async delete(): Promise<void> {
              return undefined;
            },
          },
        },
      },
    };
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    await channel.subscribeInbound(async (message) => {
      await router.route(message);
    });

    await emitFeishuReceive(channel, {
      messageId: "om_feishu_profile",
      text: "@_user_1 帮忙看看",
      senderOpenId: "ou_user_named",
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Luna",
        },
      ],
    });
    await router.waitForIdle();

    const userRows = database.db.select().from(channelIdentities).all();
    expect(userRows).toContainEqual(
      expect.objectContaining({
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "ou_user_named",
        identityKind: "user",
        providerIdsJson:
          '{"open_id":"ou_user_named","user_id":"user_named","union_id":"on_user_named"}',
        displayName: "示例用户",
        avatarUrl: "https://avatar.example/user.png",
      }),
    );
    expect(userRows).toContainEqual(
      expect.objectContaining({
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "ou_bot",
        identityKind: "bot",
        providerIdsJson: '{"open_id":"ou_bot"}',
        displayName: null,
      }),
    );
    expect(database.db.select().from(channelSurfaces).all()).toMatchObject([
      {
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "oc_chat_1",
        displayName: "Luna 测试群",
        avatarUrl: "https://avatar.example/chat.png",
      },
    ]);
  });

  test("activation follow-up messages enter Main Runner quietly even when not addressed to Luna", async () => {
    const channel = new FeishuMessageChannel("feishu-main", {
      chatId: "oc_chat_1",
      appId: "cli_0000000000000000",
      appSecret: "app-secret",
      botOpenId: "ou_luna_bot",
    });
    const replyMessageIds: string[] = [];
    const reactionCreateMessageIds: string[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async reply(input: { path: { message_id: string } }): Promise<unknown> {
            replyMessageIds.push(input.path.message_id);
            return {
              data: {
                message_id: `reply-${replyMessageIds.length}`,
                thread_key: `thread-reply-${replyMessageIds.length}`,
              },
            };
          },
        },
        v1: {
          messageReaction: {
            async create(input: { path: { message_id: string } }): Promise<unknown> {
              reactionCreateMessageIds.push(input.path.message_id);
              return {
                data: { reaction_id: `reaction-${reactionCreateMessageIds.length}` },
              };
            },
            async delete(): Promise<void> {
              return undefined;
            },
          },
        },
      },
    };
    const quietFollowupIds = new Set([
      "om_feishu_quiet_candidate_plain",
      "om_feishu_quiet_candidate_person",
      "om_feishu_quiet_candidate_other_bot",
    ]);
    const runner = new DynamicMainRunner((input) => {
      if (
        input.input.type === "user_messages" &&
        quietFollowupIds.has(input.input.latestMessage.id)
      ) {
        return {
          operation: "completion",
          reason: "activation follow-up is not relevant to Luna",
        };
      }
      return replyNormal();
    });
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    await channel.subscribeInbound(async (message) => {
      await router.route(message);
    });

    await emitFeishuReceive(channel, {
      messageId: "om_feishu_quiet_anchor",
      text: "@_user_1 早上好",
      senderOpenId: "ou_user_a",
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_luna_bot" },
          mentioned_type: "bot",
          name: "Luna",
        },
      ],
    });
    await router.waitForIdle();

    const candidates = [
      {
        messageId: "om_feishu_quiet_candidate_plain",
        text: "我先看看其他信息",
        mentions: undefined,
      },
      {
        messageId: "om_feishu_quiet_candidate_person",
        text: "@_user_2 你看下这个",
        mentions: [
          {
            key: "@_user_2",
            id: { open_id: "ou_user_b" },
            mentioned_type: "user",
            name: "同事 B",
          },
        ],
      },
      {
        messageId: "om_feishu_quiet_candidate_other_bot",
        text: "@_user_3 你在干嘛呢",
        mentions: [
          {
            key: "@_user_3",
            id: { open_id: "ou_aime_bot" },
            mentioned_type: "bot",
            name: "Aime 个人助理",
          },
        ],
      },
    ] as const;

    for (const candidate of candidates) {
      await emitFeishuReceive(channel, {
        messageId: candidate.messageId,
        text: candidate.text,
        senderOpenId: "ou_user_a",
        ...(candidate.mentions !== undefined
          ? { mentions: candidate.mentions }
          : {}),
      });
      await router.waitForIdle();
    }

    const followupInputs = runner.calls
      .map((call) => call.input)
      .filter(
        (input): input is MainRunnerUserMessagesInput =>
          input.type === "user_messages" &&
          quietFollowupIds.has(input.latestMessage.id),
      );
    expect(followupInputs.map((input) => input.latestMessage.id)).toEqual(
      candidates.map((candidate) => candidate.messageId),
    );
    expect(
      followupInputs.map((input) => input.latestMessage.addressing),
    ).toEqual(
      candidates.map(() => ({
        addressedToBot: true,
        reason: "activation_followup",
      })),
    );
    expect(runner.calls).toHaveLength(4);
    expect(reactionCreateMessageIds).toEqual(["om_feishu_quiet_anchor"]);
  });

  test("batched quiet activation follow-ups can complete without a batch card", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner((input) => {
      if (input.input.type !== "user_messages" || input.input.latestMessage.addressing.reason !== "activation_followup") {
        return replyNormal();
      }
      expect(input.input.messages.map((message) => message.channelMessageKey)).toEqual([
        "m_quiet_batch_1",
        "m_quiet_batch_2",
      ]);
      expect(input.input.latestMessage.addressing).toEqual({
        addressedToBot: true,
        reason: "activation_followup",
      });
      return {
        operation: "completion",
        reason: "batched activation follow-ups are unrelated to Luna",
      };
    });
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        coalesce_idle_ms: 50,
        coalesce_max_wait_ms: 200,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_quiet_batch_anchor",
        text: "@Luna 帮忙看看",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_quiet_batch_1",
        text: "我先问下同事",
        senderUserId: "user-a",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_quiet_batch_2",
        text: "@同事 你在吗",
        senderUserId: "user-a",
        mentions: [
          {
            key: "@同事",
            openId: "ou_user_b",
            mentionedType: "user",
            name: "同事",
          },
        ],
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(channel.beginProcessingCalls).toEqual(["m_quiet_batch_anchor"]);
    expect(channel.outbound).toHaveLength(1);
  });

  test("focus-shifted completion interrupts later activation follow-ups until a new explicit activation", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner((input) =>
      input.input.type === "user_messages" &&
        input.input.latestMessage.id === "m_focus_shift_candidate"
        ? {
            operation: "completion",
            followupReleased: true,
            reason: "latest message explicitly addressed Aime",
          }
        : replyNormal()
    );
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_focus_shift_anchor",
        text: "@Luna 帮我查一下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_focus_shift_candidate",
        text: "@Aime 你也查一下",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_after_focus_shift",
        text: "你不知道吗",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(() =>
      userMessagesInputForLatestMessage(runner, "m_after_focus_shift"),
    ).toThrow("Expected Main Runner call for latest message m_after_focus_shift.");
    expect(sessionConversationControlEvents()).toMatchObject([
      expect.objectContaining({
        eventType: "conversation_control",
        controlKind: "followup_interrupted",
        reasonKind: "focus_shifted",
      }),
    ]);
  });

  test("generic completion does not interrupt activation follow-up", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner((input) =>
      input.input.type === "user_messages" &&
        input.input.latestMessage.id === "m_generic_completion_candidate"
        ? {
            operation: "completion",
            reason: "weakly related to Luna",
          }
        : replyNormal()
    );
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_generic_completion_anchor",
        text: "@Luna 帮我查一下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_generic_completion_candidate",
        text: "我先看看",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_generic_completion_later",
        text: "深圳的",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(userMessagesInputForLatestMessage(
      runner,
      "m_generic_completion_later",
    ).latestMessage.addressing).toEqual({
      addressedToBot: true,
      reason: "activation_followup",
    });
    expect(sessionConversationControlEvents()).toHaveLength(0);
  });

  test("requester follow-up without mention resolves from durable activation session", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_anchor",
        text: "@Luna 帮忙看下这个问题",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_requester",
        text: "did 是 4453477614363128",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    const latest = userMessagesInput(runner);
    expect(latest.latestMessage.addressing).toEqual({
      addressedToBot: true,
      reason: "activation_followup",
    });
    expect(latest.requesterUserId).toBe(canonicalUserIdForOpenId("user-a"));
    expect(latest.activationSourceMessage).toMatchObject({
      channelMessageKey: "m_followup_anchor",
      text: "@Luna 帮忙看下这个问题",
    });
    expect(
      database.db
        .select()
        .from(messages)
        .all()
        .find((row) => row.externalMessageId === "m_followup_requester")
        ?.rawPayloadJson,
    ).toMatchObject({
      addressing: { addressedToBot: true, reason: "activation_followup" },
    });
    expect(channel.beginProcessingCalls).toEqual(["m_followup_anchor"]);
  });

  test("no-mention group message without active activation session stays silent", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_no_session",
        text: "did 是 4453477614363128",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(0);
    expect(channel.beginProcessingCalls).toHaveLength(0);
    expect(database.db.select().from(sessionInbox).all()).toHaveLength(0);
  });

  test("group activation follow-up is disabled when window is zero", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        group_activation_followup_window_ms: 0,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_disabled_anchor",
        text: "@Luna 先看这个",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_disabled_candidate",
        text: "补充 did=123",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(channel.beginProcessingCalls).toEqual(["m_followup_disabled_anchor"]);
  });


  test("group activation follow-up stops after configured max follow-ups", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        group_activation_followup_max_messages: 1,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_max_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_max_1",
        text: "第一条补充",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_max_2",
        text: "第二条补充",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(channel.beginProcessingCalls).toEqual(["m_followup_max_anchor"]);
  });

  test("group activation follow-up can use recent message fallback after time window expires", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        group_activation_followup_window_ms: 1,
        group_activation_followup_recent_messages: 3,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_recent_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    database.db
      .update(messages)
      .set({ occurredAt: Date.now() - 10, createdAt: Date.now() - 10 })
      .where(eq(messages.externalMessageId, "m_followup_recent_anchor"))
      .run();

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_recent_candidate",
        text: "过期但仍是最近补充",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(userMessagesInput(runner).latestMessage.addressing?.reason).toBe(
      "activation_followup",
    );
    expect(channel.beginProcessingCalls).toEqual(["m_followup_recent_anchor"]);
  });

  test("group activation follow-up keeps time-window behavior when another user interjects", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_interrupt_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_interrupt_other",
        text: "我插一句别的",
        senderUserId: "user-b",
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_interrupt_candidate",
        text: "这是 A 的后续补充",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(userMessagesInput(runner).latestMessage.addressing?.reason).toBe(
      "activation_followup",
    );
    expect(channel.beginProcessingCalls).toEqual(["m_followup_interrupt_anchor"]);
  });

  test("group activation follow-up recent fallback is interrupted by another ordinary user", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        group_activation_followup_window_ms: 1,
        group_activation_followup_recent_messages: 3,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_recent_interrupt_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    database.db
      .update(messages)
      .set({ occurredAt: Date.now() - 10, createdAt: Date.now() - 10 })
      .where(eq(messages.externalMessageId, "m_followup_recent_interrupt_anchor"))
      .run();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_recent_interrupt_other",
        text: "我插一句别的",
        senderUserId: "user-b",
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_recent_interrupt_candidate",
        text: "这是 A 的过期后续补充",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(channel.beginProcessingCalls).toEqual([
      "m_followup_recent_interrupt_anchor",
    ]);
  });

  test("default follow-up policy rejects unrelated group senders", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_default_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_default_other",
        text: "我是 C，路过说一句",
        senderUserId: "user-c",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(channel.beginProcessingCalls).toEqual(["m_followup_default_anchor"]);
    expect(database.db.select().from(sessionInbox).all()).toHaveLength(1);
  });

  test("requester-only follow-up policy rejects other group senders", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        group_activation_followup_senders: "requester_only",
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_policy_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_policy_other",
        text: "我是 B，补充一下",
        senderUserId: "user-b",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(channel.beginProcessingCalls).toEqual(["m_followup_policy_anchor"]);
  });

  test("group activation follow-up expires after configured window", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        group_activation_followup_window_ms: 1,
        group_activation_followup_recent_messages: 0,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_expire_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    database.db
      .update(messages)
      .set({ occurredAt: Date.now() - 10, createdAt: Date.now() - 10 })
      .where(eq(messages.externalMessageId, "m_followup_expire_anchor"))
      .run();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_expire_candidate",
        text: "过期后的补充",
        senderUserId: "user-a",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(channel.beginProcessingCalls).toEqual(["m_followup_expire_anchor"]);
  });

  test("activation follow-up session survives router recreation", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const firstRouter = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await firstRouter.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_restart_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await firstRouter.waitForIdle();

    const secondRouter = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    await secondRouter.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_restart_candidate",
        text: "重启后补充 did=123",
        senderUserId: "user-a",
      }),
    );
    await secondRouter.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(userMessagesInput(runner).latestMessage.addressing?.reason).toBe(
      "activation_followup",
    );
  });

  test("accepted activation follow-ups coalesce like ordinary queued messages", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        coalesce_idle_ms: 20,
        coalesce_max_wait_ms: 100,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_batch_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    await Promise.all([
      router.routeDirectInboundForTest(
        groupInbound({
          id: "m_followup_batch_1",
          text: "补充 1",
          senderUserId: "user-a",
        }),
      ),
      router.routeDirectInboundForTest(
        groupInbound({
          id: "m_followup_batch_2",
          text: "补充 2",
          senderUserId: "user-a",
        }),
      ),
    ]);
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(
      userMessagesInput(runner).messages.map(
        (message) => message.channelMessageKey,
      ),
    ).toEqual(["m_followup_batch_1", "m_followup_batch_2"]);
  });

  test("activation context includes prior silent user message for addressed group mention", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_silent_a",
        text: "广州天气怎么样",
        senderUserId: "user-a",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_addressed_b",
        text: "@Luna 处理一下",
        senderUserId: "user-b",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    const input = userMessagesInput(runner);
    expect(input.requesterUserId).toBe(canonicalUserIdForOpenId("user-b"));
    expect(input.activationContextMessages).toBeUndefined();
    expect((input.context as { readonly recentMessages?: unknown }).recentMessages).toBeUndefined();
    expect(
      (input.context as { readonly deltaContext?: { readonly items: readonly { readonly messageId?: string; readonly text: string }[] } })
        .deltaContext?.items.map((item) => item.text),
    ).toEqual(["广州天气怎么样"]);
    const activationPacks = database.db
      .select({ pack: lunaSchema.contextPacks, item: lunaSchema.contextPackItems })
      .from(lunaSchema.contextPackItems)
      .innerJoin(
        lunaSchema.contextPacks,
        eq(lunaSchema.contextPacks.id, lunaSchema.contextPackItems.contextPackId),
      )
      .where(eq(lunaSchema.contextPacks.kind, "group_activation"))
      .all();
    expect(activationPacks).toMatchObject([
      {
        pack: expect.objectContaining({
          ownerType: "session",
          ownerId: expect.any(String),
          kind: "group_activation",
          selectionStrategy: "deterministic_window",
          triggerMessageId: input.messages[0]?.messageId,
        }),
        item: expect.objectContaining({
          role: "delta_context",
          sourceMessageId: deltaContextItems(input)[0]?.messageId,
          displayOrder: 0,
        }),
      },
    ]);
    const contextTurnEntries = database.db
      .select({ turn: lunaSchema.sessionTurns, entry: lunaSchema.sessionTurnEntries })
      .from(lunaSchema.sessionTurnEntries)
      .innerJoin(
        lunaSchema.sessionTurns,
        eq(lunaSchema.sessionTurns.id, lunaSchema.sessionTurnEntries.turn_id),
      )
      .where(eq(lunaSchema.sessionTurnEntries.role, "context"))
      .all();
    expect(contextTurnEntries).toHaveLength(1);
    expect(contextTurnEntries[0]?.turn.runner_invoked).toBe(true);
  });

  test("addressed group mention falls back to older session history when the window is empty", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        activation_context_window_ms: 300_000,
        group_activation_followup_recent_messages: 3,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_old_1",
        text: "历史消息 1",
        senderUserId: "user-a",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_old_2",
        text: "历史消息 2",
        senderUserId: "user-b",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_old_3",
        text: "历史消息 3",
        senderUserId: "user-c",
      }),
    );
    const historicalBase = Date.now() - 6 * 60 * 60 * 1000;
    database.db
      .update(messages)
      .set({ occurredAt: historicalBase + 1_000, createdAt: historicalBase + 1_000 })
      .where(eq(messages.externalMessageId, "m_context_old_1"))
      .run();
    database.db
      .update(messages)
      .set({ occurredAt: historicalBase + 2_000, createdAt: historicalBase + 2_000 })
      .where(eq(messages.externalMessageId, "m_context_old_2"))
      .run();
    database.db
      .update(messages)
      .set({ occurredAt: historicalBase + 3_000, createdAt: historicalBase + 3_000 })
      .where(eq(messages.externalMessageId, "m_context_old_3"))
      .run();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_fallback_trigger",
        text: "@Luna 处理一下",
        senderUserId: "user-d",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    const input = userMessagesInput(runner);
    expect(input.requesterUserId).toBe(canonicalUserIdForOpenId("user-d"));
    expect(input.activationContextMessages).toBeUndefined();
    expect(deltaContextItems(input).map((item) => item.text)).toEqual([
      "历史消息 1",
      "历史消息 2",
      "历史消息 3",
    ]);
  });

  test("activation context excludes user messages already sent to Main Runner in prior turns", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_once_silent",
        text: "先查深圳明天的天气",
        senderUserId: "user-a",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_once_first_trigger",
        text: "@Luna 帮忙查一下",
        senderUserId: "user-b",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    expect(deltaContextItems(userMessagesInputForLatestMessage(
      runner,
      "m_context_once_first_trigger",
    )).map((item) => item.text)).toEqual(["先查深圳明天的天气"]);

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_once_second_trigger",
        text: "@Luna 再说一遍",
        senderUserId: "user-c",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    const secondInput = userMessagesInputForLatestMessage(
      runner,
      "m_context_once_second_trigger",
    );
    expect(secondInput.activationContextMessages).toBeUndefined();
    expect(secondInput.context.deltaContext).toBeUndefined();
  });

  test("activation context respects max messages, char budget, and thread surface", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        activation_context_max_messages: 2,
        activation_context_max_chars: 16,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_root",
        text: "root message",
        senderUserId: "root-user",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_thread_long",
        text: "this thread message is too long",
        threadId: "thread-context",
        rootMessageId: "m_context_root",
        senderUserId: "thread-user-0",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_thread_short_1",
        text: "短消息一",
        threadId: "thread-context",
        rootMessageId: "m_context_root",
        senderUserId: "thread-user-1",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_thread_short_2",
        text: "短消息二",
        threadId: "thread-context",
        rootMessageId: "m_context_root",
        senderUserId: "thread-user-2",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_thread_trigger",
        text: "@Luna 处理线程",
        threadId: "thread-context",
        rootMessageId: "m_context_root",
        senderUserId: "thread-requester",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    const input = userMessagesInput(runner);
    const deltaContextTexts = deltaContextItems(input).map((item) => item.text);
    expect(input.activationContextMessages).toBeUndefined();
    expect(deltaContextTexts).toEqual(["短消息一", "短消息二"]);
    expect(
      deltaContextTexts.reduce((total, text) => total + text.length, 0),
    ).toBeLessThanOrEqual(16);
    expect(deltaContextTexts).not.toContain("root message");
  });

  test("thread activation includes root anchor and thread starter context", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_thread_anchor",
        text: "锚点问题：视频打不开",
        senderUserId: "anchor-user",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_thread_starter",
        text: "reply in thread：did=4453477614363128",
        rootMessageId: "m_thread_anchor",
        senderUserId: "thread-starter-user",
        rawPayload: {
          message: {
            message_id: "m_thread_starter",
            root_id: "m_thread_anchor",
            parent_id: "m_thread_anchor",
          },
        },
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_thread_request",
        text: "@Luna 处理一下",
        threadId: "thread-created-after-starter",
        rootMessageId: "m_thread_anchor",
        senderUserId: "requester-user",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    const input = userMessagesInput(runner);
    expect(input.activationContextMessages).toBeUndefined();
    expect(deltaContextItems(input).map((item) => item.text)).toEqual([
      "锚点问题：视频打不开",
    ]);
    expect(input.context.launchSeed?.items.map((item) => item.text)).toContain(
      "锚点问题：视频打不开",
    );
    expect(input.messages.map((message) => message.text)).toContain(
      "@Luna 处理一下",
    );
  });

  test("thread session references root anchor without moving ownership", async () => {
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const rootSession = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
    });
    const rootMessage = messageStore.append({
      sessionId: rootSession.id,
      channelMessageKey: "m_root_image",
      senderUserId: "reporter-user",
      role: "user",
      content: { text: "这张图上传后打不开" },
      rawPayload: null,
    });

    const threadSession = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
      threadId: "thread-for-root-image",
      rootMessageId: "m_root_image",
    });
    messageStore.append({
      sessionId: threadSession.id,
      channelMessageKey: "m_thread_trigger",
      senderUserId: "requester-user",
      role: "user",
      content: { text: "@Luna 看下这个图的问题" },
      rawPayload: null,
    });

    expect(rootSession).toBeDefined();
    expect(threadSession).toMatchObject({
      thread_key: "thread-for-root-image",
      root_message_key: "m_root_image",
    });

    const timeline = new SessionTimelineReader(database.db);
    const rootItems = timeline.listForSession(rootSession!.id);
    const threadItems = timeline.listForSession(threadSession!.id);

    expect(rootItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "message" }),
          message: expect.objectContaining({ externalMessageId: "m_root_image" }),
        }),
      ]),
    );
    expect(threadItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "reference" }),
          message: expect.objectContaining({ externalMessageId: "m_root_image" }),
        }),
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "message" }),
          message: expect.objectContaining({ externalMessageId: "m_thread_trigger" }),
        }),
      ]),
    );
    const threadLaunchPacks = database.db
      .select({ pack: lunaSchema.contextPacks, item: lunaSchema.contextPackItems })
      .from(lunaSchema.contextPackItems)
      .innerJoin(
        lunaSchema.contextPacks,
        eq(lunaSchema.contextPacks.id, lunaSchema.contextPackItems.contextPackId),
      )
      .where(eq(lunaSchema.contextPacks.kind, "thread_launch"))
      .all();
    expect(threadLaunchPacks).toMatchObject([
      {
        pack: expect.objectContaining({
          ownerType: "session",
          ownerId: threadSession.id,
          kind: "thread_launch",
          selectionStrategy: "deterministic_window",
          triggerMessageId: rootMessage.id,
        }),
        item: expect.objectContaining({
          role: "seed",
          sourceSessionId: rootSession.id,
          sourceMessageId: rootMessage.id,
          displayOrder: 0,
        }),
      },
    ]);
  });

  test("thread root redelivery keeps only the root reference entry", async () => {
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const rootSession = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
    });
    const rootMessage = messageStore.append({
      sessionId: rootSession.id,
      channelMessageKey: "m_redelivered_root",
      senderUserId: "reporter-user",
      role: "user",
      content: { text: "root copy" },
      rawPayload: null,
    });

    const router = new SessionInboundRouter({
      db: database.db,
      channel: new RecordingProcessingChannel("feishu-main"),
      runnerType: "mock",
      mainRunner: new DynamicMainRunner(() => replyNormal()).asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(groupInbound({
      id: "m_redelivered_root",
      text: "richer redelivered root copy",
      threadId: "thread-for-redelivered-root",
      rootMessageId: "m_redelivered_root",
      senderUserId: "reporter-user",
      rawPayload: {
        message: {
          message_id: "m_redelivered_root",
          root_id: "m_redelivered_root",
        },
      },
    }));
    await router.waitForIdle();

    const threadSession = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
      threadId: "thread-for-redelivered-root",
      rootMessageId: "m_redelivered_root",
    });

    const threadRootEntries = new SessionTimelineReader(database.db)
      .listForSession(threadSession.id)
      .filter((item) => item.message.id === rootMessage.id);

    expect(threadRootEntries).toHaveLength(1);
    expect(threadRootEntries[0]).toEqual(
      expect.objectContaining({
        entry: expect.objectContaining({ entryKind: "reference" }),
        message: expect.objectContaining({
          externalMessageId: "m_redelivered_root",
        }),
      }),
    );
  });

  test("thread_launch prefers recent thread messages and supplements from root up to the activation budget", async () => {
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const rootSession = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
    });
    const threadSession = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
      threadId: "thread-alpha",
      rootMessageId: "om_root_alpha",
      createThreadLaunchContext: false,
    });

    const root = messageStore.append({
      sessionId: rootSession.id,
      channelMessageKey: "om_root_alpha",
      senderUserId: "user-a",
      role: "user",
      content: { text: "root anchor" },
      rawPayload: null,
      createdAt: 1_720_000_000_000,
    });
    const threadA = messageStore.append({
      sessionId: threadSession.id,
      channelMessageKey: "om_thread_1",
      senderUserId: "user-a",
      role: "user",
      content: { text: "thread one" },
      rawPayload: null,
      createdAt: 1_720_000_000_100,
    });
    const threadB = messageStore.append({
      sessionId: threadSession.id,
      channelMessageKey: "om_thread_2",
      senderUserId: "user-b",
      role: "user",
      content: { text: "thread two" },
      rawPayload: null,
      createdAt: 1_720_000_000_200,
    });

    const pack = new LaunchContextBuilder(database.db).buildForThreadSession({
      threadSessionId: threadSession.id,
      rootSessionId: rootSession.id,
      anchorExternalMessageId: "om_root_alpha",
      maxMessages: 3,
      maxChars: 6000,
    });

    expect(pack).toBeDefined();
    const items = new ContextPackStore(database.db).listItemsForPack(pack!.id);
    expect(items.map((item) => item.sourceMessageId)).toEqual([
      threadA.id,
      threadB.id,
      root.id,
    ]);
    expect(
      database.db
        .select()
        .from(sessionTimelineEntries)
        .where(eq(sessionTimelineEntries.sessionId, threadSession.id))
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: root.id,
          entryKind: "reference",
        }),
        expect.objectContaining({
          messageId: threadA.id,
          entryKind: "message",
        }),
        expect.objectContaining({
          messageId: threadB.id,
          entryKind: "message",
        }),
      ]),
    );
  });

  test("thread session references root and parent messages separately", async () => {
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const rootSession = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
    });
    const rootMessage = messageStore.append({
      sessionId: rootSession.id,
      channelMessageKey: "m_parent_root",
      senderUserId: "reporter-user",
      role: "user",
      content: { text: "root issue" },
      rawPayload: null,
    });
    const parentMessage = messageStore.append({
      sessionId: rootSession.id,
      channelMessageKey: "m_parent_reply",
      senderUserId: "luna-bot",
      role: "assistant",
      content: { text: "assistant reply" },
      rawPayload: null,
    });

    const threadSession = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
      threadId: "thread-parent-ref",
      rootMessageId: "m_parent_root",
      parentMessageId: "m_parent_reply",
    });

    const threadReferences = new SessionTimelineReader(database.db)
      .listForSession(threadSession.id)
      .filter((item) => item.entry.entryKind === "reference")
      .map((item) => item.message.id);

    expect(threadReferences).toEqual([rootMessage.id, parentMessage.id]);
  });

  test("root follow-up does not use legacy thread projections as recent context", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_projection_anchor",
        text: "锚点问题：视频打不开",
        senderUserId: "anchor-user",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_projection_starter",
        text: "reply in thread：did=4453477614363128",
        rootMessageId: "m_projection_anchor",
        senderUserId: "thread-starter-user",
        rawPayload: {
          message: {
            message_id: "m_projection_starter",
            root_id: "m_projection_anchor",
            parent_id: "m_projection_anchor",
          },
        },
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_projection_thread_request",
        text: "@Luna 处理一下",
        threadId: "thread-with-projections",
        rootMessageId: "m_projection_anchor",
        senderUserId: "requester-user",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_projection_root_followup",
        text: "@Luna 刚才那个继续看",
        senderUserId: "requester-user",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    const input = userMessagesInputForLatestMessage(
      runner,
      "m_projection_root_followup",
    );
    expect(input.messages.map((message) => message.text)).toContain(
      "@Luna 刚才那个继续看",
    );
    expect(input.context.deltaContext?.items.map((item) => item.text)).toEqual(
      expect.arrayContaining(["锚点问题：视频打不开"]),
    );
    expect(input.context.launchSeed).toBeUndefined();
  });

  test("thread activation follow-up survives root message canonicalization", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_canonical_root",
        text: "视频打不开",
        senderUserId: "user-a",
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_canonical_thread_starter",
        text: "did=4453477614363128",
        rootMessageId: "m_canonical_root",
        senderUserId: "user-a",
        rawPayload: {
          message: {
            message_id: "m_canonical_thread_starter",
            root_id: "m_canonical_root",
            parent_id: "m_canonical_root",
          },
        },
      }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_canonical_thread_anchor",
        text: "@Luna 处理一下",
        threadId: "thread-canonical",
        rootMessageId: "m_canonical_root",
        senderUserId: "user-b",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_canonical_thread_followup",
        text: "再补一个现象：切源后黑屏",
        threadId: "thread-canonical",
        rootMessageId: "m_canonical_root",
        senderUserId: "user-b",
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    const input = userMessagesInput(runner);
    expect(input.latestMessage.addressing?.reason).toBe("activation_followup");
    expect(input.context.launchSeed?.items.map((item) => item.text)).toContain(
      "视频打不开",
    );
    expect(input.messages.map((message) => message.text)).toContain(
      "再补一个现象：切源后黑屏",
    );
  });

  test("activation context skips empty text rows before max message budget", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        activation_context_max_messages: 1,
      },
    });

    await router.routeDirectInboundForTest(groupInbound({ id: "m_context_valid", text: "valid" }));
    await router.routeDirectInboundForTest(groupInbound({ id: "m_context_empty", text: "" }));
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_empty_trigger",
        text: "@Luna 看看",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    const input = userMessagesInput(runner);
    expect(input.activationContextMessages).toBeUndefined();
    expect(deltaContextItems(input).map((item) => item.text)).toEqual(["valid"]);
  });

  test("activation context stops on newest char-budget overflow", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        activation_context_max_chars: 5,
      },
    });

    await router.routeDirectInboundForTest(groupInbound({ id: "m_context_older_short", text: "ok" }));
    await router.routeDirectInboundForTest(
      groupInbound({ id: "m_context_newest_long", text: "too long" }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_overflow_trigger",
        text: "@Luna 看看",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    expect(userMessagesInput(runner).activationContextMessages).toBeUndefined();
  });

  test("activation context selection failure fails open for addressed group", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    const original = MessageStore.prototype.listRecentUserMessagesBefore;

    await router.routeDirectInboundForTest(groupInbound({ id: "m_context_throw_seed", text: "context" }));
    MessageStore.prototype.listRecentUserMessagesBefore = () => {
      throw new Error("simulated activation context failure");
    };
    try {
      await router.routeDirectInboundForTest(
        groupInbound({
          id: "m_context_throw_trigger",
          text: "@Luna 看看",
          addressing: { addressedToBot: true, reason: "mention" },
        }),
      );
      await router.waitForIdle();
    } finally {
      MessageStore.prototype.listRecentUserMessagesBefore = original;
    }

    const input = userMessagesInput(runner);
    expect(input.latestMessage.id).toBe("m_context_throw_trigger");
    expect(input.activationContextMessages).toBeUndefined();
    expect(input.requesterUserId).toBe(canonicalUserIdForOpenId("user-1"));
  });

  test("activation context fields are absent because silent group does not run", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(groupInbound({ id: "m_context_silent_no_run", text: "hi" }));
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(0);
  });

  test("p2p runs without group-only activation context fields", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(p2pInbound({ id: "m_p2p_context", text: "hello" }));
    await router.waitForIdle();

    const input = userMessagesInput(runner);
    expect(input.latestMessage.addressing).toEqual({
      addressedToBot: true,
      reason: "p2p",
    });
    expect(input.activationContextMessages).toBeUndefined();
    expect(input.requesterUserId).toBeUndefined();
  });

  test("activation context window excludes old user messages", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        activation_context_window_ms: 1,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_old",
        text: "old context",
        senderUserId: "old-user",
      }),
    );
    database.db
      .update(messages)
      .set({ occurredAt: Date.now() - 10000, createdAt: Date.now() - 10000 })
      .where(eq(messages.externalMessageId, "m_context_old"))
      .run();
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_old_trigger",
        text: "@Luna 看看",
        senderUserId: "user-b",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    expect(userMessagesInput(runner).activationContextMessages).toBeUndefined();
  });

  test("activation context is disabled when max messages is zero", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        activation_context_max_messages: 0,
      },
    });

    await router.routeDirectInboundForTest(groupInbound({ id: "m_context_disabled", text: "context" }));
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_disabled_trigger",
        text: "@Luna 看看",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    expect(userMessagesInput(runner).activationContextMessages).toBeUndefined();
  });

  test("activation context is disabled when max chars is zero", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        activation_context_max_chars: 0,
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({ id: "m_context_char_disabled", text: "context" }),
    );
    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_context_char_disabled_trigger",
        text: "@Luna 看看",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();

    expect(userMessagesInput(runner).activationContextMessages).toBeUndefined();
  });

  test("group reply to previous Luna assistant message activates as reply to bot", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    const repliedMessageId = "assistant-root-message";
    seedAssistantMessage({
      inbound: groupInbound({
        id: repliedMessageId,
        text: "Luna previous reply",
        threadId: "thread-reply",
        rootMessageId: repliedMessageId,
      }),
      channelMessageKey: repliedMessageId,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_reply_to_bot",
        text: "继续看这个",
        threadId: "thread-reply",
        rootMessageId: repliedMessageId,
        addressing: { addressedToBot: false, reason: "silent_group" },
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.input).toMatchObject({
      type: "user_messages",
      latestMessage: {
        id: "m_reply_to_bot",
        addressing: { addressedToBot: true, reason: "reply_to_bot" },
      },
    });
    const latestMessage = runner.calls[0]?.input.type === "user_messages"
      ? runner.calls[0].input.latestMessage
      : undefined;
    expect(latestMessage?.addressing).toEqual({
      addressedToBot: true,
      reason: "reply_to_bot",
    });
  });

  test("group reply to assistant parent activates when root is thread root", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    const threadRootMessageId = "thread-root-message";
    const assistantParentMessageId = "assistant-parent-message";
    seedAssistantMessage({
      inbound: groupInbound({
        id: assistantParentMessageId,
        text: "Luna parent reply",
        threadId: "thread-realistic",
        rootMessageId: threadRootMessageId,
      }),
      channelMessageKey: assistantParentMessageId,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_reply_parent",
        text: "这里继续补充",
        threadId: "thread-realistic",
        rootMessageId: threadRootMessageId,
        addressing: { addressedToBot: false, reason: "silent_group" },
        rawPayload: {
          message: {
            message_id: "m_reply_parent",
            root_id: threadRootMessageId,
            parent_id: assistantParentMessageId,
            thread_key: "thread-realistic",
          },
        },
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    const latestMessage = runner.calls[0]?.input.type === "user_messages"
      ? runner.calls[0].input.latestMessage
      : undefined;
    expect(latestMessage?.addressing).toEqual({
      addressedToBot: true,
      reason: "reply_to_bot",
    });
  });

  test("group thread reply activates from assistant root message in root session", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    const botRootMessageId = "assistant-root-channel-message";
    seedAssistantMessage({
      inbound: groupInbound({
        id: "root-session-seed",
        text: "Root session seed",
      }),
      channelMessageKey: botRootMessageId,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_thread_reply_to_root_bot",
        text: "这里继续问一下",
        threadId: "new-thread-from-bot-root",
        rootMessageId: botRootMessageId,
        addressing: { addressedToBot: false, reason: "silent_group" },
        rawPayload: {
          message: {
            message_id: "m_thread_reply_to_root_bot",
            root_id: botRootMessageId,
            parent_id: botRootMessageId,
            thread_key: "new-thread-from-bot-root",
          },
        },
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    const latestMessage = runner.calls[0]?.input.type === "user_messages"
      ? runner.calls[0].input.latestMessage
      : undefined;
    expect(latestMessage?.addressing).toEqual({
      addressedToBot: true,
      reason: "reply_to_bot",
    });
  });

  test("configured leading alias activates group message", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        group_bot_aliases: ["小助手"],
      },
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_alias",
        text: "小助手，帮忙总结一下",
        addressing: { addressedToBot: false, reason: "silent_group" },
      }),
    );
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    const latestMessage = runner.calls[0]?.input.type === "user_messages"
      ? runner.calls[0].input.latestMessage
      : undefined;
    expect(latestMessage?.addressing).toEqual({
      addressedToBot: true,
      reason: "alias",
    });
    expect(channel.outbound).toHaveLength(1);
  });

  test("addressed duplicate after completion does not restart processing", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    const inbound = groupInbound({
      id: "m_addressed_duplicate",
      text: "@Luna 帮我看下",
      addressing: { addressedToBot: true, reason: "mention" },
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();
    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(channel.beginProcessingCalls).toEqual(["m_addressed_duplicate"]);
    expect(channel.completeProcessingCalls).toEqual(["m_addressed_duplicate"]);
    expect(channel.outbound).toHaveLength(1);
    expect(database.db.select().from(sessionInbox).all()).toHaveLength(1);
  });

  test("accepted activation follow-up duplicate after completion does not restart processing", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      groupInbound({
        id: "m_followup_duplicate_anchor",
        text: "@Luna 看下",
        senderUserId: "user-a",
        addressing: { addressedToBot: true, reason: "mention" },
      }),
    );
    await router.waitForIdle();
    const inbound = groupInbound({
      id: "m_followup_duplicate_candidate",
      text: "补充 did=123",
      senderUserId: "user-a",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();
    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(channel.beginProcessingCalls).toEqual(["m_followup_duplicate_anchor"]);
    expect(channel.completeProcessingCalls).toEqual([
      "m_followup_duplicate_anchor",
      "m_followup_duplicate_candidate",
    ]);
    expect(database.db.select().from(sessionInbox).all()).toHaveLength(2);
  });

  test("silent duplicate remains persisted once without processing", async () => {
    const channel = new RecordingProcessingChannel("feishu-main");
    const runner = new DynamicMainRunner(() => replyNormal());
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    const inbound = groupInbound({ id: "m_silent_duplicate", text: "大家看看" });

    await router.routeDirectInboundForTest(inbound);
    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(database.db.select().from(messages).all()).toHaveLength(1);
    expect(database.db.select().from(sessionInbox).all()).toHaveLength(0);
    expect(database.db.select().from(sessionTurns).all()).toMatchObject([
      {
        status: "skipped",
        runner_invoked: false,
        reason: "silent_group",
      },
    ]);
    expect(runner.calls).toHaveLength(0);
    expect(channel.beginProcessingCalls).toHaveLength(0);
    expect(channel.completeProcessingCalls).toHaveLength(0);
    expect(channel.outbound).toHaveLength(0);
  });
});

async function emitFeishuReceive(
  channel: FeishuMessageChannel,
  input: {
    readonly messageId: string;
    readonly text: string;
    readonly senderOpenId: string;
    readonly mentions?: readonly unknown[];
    readonly threadId?: string;
    readonly rootId?: string;
  },
): Promise<void> {
  await (
    channel as unknown as {
      _handleMessageReceive(event: unknown): Promise<void>;
    }
  )._handleMessageReceive({
    sender: {
      sender_id: { open_id: input.senderOpenId },
      sender_type: "user",
    },
    message: {
      message_id: input.messageId,
      create_time: "1780370000000",
      chat_id: "oc_chat_1",
      chat_type: "group",
      message_type: "text",
      ...(input.threadId !== undefined ? { thread_key: input.threadId } : {}),
      ...(input.rootId !== undefined ? { root_id: input.rootId } : {}),
      ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
      content: JSON.stringify({ text: input.text }),
    },
  });
}

function groupInbound(input: {
  readonly id: string;
  readonly text: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
  readonly senderUserId?: string;
  readonly mentions?: InboundChannelMessage["mentions"];
  readonly addressing?: InboundChannelMessage["addressing"];
  readonly senderProfile?: InboundChannelMessage["senderProfile"];
  readonly chatProfile?: InboundChannelMessage["chatProfile"];
  readonly rawPayload?: unknown;
}): InboundChannelMessage {
  const senderUserId = input.senderUserId ?? "user-1";
  return {
    id: input.id,
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "group-alpha",
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    rootMessageId: input.rootMessageId ?? input.id,
    senderUserId,
    ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
    text: input.text,
    chatType: "group",
    addressing: input.addressing ?? {
      addressedToBot: false,
      reason: "silent_group",
    },
    senderProfile: input.senderProfile ?? {
      externalUserId: senderUserId,
      openId: senderUserId,
      displayName: senderUserId,
    },
    ...(input.chatProfile !== undefined ? { chatProfile: input.chatProfile } : {}),
    ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
  };
}

function p2pInbound(input: {
  readonly id: string;
  readonly text: string;
  readonly senderUserId?: string;
}): InboundChannelMessage {
  return {
    id: input.id,
    channelType: "feishu",
    channelId: "feishu-main",
    senderUserId: input.senderUserId ?? "user-1",
    text: input.text,
    chatType: "p2p",
  };
}

function messageTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return "";
      }
      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function seedAssistantMessage(input: {
  readonly inbound: InboundChannelMessage;
  readonly channelMessageKey: string;
}): void {
  const resolver = new SessionResolver(new SessionStore(database.db));
  const session = resolver.resolveFromNormalizedInbound(
    normalizedInboundFromDirectCallForTest(input.inbound),
  );
  new MessageStore(database.db).append({
    sessionId: session.id,
    channelMessageKey: input.channelMessageKey,
    senderUserId: "luna-bot",
    role: "assistant",
    content: [{ type: "text", text: "Previous Luna response" }],
    rawPayload: { origin: "test_assistant_seed" },
  });
}

function replyNormal(): TestMainPlan {
  return {
    operation: "message.send",
    reply: "Luna received your message.",
    reason: "ordinary",
  };
}

function userMessagesInput(
  runner: DynamicMainRunner,
): MainRunnerUserMessagesInput {
  const input = runner.calls.at(-1)?.input;
  if (input?.type !== "user_messages") {
    throw new Error("Expected latest Main Runner call to be user_messages.");
  }
  return input;
}

function deltaContextItems(
  input: MainRunnerUserMessagesInput,
): NonNullable<MainRunnerUserMessagesInput["context"]["deltaContext"]>["items"] {
  const items = input.context.deltaContext?.items;
  if (items === undefined) {
    throw new Error("Expected Main Runner input to include delta context items.");
  }
  return items;
}

function userMessagesInputForLatestMessage(
  runner: DynamicMainRunner,
  latestMessageId: string,
): MainRunnerUserMessagesInput {
  const input = runner.calls
    .map((call) => call.input)
    .find(
      (candidate): candidate is MainRunnerUserMessagesInput =>
        candidate.type === "user_messages" &&
        candidate.latestMessage.id === latestMessageId,
    );
  if (input === undefined) {
    throw new Error(
      `Expected Main Runner call for latest message ${latestMessageId}.`,
    );
  }
  return input;
}

function sessionConversationControlEvents() {
  return database.db
    .select()
    .from(lunaSchema.sessionTimelineEvents)
    .all()
    .filter((row) => row.eventType === "conversation_control");
}

class RecordingProcessingChannel extends FakeFeishuChannel {
  readonly beginProcessingCalls: string[] = [];
  readonly completeProcessingCalls: string[] = [];

  async beginProcessing(inbound: NormalizedInboundMessage): Promise<void> {
    this.beginProcessingCalls.push(inbound.id);
  }

  async completeProcessing(inbound: NormalizedInboundMessage): Promise<void> {
    this.completeProcessingCalls.push(inbound.id);
  }
}

class ThreadMetadataChannel extends RecordingProcessingChannel {
  override async send(
    inbound: Parameters<FakeFeishuChannel["send"]>[0],
    operation: Parameters<FakeFeishuChannel["send"]>[1],
  ): ReturnType<FakeFeishuChannel["send"]> {
    const outbound = await super.send(inbound, operation);
    if (operation.replyMode !== "reply_in_thread") {
      return outbound;
    }
    const normalized = normalizeChannelInput(inbound);
    const targetMessageId = operation.targetMessageId ?? normalized.id;
    const patched = {
      ...outbound,
      threadId: normalized.thread?.externalId ?? `thread-for-${targetMessageId}`,
      rootMessageId: normalized.thread?.rootMessageExternalId ?? targetMessageId,
    } as typeof outbound;
    this.outbound.splice(this.outbound.length - 1, 1, patched);
    return patched;
  }
}

class FailsOnceForMessageChannel extends RecordingProcessingChannel {
  private _failed = false;

  constructor(
    channelId: string,
    private readonly _messageId: string,
  ) {
    super(channelId);
  }

  override async send(
    inbound: Parameters<FakeFeishuChannel["send"]>[0],
    operation: Parameters<FakeFeishuChannel["send"]>[1],
  ): ReturnType<FakeFeishuChannel["send"]> {
    if (!this._failed && inbound.id === this._messageId) {
      this._failed = true;
      throw new Error("simulated outbound failure");
    }
    return await super.send(inbound, operation);
  }
}

class FailsFirstSendChannel extends RecordingProcessingChannel {
  private _remainingFailures = 1;

  override async send(
    inbound: Parameters<FakeFeishuChannel["send"]>[0],
    operation: Parameters<FakeFeishuChannel["send"]>[1],
  ): ReturnType<FakeFeishuChannel["send"]> {
    if (this._remainingFailures > 0) {
      this._remainingFailures -= 1;
      throw new Error("simulated outbound failure");
    }
    return await super.send(inbound, operation);
  }
}

function normalizeChannelInput(
  inbound: NormalizedInboundMessage,
): NormalizedInboundMessage {
  return inbound;
}

class DynamicMainRunner {
  readonly calls: MainRunnerRunInput[] = [];

  constructor(
    private readonly _handler: (
      input: MainRunnerRunInput,
    ) => TestMainPlan | Promise<TestMainPlan>,
  ) {}

  async run(input: MainRunnerRunInput): Promise<TestMainPlan> {
    this.calls.push(input);
    if (input.input.type === "user_messages") {
      const requester = input.input.requesterUserId ?? input.input.messages.at(-1)?.senderUserId;
      const session = new SessionStore(database.db).getById(input.input.context.sessionId);
      if (requester && session) {
      }
    }
    return await this._handler(input);
  }

  asMainRunner(): MainRunner {
    return this as unknown as MainRunner;
  }
}
