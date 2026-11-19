import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { AgentStore } from "@/agents/agent-store";
import { BotBindingStore } from "@/agents/bot-binding-store";
import { config, setLunaHome } from "@/shared";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { channelMessageMarkers, messages, sessionInbox, sessions } from "../../src/data/schema";
import { SessionTimelineReader } from "../../src/sessions/session-timeline-reader";
import { GroupJoinBackfillService, normalizeFeishuHistoryMessage } from "../../src/sessions/inbound/group-join-backfill";
import {
  appendBackfillMessage,
} from "../../src/sessions/inbound/group-join-backfill-persistence";

let fixture: { home: string; previousHome: string; connection: DataConnection<typeof schema> } | undefined;
const owner = "backfill-owner";
const channelId = "feishu-main";
const appId = `test:feishu:${channelId}`;

function openFreshDatabase(): DataConnection<typeof schema> {
  const previousHome = config.paths.home;
  const home = mkdtempSync(join(tmpdir(), "luna-group-join-backfill-"));
  setLunaHome(home);
  const connection = new DataConnection(schema);
  fixture = {home, previousHome, connection};
  fixtureSessionOwnership(connection.db, "feishu", channelId, owner);
  return connection;
}

afterEach(() => {
  if (!fixture) return;
  fixture.connection.close();
  setLunaHome(fixture.previousHome);
  rmSync(fixture.home, {recursive: true, force: true});
  fixture = undefined;
});

describe("GroupJoinBackfillService", () => {
  test("backfillOnBotAddedToGroup imports the latest chat messages into the root session only", async () => {
    const connection = openFreshDatabase();
    const imported: string[] = [];
    const service = new GroupJoinBackfillService({
      identityScope: {environment: "feishu", appId},
      db: connection.db,
      historyPageSize: 30,
      listChatHistory: async () => ({
        hasMore: false,
        items: Array.from({ length: 3 }, (_, index) => ({
          message_id: `om_backfill_${3 - index}`,
          chat_id: "oc_group_1",
          msg_type: "text",
          create_time: `${1_720_000_000_002 - index}`,
          body: { content: JSON.stringify({ text: `history ${3 - index}` }) },
          sender: {
            id: "ou_reporter",
            id_type: "open_id",
            sender_type: "user",
            sender_name: "Reporter",
          },
        })),
      }),
      enrichMessage: async ({ normalizedMessage }) => ({
        ...normalizedMessage,
        sender: {
          ...normalizedMessage.sender,
          displayName: "Reporter",
          avatarUrl: "https://example.test/reporter.png",
        },
        surface: {
          ...normalizedMessage.surface,
          displayName: "Backfill Group",
          avatarUrl: "https://example.test/group.png",
        },
      }),
      appendBackfill: (input) => {
        imported.push(input.message.id);
        return appendBackfillMessage(input);
      },
      now: () => 1_720_000_100_000,
    });

    const result = await service.backfillOnBotAddedToGroup({
      eventId: "evt_bot_added_1",
      channelType: "feishu",
      channelId: "feishu-main",
      chatId: "oc_group_1",
      occurredAt: 1_720_000_100_000,
    });

    expect(result).toEqual({ importedCount: 3, skippedCount: 0 });
    expect(imported).toEqual(["om_backfill_1", "om_backfill_2", "om_backfill_3"]);
    expect(connection.db.select().from(sessionInbox).all()).toHaveLength(0);
    expect(connection.db.select().from(messages).all().map((row) => row.externalMessageId)).toEqual([
      "om_backfill_1",
      "om_backfill_2",
      "om_backfill_3",
    ]);
    expect(connection.db.select().from(messages).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawPayloadJson: expect.objectContaining({
            sender: expect.objectContaining({
              displayName: "Reporter",
              avatarUrl: "https://example.test/reporter.png",
            }),
            surface: expect.objectContaining({
              displayName: "Backfill Group",
              avatarUrl: "https://example.test/group.png",
            }),
          }),
        }),
      ]),
    );
    expect(connection.db.select().from(sessions).all()).toEqual([
      expect.objectContaining({
        channel_id: "feishu-main",
        group_id: "oc_group_1",
        thread_key: null,
      }),
    ]);
    expect(connection.db.select().from(channelMessageMarkers).all()).toEqual([
      expect.objectContaining({
        channelId: "feishu-main",
        channelType: "feishu",
        messageId: "oc_group_1",
        markerType: "group_join_backfill",
        providerMarkerId: "evt_bot_added_1",
      }),
    ]);
  });

  test("backfillOnBotAddedToGroup is idempotent by join event id", async () => {
    const connection = openFreshDatabase();
    let calls = 0;
    const service = new GroupJoinBackfillService({
      identityScope: {environment: "feishu", appId},
      db: connection.db,
      historyPageSize: 30,
      listChatHistory: async () => {
        calls += 1;
        return { hasMore: false, items: [] };
      },
    });

    await service.backfillOnBotAddedToGroup({
      eventId: "evt_bot_added_2",
      channelType: "feishu",
      channelId: "feishu-main",
      chatId: "oc_group_2",
      occurredAt: 1_720_000_100_000,
    });
    await service.backfillOnBotAddedToGroup({
      eventId: "evt_bot_added_2",
      channelType: "feishu",
      channelId: "feishu-main",
      chatId: "oc_group_2",
      occurredAt: 1_720_000_100_000,
    });

    expect(calls).toBe(1);
  });

  test("backfillOnBotAddedToGroup skips unsupported non-importable history records", async () => {
    const connection = openFreshDatabase();
    const service = new GroupJoinBackfillService({
      identityScope: {environment: "feishu", appId},
      db: connection.db,
      listChatHistory: async () => ({
        hasMore: false,
        items: [
          {
            message_id: "om_audio",
            chat_id: "oc_group_3",
            msg_type: "audio",
            create_time: "1720000000000",
            body: { content: "{}" },
            sender: {
              id: "ou_reporter",
              id_type: "open_id",
              sender_type: "user",
            },
          },
          {
            message_id: "om_system",
            chat_id: "oc_group_3",
            msg_type: "system",
            create_time: "1720000000001",
            body: { content: JSON.stringify({ text: "system history" }) },
            sender: {
              id: "cli_system",
              id_type: "app_id",
              sender_type: "app",
            },
          },
        ],
      }),
    });

    const result = await service.backfillOnBotAddedToGroup({
      eventId: "evt_bot_added_3",
      channelType: "feishu",
      channelId: "feishu-main",
      chatId: "oc_group_3",
      occurredAt: 1_720_000_100_000,
    });

    expect(result).toEqual({ importedCount: 0, skippedCount: 2 });
    expect(connection.db.select().from(messages).all()).toHaveLength(0);
    expect(connection.db.select().from(sessionInbox).all()).toHaveLength(0);
  });

  test("backfillOnBotAddedToGroup preserves app replies as bot-authored history messages", async () => {
    const connection = openFreshDatabase();
    const service = new GroupJoinBackfillService({
      identityScope: {environment: "feishu", appId},
      db: connection.db,
      listChatHistory: async () => ({
        hasMore: false,
        items: [
          {
            message_id: "om_app_reply",
            chat_id: "oc_group_4",
            msg_type: "text",
            create_time: "1720000000000",
            root_id: "om_root_1",
            parent_id: "om_root_1",
            body: { content: JSON.stringify({ text: "bot reply" }) },
            sender: {
              id: "cli_bot",
              id_type: "app_id",
              sender_type: "app",
              sender_name: "Monkey King",
            },
          },
        ],
      }),
    });

    const result = await service.backfillOnBotAddedToGroup({
      eventId: "evt_bot_added_4",
      channelType: "feishu",
      channelId: "feishu-main",
      chatId: "oc_group_4",
      occurredAt: 1_720_000_100_000,
    });

    expect(result).toEqual({ importedCount: 1, skippedCount: 0 });
    expect(connection.db.select().from(messages).all()).toEqual([
      expect.objectContaining({
        externalMessageId: "om_app_reply",
        role: "user",
        senderUserId: expect.any(String),
      }),
    ]);
    expect(connection.db.select().from(schema.users).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "bot",
          displayName: "Monkey King",
        }),
      ]),
    );
  });

  test("thread history fetched under a retired binding cannot enter the replacement Shadow", async () => {
    const {db} = openFreshDatabase();
    const bindings = new BotBindingStore(db);
    const original = bindings.requireActive(channelId);
    const replacement = new AgentStore(db).createShadow(owner, original.agentId, {name: "Replacement"}, "replacement");
    const threadMessage = {
      message_id: "om_thread_starter", chat_id: "oc_group_5", msg_type: "text", create_time: "1720000000000",
      thread_id: "omt_thread_1", thread_message_position: "-1", body: {content: JSON.stringify({text: "old history"})},
      sender: {id: "ou_reporter", id_type: "open_id", sender_type: "user"},
    };
    const service = new GroupJoinBackfillService({
      db, identityScope: {environment: "feishu", appId},
      listChatHistory: async () => ({hasMore: false, items: [threadMessage]}),
      listThreadHistory: async () => {
        bindings.retire(owner, original.id);
        bindings.bind(owner, replacement.id, channelId);
        return {hasMore: false, items: [threadMessage]};
      },
    });

    await expect(service.backfillOnBotAddedToGroup({
      eventId: "late-join", channelType: "feishu", channelId, chatId: "oc_group_5", occurredAt: 1_720_000_100_000,
    })).rejects.toThrow("bot_binding_retired");
    expect(db.select().from(sessions).all()).toEqual([expect.objectContaining({shadow_id: original.shadowId, thread_key: null})]);
    expect(db.select().from(messages).all()).toEqual([]);
    expect(db.select().from(channelMessageMarkers).all()).toEqual([]);
  });

  test("backfillOnBotAddedToGroup creates thread sessions for thread history", async () => {
    const connection = openFreshDatabase();
    const service = new GroupJoinBackfillService({
      identityScope: {environment: "feishu", appId},
      db: connection.db,
      listChatHistory: async () => ({
        hasMore: false,
        items: [
          {
            message_id: "om_thread_starter",
            chat_id: "oc_group_5",
            msg_type: "text",
            create_time: "1720000000000",
            thread_id: "omt_thread_1",
            thread_message_position: "-1",
            body: { content: JSON.stringify({ text: "thread starter" }) },
            sender: {
              id: "ou_reporter",
              id_type: "open_id",
              sender_type: "user",
              sender_name: "Reporter",
            },
          },
        ],
      }),
      listThreadHistory: async () => ({
        hasMore: false,
        items: [
          {
            message_id: "om_thread_reply",
            chat_id: "oc_group_5",
            msg_type: "text",
            create_time: "1720000000001",
            thread_id: "omt_thread_1",
            root_id: "om_thread_starter",
            parent_id: "om_thread_starter",
            body: { content: JSON.stringify({ text: "thread follow-up" }) },
            sender: {
              id: "cli_bot",
              id_type: "app_id",
              sender_type: "app",
              sender_name: "Monkey King",
            },
          },
          {
            message_id: "om_thread_starter",
            chat_id: "oc_group_5",
            msg_type: "text",
            create_time: "1720000000000",
            thread_id: "omt_thread_1",
            thread_message_position: "-1",
            body: { content: JSON.stringify({ text: "thread starter" }) },
            sender: {
              id: "ou_reporter",
              id_type: "open_id",
              sender_type: "user",
              sender_name: "Reporter",
            },
          },
        ],
      }),
    });

    const result = await service.backfillOnBotAddedToGroup({
      eventId: "evt_bot_added_5",
      channelType: "feishu",
      channelId: "feishu-main",
      chatId: "oc_group_5",
      occurredAt: 1_720_000_100_000,
    });

    expect(result).toEqual({ importedCount: 2, skippedCount: 0 });

    const rootSession = connection.db
      .select()
      .from(sessions)
      .all()
      .find((row) => row.group_id === "oc_group_5" && row.thread_key === null);
    const threadSession = connection.db
      .select()
      .from(sessions)
      .all()
      .find((row) => row.group_id === "oc_group_5" && row.thread_key === "omt_thread_1");

    expect(rootSession).toBeDefined();
    expect(threadSession).toMatchObject({
      channel_id: "feishu-main",
      group_id: "oc_group_5",
      thread_key: "omt_thread_1",
      root_message_key: "om_thread_starter",
    });

    const threadTimeline = new SessionTimelineReader(connection.db)
      .listForSession(threadSession!.id);
    expect(threadTimeline.map((item) => ({
      kind: item.entry.entryKind,
      messageId: item.message.externalMessageId,
    }))).toEqual([
      { kind: "message", messageId: "om_thread_starter" },
      { kind: "message", messageId: "om_thread_reply" },
    ]);
  });
});

describe("normalizeFeishuHistoryMessage", () => {
  test("normalizes a Feishu text history record into an inbound message", () => {
    const normalized = normalizeFeishuHistoryMessage({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "feishu-main" },
      event: {
        message_id: "om_history_text",
        chat_id: "oc_group_4",
        msg_type: "text",
        updated: true,
        create_time: "1720000000000",
        body: { content: JSON.stringify({ text: "plain text" }) },
        sender: {
          id: "ou_reporter",
          id_type: "open_id",
          sender_type: "user",
          tenant_key: "tenant-1",
          sender_name: "Reporter",
        },
        mentions: [
          {
            key: "@_user_1",
            id: "ou_reporter_2",
            id_type: "open_id",
            name: "Reporter 2",
            tenant_key: "tenant-1",
          },
        ],
      },
    });

    expect(normalized).toMatchObject({
      id: "om_history_text",
      channel: { type: "feishu", id: "feishu-main" },
      surface: {
        kind: "group",
        externalId: "oc_group_4",
        providerIds: { tenant_key: "tenant-1" },
      },
      sender: {
        externalId: "ou_reporter",
        kind: "user",
        displayName: "Reporter",
      },
      text: "plain text",
      addressing: { addressedToBot: false, reason: "silent_group" },
      mentions: [
        expect.objectContaining({
          key: "@_user_1",
          label: "@Reporter 2",
        }),
      ],
    });
  });

  test("normalizes updated history text with bot mentions instead of skipping it", () => {
    const normalized = normalizeFeishuHistoryMessage({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "feishu-main" },
      event: {
        message_id: "om_history_updated_mention",
        chat_id: "oc_group_4",
        msg_type: "text",
        updated: true,
        thread_id: "omt_thread_1",
        create_time: "1720000000000",
        body: { content: JSON.stringify({ text: "@_user_1 在吗" }) },
        sender: {
          id: "ou_reporter",
          id_type: "open_id",
          sender_type: "user",
          tenant_key: "tenant-1",
        },
        mentions: [
          {
            key: "@_user_1",
            id: "ou_bot",
            id_type: "open_id",
            name: "Monkey King",
            tenant_key: "tenant-1",
          },
        ],
      },
    });

    expect(normalized).toMatchObject({
      id: "om_history_updated_mention",
      thread: {
        externalId: "omt_thread_1",
      },
      text: "@Monkey King 在吗",
      mentions: [
        expect.objectContaining({
          key: "@_user_1",
          label: "@Monkey King",
        }),
      ],
    });
  });

  test("normalizes thread starter history with self anchor when root ids are absent", () => {
    const normalized = normalizeFeishuHistoryMessage({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "feishu-main" },
      event: {
        message_id: "om_thread_starter",
        chat_id: "oc_group_4",
        msg_type: "text",
        thread_id: "omt_thread_1",
        thread_message_position: "-1",
        create_time: "1720000000000",
        body: { content: JSON.stringify({ text: "starter" }) },
        sender: {
          id: "ou_reporter",
          id_type: "open_id",
          sender_type: "user",
        },
      },
    });

    expect(normalized).toMatchObject({
      id: "om_thread_starter",
      thread: {
        externalId: "omt_thread_1",
        rootMessageExternalId: "om_thread_starter",
      },
    });
  });

  test("normalizes interactive history records into card messages", () => {
    const normalized = normalizeFeishuHistoryMessage({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "feishu-main" },
      event: {
        message_id: "om_history_interactive",
        chat_id: "oc_group_4",
        msg_type: "interactive",
        create_time: "1720000000000",
        body: {
          content: JSON.stringify({
            elements: [
              [{ tag: "markdown", content: "**Card**\n\nhello" }],
            ],
          }),
        },
        sender: {
          id: "cli_bot",
          id_type: "app_id",
          sender_type: "app",
          sender_name: "Monkey King",
        },
      },
    });

    expect(normalized).toMatchObject({
      id: "om_history_interactive",
      sender: {
        externalId: "cli_bot",
        kind: "bot",
      },
      text: "**Card**\n\nhello",
      contentKind: "card",
      presentationKind: "provider_rich_card",
      providerMessageType: "interactive",
      presentation: {
        kind: "rich_markdown_card",
      },
    });
  });

  test("returns null for unsupported history records", () => {
    const normalized = normalizeFeishuHistoryMessage({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "feishu-main" },
      event: {
        message_id: "om_history_audio",
        chat_id: "oc_group_4",
        msg_type: "audio",
        create_time: "1720000000000",
        body: { content: "{}" },
        sender: {
          id: "ou_reporter",
          id_type: "open_id",
          sender_type: "user",
        },
      },
    });

    expect(normalized).toBeNull();
  });
});
