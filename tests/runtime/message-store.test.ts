import {fixtureSessionOwnership} from "../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { DataConnection } from "../../src/data";
import {
  messages,
  sessionTimelineEntries,
  sessions,
  users,
} from "../../src/data/schema";
import * as schema from "../../src/data/schema";
import { LUNA_SYSTEM_USER_ID } from "../../src/identity/system-user-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionTimelineReader } from "../../src/sessions/session-timeline-reader";
import { SessionTimelineStore } from "../../src/sessions/session-timeline-store";
import { appendBackfillMessage } from "../../src/work/group-join-backfill-persistence";

let homes: string[] = [];

async function openFreshDatabase(): Promise<DataConnection<typeof schema>> {
  const home = mkdtempSync(join(tmpdir(), "luna-message-store-"));
  homes.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    "messaging:\n  default_channel_id: fake\n  channels: []\n",
  );
  const config = await import("../../src/shared/config/index");
  config.setLunaHome(home);
  config.reloadConfig();
  return new DataConnection(schema);
}

afterEach(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
  homes = [];
});

function withLarkClaims<T extends { providerIds?: Record<string, string> }>(
  identity: T,
) {
  const providerIds = identity.providerIds ?? {};
  return {
    ...identity,
    identityClaims: [
      ...(providerIds.open_id === undefined
        ? []
        : [
            {
              namespace: "lark" as const,
              kind: "open_id" as const,
              value: providerIds.open_id,
              scope: "app:message-store-test",
              confidence: "verified" as const,
            },
          ]),
      ...(providerIds.union_id === undefined
        ? []
        : [
            {
              namespace: "lark" as const,
              kind: "union_id" as const,
              value: providerIds.union_id,
              scope: "developer:message-store-test",
              confidence: "verified" as const,
            },
          ]),
    ],
  };
}

describe("MessageStore", () => {
  test("appendOnce dedupes repeated provider messages in one session timeline", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    const session = sessionRow(connection.db,{
      id: "session-root",
      surfaceKey: "feishu:main:group:root",
      channelId: "main",
      groupId: "group-1",
      title: "Root",
      now,
    });
    connection.db.insert(sessions).values(session).run();
    const store = new MessageStore(connection.db);

    const first = store.appendOnce({
      sessionId: session.id,
      channelMessageKey: "message-1",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "main" },
      content: { text: "first copy" },
      rawPayload: null,
      createdAt: now,
    });

    const second = store.appendOnce({
      sessionId: session.id,
      channelMessageKey: "message-1",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "main" },
      content: { text: "second copy" },
      rawPayload: null,
      createdAt: now + 1,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(connection.db.select().from(messages).all()).toHaveLength(1);
    expect(connection.db.select().from(sessionTimelineEntries).all()).toMatchObject([
      { sessionId: session.id, messageId: first.row.id, entryKind: "message" },
    ]);

    connection.close();
  });

  test("appendMessage promotes an existing session reference entry", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    const session = sessionRow(connection.db,{
      id: "session-thread",
      surfaceKey: "feishu:main:group:thread",
      channelId: "main",
      groupId: "group-1",
      title: "Thread",
      now,
    });
    connection.db.insert(sessions).values(session).run();
    const message = new MessageStore(connection.db).appendOnce({
      sessionId: session.id,
      channelMessageKey: "message-promote",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "main" },
      content: { text: "message body" },
      rawPayload: null,
      createdAt: now,
    });
    connection.db.delete(sessionTimelineEntries).run();

    const timelineStore = new SessionTimelineStore(connection.db);
    const reference = timelineStore.appendReference({
      sessionId: session.id,
      messageId: message.row.id,
    });
    const promoted = timelineStore.appendMessage({
      sessionId: session.id,
      messageId: message.row.id,
    });

    expect(promoted.id).toBe(reference.id);
    expect(connection.db.select().from(sessionTimelineEntries).all()).toMatchObject([
      { id: reference.id, entryKind: "message" },
    ]);

    connection.close();
  });

  test("append rejects a message without a persisted session scope", async () => {
    const connection = await openFreshDatabase();
    const store = new MessageStore(connection.db);

    expect(() =>
      store.appendOnce({
        sessionId: "missing-session",
        channelMessageKey: "message-unknown-channel",
        senderUserId: "user-1",
        role: "user",
        content: { text: "orphan message" },
        rawPayload: null,
      }),
    ).toThrow("message_session_scope_required");
    expect(connection.db.select().from(messages).all()).toHaveLength(0);

    connection.close();
  });

  test("appendOnce rejects user writes without a canonical sender user", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values(
        sessionRow(connection.db,{
          id: "session-strict-sender",
          surfaceKey: "feishu:main:p2p:strict-sender",
          channelId: "main",
          groupId: null,
          title: "Strict sender",
          now,
        }),
      )
      .run();
    const store = new MessageStore(connection.db);

    expect(() =>
      store.appendOnce({
        sessionId: "session-strict-sender",
        channelMessageKey: "missing-sender",
        role: "user",
        content: { text: "no sender" },
        createdAt: now,
      }),
    ).toThrow(/canonical user/i);
    expect(connection.db.select().from(messages).all()).toHaveLength(0);

    connection.close();
  });

  test("appendOnce materializes a concrete bot user for assistant messages from sender identity", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values(
        sessionRow(connection.db,{
          id: "session-assistant-user",
          surfaceKey: "feishu:main:p2p:assistant-user",
          channelId: "main",
          groupId: null,
          title: "Assistant sender",
          now,
        }),
      )
      .run();
    const store = new MessageStore(connection.db);

    const result = store.appendOnce({
      sessionId: "session-assistant-user",
      channelMessageKey: "assistant-1",
      role: "assistant",
      content: { text: "hello" },
      channel: { type: "feishu", id: "main" },
      surface: { externalId: "assistant-user", kind: "p2p" },
      sender: {
        externalId: "luna-bot",
        kind: "bot",
        displayName: "Monkey King",
        providerIds: { open_id: "ou_luna_bot" },
      },
      createdAt: now,
    });

    expect(result.row.sender_user_id).toEqual(expect.any(String));
    expect(result.row.senderIdentityId).toEqual(expect.any(String));
    expect(
      connection.db.select().from(users).all().find((row) => row.id === result.row.sender_user_id),
    ).toMatchObject({
      id: result.row.sender_user_id,
      kind: "bot",
      displayName: "Monkey King",
      profileSource: "channel",
    });

    connection.close();
  });

  test("appendOnce rejects assistant messages without a resolved sender", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values(
        sessionRow(connection.db,{
          id: "session-assistant-fallback",
          surfaceKey: "feishu:main:p2p:assistant-fallback",
          channelId: "main",
          groupId: null,
          title: "Assistant fallback",
          now,
        }),
      )
      .run();
    const store = new MessageStore(connection.db);

    expect(() => store.appendOnce({
      sessionId: "session-assistant-fallback",
      channelMessageKey: "assistant-fallback-1",
      role: "assistant",
      content: { text: "hello" },
      createdAt: now,
    })).toThrow("Message sender must resolve to a canonical user");
    expect(connection.db.select().from(messages).all()).toHaveLength(0);
    expect(connection.db.select().from(sessionTimelineEntries).all()).toHaveLength(0);
    expect(connection.db.select().from(users).all().some(row => row.id === LUNA_SYSTEM_USER_ID)).toBe(false);

    connection.close();
  });

  test("appendOnce materializes bot users from sender raw profile bot signal", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values(
        sessionRow(connection.db,{
          id: "session-bot-sender",
          surfaceKey: "feishu:main:p2p:bot-sender",
          channelId: "main",
          groupId: null,
          title: "Bot sender",
          now,
        }),
      )
      .run();
    const store = new MessageStore(connection.db);

    const result = store.appendOnce({
      sessionId: "session-bot-sender",
      channelMessageKey: "bot-user-1",
      senderUserId: "user-bot-profile",
      role: "user",
      channel: { type: "feishu", id: "main" },
      sender: {
        externalId: "ou_bot_profile",
        kind: "user",
        displayName: "Aime Assistant",
        rawProfile: {
          mentioned_type: "bot",
          name: "Aime Assistant",
        },
      },
      content: { text: "hello from bot identity" },
      rawPayload: null,
      createdAt: now,
    });

    expect(result.row.sender_user_id).toBe("user-bot-profile");
    expect(
      connection.db.select().from(users).all().find((row) => row.id === "user-bot-profile"),
    ).toMatchObject({
      id: "user-bot-profile",
      kind: "bot",
      displayName: "Aime Assistant",
      profileSource: "channel",
    });

    connection.close();
  });

  test("appendOnce keeps inbound id as legacy channel message key", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values(
        sessionRow(connection.db,{
          id: "session-inbound",
          surfaceKey: "feishu:main:group:inbound",
          channelId: "main",
          groupId: "group-1",
          title: "Inbound",
          now,
        }),
      )
      .run();
    const store = new MessageStore(connection.db);

    const result = store.appendOnce({
      sessionId: "session-inbound",
      role: "user",
      content: { text: "hello from inbound" },
      inbound: {
        id: "inbound-message-1",
        channel: { type: "feishu", id: "main" },
        surface: { externalId: "group-1", kind: "group" },
        sender: { externalId: "user-1", kind: "user" },
        text: "hello from inbound",
        mentions: [],
        addressing: { addressedToBot: true, reason: "p2p" },
      },
      createdAt: now,
    });

    expect(result.created).toBe(true);
    expect(result.row.channelMessageKey).toBe("inbound-message-1");
    expect(result.row.channel_message_key).toBe("inbound-message-1");

    connection.close();
  });

  test("appendOnce does not dedupe same external id across different channel ids", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values([
        sessionRow(connection.db,{
          id: "session-main",
          surfaceKey: "feishu:main:group:root",
          channelId: "main",
          groupId: "group-1",
          title: "Main",
          now,
        }),
        sessionRow(connection.db,{
          id: "session-alt",
          surfaceKey: "feishu:alt:group:root",
          channelId: "alt",
          groupId: "group-1",
          title: "Alt",
          now,
        }),
      ])
      .run();
    const store = new MessageStore(connection.db);

    const first = store.appendOnce({
      sessionId: "session-main",
      channelMessageKey: "message-shared",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "main" },
      content: { text: "main copy" },
      createdAt: now,
    });
    const second = store.appendOnce({
      sessionId: "session-alt",
      channelMessageKey: "message-shared",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "alt" },
      content: { text: "alt copy" },
      createdAt: now + 1,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.row.id).not.toBe(first.row.id);
    expect(connection.db.select().from(messages).all()).toHaveLength(2);

    connection.close();
  });

  test("appendBackfillMessage persists a user message with history_backfill metadata", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    fixtureSessionOwnership(connection.db,"feishu","feishu-main");
    const session = new SessionStore(connection.db).resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "oc_group_backfill",
    });

    const result = appendBackfillMessage({
      db: connection.db,
      sessionId: session.id,
      importedAt: 1_720_000_100_000,
      joinEventId: "join-event-1",
      occurredAt: 1_720_000_000_000,
      message: {
        id: "om_backfill_1",
        channel: { type: "feishu", id: "feishu-main" },
        surface: { kind: "group", externalId: "oc_group_backfill" },
        sender: {
          externalId: "ou_reporter",
          kind: "user",
          displayName: "Reporter",
        },
        text: "backfill text",
        mentions: [],
        addressing: { addressedToBot: false, reason: "silent_group" },
        rawPayload: { source: "test" },
      },
    });

    expect(result.created).toBe(true);
    expect(result.row.channel_message_key).toBe("om_backfill_1");
    expect(result.row.created_at).toBe(1_720_000_000_000);
    expect(result.row.raw_payload_json).toMatchObject({
      lunaIngest: {
        mode: "history_backfill",
        source: "group_join_backfill",
        importedAt: 1_720_000_100_000,
        joinEventId: "join-event-1",
      },
    });

    connection.close();
  });

  test("appendBackfillMessage is idempotent by provider message id and role", async () => {
    const connection = await openFreshDatabase();
    fixtureSessionOwnership(connection.db,"feishu","feishu-main");
    const session = new SessionStore(connection.db).resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "oc_group_backfill",
    });

    const input = {
      db: connection.db,
      sessionId: session.id,
      importedAt: 1_720_000_100_000,
      joinEventId: "join-event-1",
      occurredAt: 1_720_000_000_000,
      message: {
        id: "om_backfill_2",
        channel: { type: "feishu", id: "feishu-main" },
        surface: { kind: "group", externalId: "oc_group_backfill" },
        sender: {
          externalId: "ou_reporter",
          kind: "user",
          displayName: "Reporter",
        },
        text: "same message",
        mentions: [],
        addressing: { addressedToBot: false, reason: "silent_group" },
        rawPayload: { source: "test" },
      },
    } as const;

    const first = appendBackfillMessage(input);
    const second = appendBackfillMessage(input);

    expect(first.row.id).toBe(second.row.id);
    expect(second.created).toBe(false);
    expect(new SessionTimelineStore(connection.db).appendMessage({
      sessionId: session.id,
      messageId: first.row.id,
    }).entryKind).toBe("message");

    connection.close();
  });

  test("appendOnce dedupes cross-session messages from session channel metadata", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values([
        sessionRow(connection.db,{
          id: "session-root",
          surfaceKey: "feishu:main:group:root",
          channelId: "main",
          groupId: "group-1",
          title: "Root",
          now,
        }),
        sessionRow(connection.db,{
          id: "session-thread",
          surfaceKey: "feishu:main:group:thread",
          channelId: "main",
          groupId: "group-1",
          rootMessageKey: "message-1",
          threadKey: "thread-1",
          parentSessionId: "session-root",
          title: "Thread",
          now,
        }),
      ])
      .run();
    const store = new MessageStore(connection.db);
    const first = store.append({
      sessionId: "session-root",
      channelMessageKey: "message-1",
      senderUserId: "user-1",
      role: "user",
      content: { text: "root copy" },
      rawPayload: null,
      createdAt: now,
    });

    const second = store.appendOnce({
      sessionId: "session-thread",
      channelMessageKey: "message-1",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "main" },
      content: { text: "thread copy" },
      rawPayload: null,
      createdAt: now + 1,
    });

    expect(second).toMatchObject({
      created: false,
      row: { id: first.id, session_id: "session-root" },
    });
    expect(connection.db.select().from(messages).all()).toHaveLength(1);
    expect(connection.db.select().from(sessionTimelineEntries).all()).toMatchObject([
      { sessionId: "session-root", messageId: first.id, entryKind: "message" },
      { sessionId: "session-thread", messageId: first.id, entryKind: "reference" },
    ]);

    connection.close();
  });

  test("appendOnce rejects conflicting identity claims before persisting message", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values(
        sessionRow(connection.db,{
          id: "session-conflict",
          surfaceKey: "feishu:main:group:conflict",
          channelId: "main",
          groupId: "group-1",
          title: "Conflict",
          now,
        }),
      )
      .run();
    const channel = { type: "feishu", id: "main" };
    const directory = new ChannelDirectoryStore(connection.db);
    await directory.upsertIdentity({
      channel,
      identity: withLarkClaims({
        externalId: "ou_alice",
        kind: "user",
        displayName: "Alice",
        providerIds: {
          open_id: "ou_alice",
          union_id: "on_alice",
          tenant_key: "tenant-1",
        },
      }),
    });
    await directory.upsertIdentity({
      channel,
      identity: withLarkClaims({
        externalId: "ou_bob",
        kind: "user",
        displayName: "Bob",
        providerIds: {
          open_id: "ou_bob",
          union_id: "on_bob",
          tenant_key: "tenant-1",
        },
      }),
    });
    const store = new MessageStore(connection.db);

    expect(() =>
      store.appendOnce({
        sessionId: "session-conflict",
        channelMessageKey: "message-conflict",
        role: "user",
        channel,
        sender: withLarkClaims({
          externalId: "ou_alice",
          kind: "user",
          displayName: "Alice Conflict",
          providerIds: {
            open_id: "ou_alice",
            union_id: "on_bob",
            tenant_key: "tenant-1",
          },
        }),
        content: { text: "conflicting identity" },
        createdAt: now + 1,
      }),
    ).toThrow("Conflicting identity claims resolve to multiple users");
    expect(connection.db.select().from(messages).all()).toHaveLength(0);

    connection.close();
  });

  test("appendOnce rejects conflicting mention target claims before persisting message", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values(
        sessionRow(connection.db,{
          id: "session-mention-conflict",
          surfaceKey: "feishu:main:group:mention-conflict",
          channelId: "main",
          groupId: "group-1",
          title: "Mention Conflict",
          now,
        }),
      )
      .run();
    const channel = { type: "feishu", id: "main" };
    const directory = new ChannelDirectoryStore(connection.db);
    await directory.upsertIdentity({
      channel,
      identity: withLarkClaims({
        externalId: "ou_alice",
        kind: "user",
        displayName: "Alice",
        providerIds: {
          open_id: "ou_alice",
          union_id: "on_alice",
          tenant_key: "tenant-1",
        },
      }),
    });
    await directory.upsertIdentity({
      channel,
      identity: withLarkClaims({
        externalId: "ou_bob",
        kind: "user",
        displayName: "Bob",
        providerIds: {
          open_id: "ou_bob",
          union_id: "on_bob",
          tenant_key: "tenant-1",
        },
      }),
    });
    const store = new MessageStore(connection.db);

    expect(() =>
      store.appendOnce({
        sessionId: "session-mention-conflict",
        channelMessageKey: "message-mention-conflict",
        role: "user",
        channel,
        sender: withLarkClaims({
          externalId: "ou_sender",
          kind: "user",
          displayName: "Sender",
          providerIds: {
            open_id: "ou_sender",
            tenant_key: "tenant-1",
          },
        }),
        mentions: [
          {
            key: "@_user_1",
            label: "@Alice",
            target: withLarkClaims({
              externalId: "ou_alice",
              kind: "user",
              displayName: "Alice Conflict",
              providerIds: {
                open_id: "ou_alice",
                union_id: "on_bob",
                tenant_key: "tenant-1",
              },
            }),
          },
        ],
        content: { text: "@Alice conflicting identity" },
        createdAt: now + 1,
      }),
    ).toThrow("Conflicting identity claims resolve to multiple users");
    expect(connection.db.select().from(messages).all()).toHaveLength(0);
    expect(connection.db.select().from(sessionTimelineEntries).all()).toHaveLength(0);

    connection.close();
  });
});

describe("SessionTimelineReader", () => {
  test("paginates timeline entries with deterministic cursors", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values(
        sessionRow(connection.db,{
          id: "session-reader",
          surfaceKey: "feishu:main:group:reader",
          channelId: "main",
          groupId: "group-1",
          title: "Reader",
          now,
        }),
      )
      .run();
    const store = new MessageStore(connection.db);
    for (const messageId of ["message-1", "message-2", "message-3", "message-4"]) {
      store.appendOnce({
        sessionId: "session-reader",
        channelMessageKey: messageId,
        senderUserId: "user-1",
        role: "user",
        channel: { type: "feishu", id: "main" },
        content: { text: messageId },
        rawPayload: { message_type: "text", audit: messageId },
        createdAt: now,
      });
    }
    const reader = new SessionTimelineReader(connection.db);
    const all = reader.listForSession("session-reader");
    const entryIds = all.map((item) => item.entry.id);
    expect(entryIds).toHaveLength(4);
    const [entry1, entry2, , entry4] = entryIds as [
      string,
      string,
      string,
      string,
    ];

    expect(reader.listForSession("session-reader", { limit: 2 }).map(messageIds)).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(
      reader
        .listForSession("session-reader", {
          afterEntryId: entry2,
          limit: 2,
        })
        .map(messageIds),
    ).toEqual(["message-3", "message-4"]);
    expect(
      reader
        .listForSession("session-reader", {
          beforeEntryId: entry4,
          limit: 2,
        })
        .map(messageIds),
    ).toEqual(["message-2", "message-3"]);
    expect(
      reader
        .listForSession("session-reader", {
          afterEntryId: entry1,
          beforeEntryId: entry4,
          limit: 2,
        })
        .map(messageIds),
    ).toEqual(["message-2", "message-3"]);
    expect(
      reader.listForSession("session-reader", {
        afterEntryId: entry1,
        beforeEntryId: "missing-entry",
      }),
    ).toEqual([]);
    expect(
      reader.listForSession("session-reader", {
        afterEntryId: "missing-entry",
      }),
    ).toEqual([]);
    expect(
      reader.listForSession("other-session", {
        afterEntryId: entry1,
      }),
    ).toEqual([]);
    expect("rawPayloadJson" in all[0]!.message).toBe(false);
    expect("raw_payload_json" in all[0]!.message).toBe(false);

    connection.close();
  });

  test("orders reference entries by message occurrence time instead of projection time", async () => {
    const connection = await openFreshDatabase();
    const now = Date.now();
    connection.db
      .insert(sessions)
      .values([
        sessionRow(connection.db,{
          id: "session-root",
          surfaceKey: "feishu:main:group:root",
          channelId: "main",
          groupId: "group-1",
          title: "Root",
          now,
        }),
        sessionRow(connection.db,{
          id: "session-thread",
          surfaceKey: "feishu:main:group:thread",
          channelId: "main",
          groupId: "group-1",
          title: "Thread",
          now,
          parentSessionId: "session-root",
          rootMessageKey: "message-newer",
          threadKey: "message-newer",
        }),
      ])
      .run();
    const store = new MessageStore(connection.db);
    const older = store.appendOnce({
      sessionId: "session-root",
      channelMessageKey: "message-older",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "main" },
      content: { text: "older context" },
      rawPayload: { message_type: "text", audit: "message-older" },
      createdAt: now + 10,
    });
    const newer = store.appendOnce({
      sessionId: "session-root",
      channelMessageKey: "message-newer",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "main" },
      content: { text: "newer anchor" },
      rawPayload: { message_type: "text", audit: "message-newer" },
      createdAt: now + 30,
    });

    const timeline = new SessionTimelineStore(connection.db);
    timeline.appendReference({
      sessionId: "session-thread",
      messageId: newer.row.id,
    });
    timeline.appendReference({
      sessionId: "session-thread",
      messageId: older.row.id,
    });

    const reader = new SessionTimelineReader(connection.db);
    expect(reader.listForSession("session-thread").map(messageIds)).toEqual([
      "message-older",
      "message-newer",
    ]);

    connection.close();
  });
});

function messageIds(item: {
  readonly message: { readonly externalMessageId?: string };
}): string | undefined {
  return item.message.externalMessageId;
}

function sessionRow(db: import("../../src/data").DrizzleDB,input: {
  readonly id: string;
  readonly surfaceKey: string;
  readonly channelId: string;
  readonly groupId: string | null;
  readonly title: string;
  readonly now: number;
  readonly rootMessageKey?: string | null;
  readonly threadKey?: string | null;
  readonly parentSessionId?: string | null;
}): typeof sessions.$inferInsert {
  return {
    ...fixtureSessionOwnership(db,"feishu",input.channelId),
    id: input.id,
    surface_key: input.surfaceKey,
    channel_type: "feishu",
    channel_id: input.channelId,
    group_id: input.groupId,
    root_message_key: input.rootMessageKey ?? null,
    thread_key: input.threadKey ?? null,
    parent_session_id: input.parentSessionId ?? null,
    title: input.title,
    status: "active",
    created_by_user_id: "user-1",
    created_at: input.now,
    updated_at: input.now,
    last_activity_at: input.now,
  };
}
