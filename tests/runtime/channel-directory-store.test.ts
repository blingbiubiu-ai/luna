import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import {
  channelIdentities,
  channelSurfaces,
  messageMentions,
  users,
} from "../../src/data/schema";
import { MessageStore } from "../../src/sessions/message-store";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { SessionStore } from "../../src/sessions/session-store";

let homes: string[] = [];

async function openFreshDatabase(): Promise<DataConnection<typeof schema>> {
  const home = mkdtempSync(join(tmpdir(), "luna-channel-directory-"));
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

describe("ChannelDirectoryStore", () => {
  test("upserts identities by channel and external id", async () => {
    const connection = await openFreshDatabase();
    const store = new ChannelDirectoryStore(connection.db);

    const identity = await store.upsertIdentity({
      channel: { type: "feishu", id: "main" },
      identity: {
        externalId: "ou_1",
        kind: "user",
        displayName: "Alice",
        avatarUrl: "https://example.com/alice.png",
        providerIds: { open_id: "ou_1", user_id: "u_1" },
        rawProfile: { locale: "zh_cn" },
      },
    });
    const updated = await store.upsertIdentity({
      channel: { type: "feishu", id: "main" },
      identity: {
        externalId: "ou_1",
        kind: "user",
        displayName: "Alice Renamed",
        avatarUrl: "https://example.com/alice-new.png",
        providerIds: { open_id: "ou_1", union_id: "on_1" },
        rawProfile: { locale: "en_us" },
      },
    });

    expect(updated.id).toBe(identity.id);
    expect(updated.displayName).toBe("Alice Renamed");
    expect(updated.avatarUrl).toBe("https://example.com/alice-new.png");
    expect(updated.providerIds).toEqual({ open_id: "ou_1", union_id: "on_1" });
    expect(updated.rawProfile).toEqual({ locale: "en_us" });

    connection.close();
  });

  test("upserts group surfaces by channel and external id", async () => {
    const connection = await openFreshDatabase();
    const store = new ChannelDirectoryStore(connection.db);

    const surface = await store.upsertSurface({
      channel: { type: "feishu", id: "main" },
      surface: {
        externalId: "oc_1",
        kind: "group",
        displayName: "Luna Test Group",
        providerIds: { chat_id: "oc_1" },
        rawProfile: { owner: "ou_1" },
      },
    });

    expect(surface.externalId).toBe("oc_1");
    expect(surface.kind).toBe("group");
    expect(surface.displayName).toBe("Luna Test Group");
    expect(surface.providerIds).toEqual({ chat_id: "oc_1" });
    expect(surface.rawProfile).toEqual({ owner: "ou_1" });

    connection.close();
  });

  test("keeps existing provider-neutral profile fields when omitted", async () => {
    const connection = await openFreshDatabase();
    const store = new ChannelDirectoryStore(connection.db);

    const identity = await store.upsertIdentity({
      channel: { type: "feishu", id: "main" },
      identity: {
        externalId: "ou_1",
        kind: "user",
        displayName: "Alice",
        providerIds: { open_id: "ou_1" },
        rawProfile: { locale: "zh_cn" },
      },
    });
    const identityPartial = await store.upsertIdentity({
      channel: { type: "feishu", id: "main" },
      identity: {
        externalId: "ou_1",
        kind: "user",
      },
    });

    expect(identityPartial.id).toBe(identity.id);
    expect(identityPartial.displayName).toBe("Alice");
    expect(identityPartial.providerIds).toEqual({ open_id: "ou_1" });
    expect(identityPartial.rawProfile).toEqual({ locale: "zh_cn" });

    const surface = await store.upsertSurface({
      channel: { type: "feishu", id: "main" },
      surface: {
        externalId: "oc_1",
        kind: "group",
        displayName: "Luna Test Group",
        providerIds: { chat_id: "oc_1" },
        rawProfile: { owner: "ou_1" },
      },
    });
    const surfacePartial = await store.upsertSurface({
      channel: { type: "feishu", id: "main" },
      surface: {
        externalId: "oc_1",
        kind: "group",
      },
    });

    expect(surfacePartial.id).toBe(surface.id);
    expect(surfacePartial.displayName).toBe("Luna Test Group");
    expect(surfacePartial.providerIds).toEqual({ chat_id: "oc_1" });
    expect(surfacePartial.rawProfile).toEqual({ owner: "ou_1" });

    connection.close();
  });

  test("ensures mention target identity and returns bot target", async () => {
    const connection = await openFreshDatabase();
    const store = new ChannelDirectoryStore(connection.db);

    const target = await store.ensureMentionTarget({
      channel: { type: "feishu", id: "main" },
      mention: {
        key: "@_user_1",
        label: "@Luna",
        target: {
          externalId: "ou_bot",
          kind: "bot",
          displayName: "Luna",
          providerIds: { open_id: "ou_bot" },
          rawProfile: {
            key: "@_user_1",
            id: { open_id: "ou_bot" },
            name: "Luna",
            tenant_key: "tenant-1",
            mentioned_type: "bot",
          },
        },
      },
    });

    expect(target.externalId).toBe("ou_bot");
    expect(target.kind).toBe("bot");
    expect(target.displayName).toBeUndefined();
    expect(target.providerIds).toEqual({ open_id: "ou_bot" });
    expect(connection.db.select().from(users).all()).toHaveLength(0);

    connection.close();
  });

  test("materializes human mention targets into canonical users", async () => {
    const connection = await openFreshDatabase();
    const store = new ChannelDirectoryStore(connection.db);

    const target = await store.ensureMentionTarget({
      channel: { type: "feishu", id: "main" },
      mention: {
        key: "@_user_2",
        label: "@示例用户",
        target: {
          externalId: "ou_human",
          kind: "user",
          displayName: "示例用户",
          providerIds: { open_id: "ou_human", tenant_key: "tenant-1" },
          rawProfile: {
            key: "@_user_2",
            id: { open_id: "ou_human" },
            name: "示例用户",
            tenant_key: "tenant-1",
          },
        },
      },
    });

    expect(target.externalId).toBe("ou_human");
    expect(connection.db.select().from(users).all()).toEqual([
      expect.objectContaining({
        kind: "human",
        displayName: "示例用户",
      }),
    ]);

    connection.close();
  });

  test("does not persist low-confidence mention snapshot profile fields", async () => {
    const connection = await openFreshDatabase();
    const store = new ChannelDirectoryStore(connection.db);

    await store.ensureMentionTarget({
      channel: { type: "feishu", id: "main" },
      mention: {
        key: "@_user_2",
        label: "@影视Aime助理",
        target: {
          externalId: "ou_bot_weak",
          kind: "bot",
          displayName: "影视Aime助理",
          avatarUrl: "https://example.test/weak-bot.png",
          providerIds: { open_id: "ou_bot_weak", tenant_key: "tenant-1" },
          rawProfile: {
            key: "@_user_2",
            id: { open_id: "ou_bot_weak" },
            name: "影视Aime助理",
            tenant_key: "tenant-1",
            mentioned_type: "bot",
          },
        },
      },
    });

    const persisted = connection.db.select().from(channelIdentities).get();
    expect(persisted).toMatchObject({
      externalId: "ou_bot_weak",
      identityKind: "bot",
      displayName: null,
      avatarUrl: null,
    });

    connection.close();
  });

  test("repeated provider-neutral upserts keep a single row", async () => {
    const connection = await openFreshDatabase();
    const store = new ChannelDirectoryStore(connection.db);

    await Promise.all([
      store.upsertIdentity({
        channel: { type: "feishu", id: "main" },
        identity: { externalId: "ou_1", kind: "user", displayName: "Alice" },
      }),
      store.upsertIdentity({
        channel: { type: "feishu", id: "main" },
        identity: { externalId: "ou_1", kind: "user", displayName: "Alice" },
      }),
      store.upsertSurface({
        channel: { type: "feishu", id: "main" },
        surface: {
          externalId: "oc_1",
          kind: "group",
          displayName: "Luna Test Group",
        },
      }),
      store.upsertSurface({
        channel: { type: "feishu", id: "main" },
        surface: {
          externalId: "oc_1",
          kind: "group",
          displayName: "Luna Test Group",
        },
      }),
    ]);

    expect(connection.db.select().from(channelIdentities).all()).toHaveLength(1);
    expect(connection.db.select().from(channelSurfaces).all()).toHaveLength(1);

    connection.close();
  });

  test("message append persists related identities and structured mentions", async () => {
    const connection = await openFreshDatabase();
    fixtureSessionOwnership(connection.db, "feishu", "main");
    const session = new SessionStore(connection.db).resolveByChannelSurface({
      channelType: "feishu",
      channelId: "main",
      groupId: "oc_1",
    });

    new MessageStore(connection.db).append({
      sessionId: session.id,
      channelMessageKey: "om_merge_forward_1",
      role: "user",
      channel: { type: "feishu", id: "main" },
      surface: { externalId: "oc_1", kind: "p2p" },
      sender: {
        externalId: "ou_outer_sender",
        kind: "user",
        displayName: "Outer Sender",
        providerIds: { open_id: "ou_outer_sender" },
      },
      relatedIdentities: [
        {
          externalId: "ou_embedded_sender",
          kind: "user",
          providerIds: {
            open_id: "ou_embedded_sender",
            tenant_key: "tenant-1",
          },
        },
      ],
      mentions: [
        {
          key: "om_child_1:@_user_1",
          label: "@Mentioned User",
          target: {
            externalId: "ou_mentioned_user",
            kind: "user",
            displayName: "Mentioned User",
            providerIds: {
              open_id: "ou_mentioned_user",
              tenant_key: "tenant-1",
            },
          },
        },
      ],
      content: { text: "@Mentioned User hello" },
    });

    const identities = connection.db.select().from(channelIdentities).all();
    expect(identities.map((row) => row.externalId).sort()).toEqual([
      "ou_embedded_sender",
      "ou_mentioned_user",
      "ou_outer_sender",
    ]);

    const embeddedSender = identities.find(
      (row) => row.externalId === "ou_embedded_sender",
    );
    expect(embeddedSender?.providerIdsJson).toBe(
      '{"open_id":"ou_embedded_sender","tenant_key":"tenant-1"}',
    );

    const mentionRows = connection.db.select().from(messageMentions).all();
    expect(mentionRows).toEqual([
      expect.objectContaining({
        mentionKey: "om_child_1:@_user_1",
        mentionLabel: "@Mentioned User",
        targetExternalId: "ou_mentioned_user",
        targetKind: "user",
      }),
    ]);
    expect(mentionRows[0]?.targetIdentityId).toBe(
      identities.find((row) => row.externalId === "ou_mentioned_user")?.id,
    );

    connection.close();
  });
});
