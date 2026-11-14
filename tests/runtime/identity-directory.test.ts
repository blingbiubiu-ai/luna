import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { channelUserBindings, identityObservations, userIdentityLinks, users } from "../../src/data/schema";
import { IdentityDirectory } from "../../src/identity/identity-directory";

let homes: string[] = [];

async function openFreshDatabase(): Promise<DataConnection<typeof schema>> {
  const home = mkdtempSync(join(tmpdir(), "luna-identity-directory-"));
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
): T & {
  readonly identityClaims: readonly {
    readonly namespace: "lark";
    readonly kind: "open_id" | "union_id" | "user_id";
    readonly value: string;
    readonly scope: string;
    readonly confidence: "verified";
  }[];
} {
  const providerIds = identity.providerIds ?? {};
  const tenantScope =
    providerIds.tenant_key === undefined
      ? ""
      : `tenant:${providerIds.tenant_key}`;
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
              scope: "app:test-app",
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
              scope: "developer:test-dev",
              confidence: "verified" as const,
            },
          ]),
      ...(providerIds.user_id === undefined
        ? []
        : [
            {
              namespace: "lark" as const,
              kind: "user_id" as const,
              value: providerIds.user_id,
              scope: tenantScope,
              confidence: "verified" as const,
            },
          ]),
    ],
  };
}

describe("IdentityDirectory", () => {
  test("materializes a human Feishu identity into user and links without a principal", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const identity = withLarkClaims({
      externalId: "ou_user",
      kind: "user" as const,
      displayName: "Example Contributor",
      providerIds: {
        open_id: "ou_user",
        union_id: "on_user",
        tenant_key: "tenant-1",
      },
    });

    const persistedIdentity = await channels.upsertIdentity({
      channel,
      identity,
    });
    const materialized = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity,
    })!;

    const user = connection.db.select().from(users).get()!;
    expect(materialized).toEqual(
      expect.objectContaining({
        id: user.id,
        kind: "human",
        displayName: "Example Contributor",
      }),
    );
    expect(materialized).not.toHaveProperty("principalId");
    expect(user.kind).toBe("human");
    expect(user.displayName).toBe("Example Contributor");
    expect(connection.db.select().from(userIdentityLinks).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: user.id,
          identityNamespace: "lark",
          identityKind: "open_id",
          identityValue: "ou_user",
          identityScope: "app:test-app",
          confidence: "verified",
          isPrimary: true,
        }),
        expect.objectContaining({
          userId: user.id,
          identityNamespace: "lark",
          identityKind: "union_id",
          identityValue: "on_user",
          identityScope: "developer:test-dev",
          confidence: "verified",
        }),
      ]),
    );

    connection.close();
  });

  test("materializes a bot identity into bot user without a principal", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const identity = withLarkClaims({
      externalId: "ou_bot",
      kind: "bot" as const,
      displayName: "Monkey King",
      providerIds: { open_id: "ou_bot", tenant_key: "tenant-1" },
    });

    const persistedIdentity = await channels.upsertIdentity({
      channel,
      identity,
    });
    const materialized = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity,
    })!;

    const user = connection.db.select().from(users).get()!;
    expect(materialized.id).toBe(user.id);
    expect(materialized).not.toHaveProperty("principalId");
    expect(user.kind).toBe("bot");
    expect(connection.db.select().from(userIdentityLinks).get()).toMatchObject({
      userId: user.id,
      identityNamespace: "lark",
      identityKind: "open_id",
      identityValue: "ou_bot",
      identityScope: "app:test-app",
    });

    connection.close();
  });

  test("materializes a bot user when raw profile marks a nominal user identity as bot", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const identity = withLarkClaims({
      externalId: "ou_bot_profile",
      kind: "user" as const,
      displayName: "Aime Assistant",
      providerIds: { open_id: "ou_bot_profile", tenant_key: "tenant-1" },
      rawProfile: {
        mentioned_type: "bot",
        name: "Aime Assistant",
      },
    });

    const persistedIdentity = await channels.upsertIdentity({
      channel,
      identity,
    });
    const materialized = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity,
    })!;

    const user = connection.db.select().from(users).get()!;
    expect(materialized.kind).toBe("bot");
    expect(user.kind).toBe("bot");

    connection.close();
  });

  test("persists mention names as fallback without trusting their avatar", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const identity = withLarkClaims({
      externalId: "ou_bot_mention_only",
      kind: "user" as const,
      displayName: "影视Aime助理",
      providerIds: { open_id: "ou_bot_mention_only", tenant_key: "tenant-1" },
      rawProfile: {
        key: "@_user_1",
        id: { open_id: "ou_bot_mention_only" },
        name: "影视Aime助理",
        tenant_key: "tenant-1",
        mentioned_type: "bot",
      },
    });

    const persistedIdentity = await channels.upsertIdentity({
      channel,
      identity,
    });
    const materialized = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity,
    })!;

    const user = connection.db.select().from(users).get()!;
    expect(materialized).toMatchObject({
      id: user.id,
      kind: "bot",
      displayName: "影视Aime助理",
    });
    expect(user).toMatchObject({
      kind: "bot",
      displayName: "影视Aime助理",
      avatarUrl: null,
      profileSource: "mention",
    });

    connection.close();
  });

  test("later strong profile updates can replace previously empty canonical fields", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };

    const weakIdentity = withLarkClaims({
      externalId: "ou_bot_rehydrated",
      kind: "user" as const,
      displayName: "影视Aime助理",
      providerIds: { open_id: "ou_bot_rehydrated", tenant_key: "tenant-1" },
      rawProfile: {
        key: "@_user_1",
        id: { open_id: "ou_bot_rehydrated" },
        name: "影视Aime助理",
        tenant_key: "tenant-1",
        mentioned_type: "bot",
      },
    });
    const weakPersisted = await channels.upsertIdentity({
      channel,
      identity: weakIdentity,
    });
    directory.materializeChannelIdentity({
      channel,
      channelIdentityId: weakPersisted.id,
      identity: weakIdentity,
    });

    const strongIdentity = withLarkClaims({
      externalId: "ou_bot_rehydrated",
      kind: "bot" as const,
      displayName: "影视Aime助理",
      avatarUrl: "https://example.test/aime.png",
      providerIds: {
        open_id: "ou_bot_rehydrated",
        user_id: "u_bot_rehydrated",
        tenant_key: "tenant-1",
      },
      rawProfile: {
        open_id: "ou_bot_rehydrated",
        user_id: "u_bot_rehydrated",
        name: "影视Aime助理",
        avatar_url: "https://example.test/aime.png",
      },
    });
    const strongPersisted = await channels.upsertIdentity({
      channel,
      identity: strongIdentity,
    });
    const materialized = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: strongPersisted.id,
      identity: strongIdentity,
    })!;

    const user = connection.db.select().from(users).get()!;
    expect(materialized).toMatchObject({
      id: user.id,
      kind: "bot",
      displayName: "影视Aime助理",
    });
    expect(user).toMatchObject({
      kind: "bot",
      displayName: "影视Aime助理",
      avatarUrl: "https://example.test/aime.png",
    });

    connection.close();
  });

  test("rejects conflicting bot identities without implicitly merging users", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };

    const appOnlyIdentity = {
      externalId: "cli_monkey_king",
      kind: "bot" as const,
      displayName: "Monkey King",
      avatarUrl: "https://example.test/monkey.png",
      providerIds: {
        app_id: "cli_monkey_king",
        tenant_key: "tenant-1",
      },
      rawProfile: {
        sender_type: "app",
      },
    };
    const appOnlyPersisted = await channels.upsertIdentity({
      channel,
      identity: appOnlyIdentity,
    });
    const duplicate = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: appOnlyPersisted.id,
      identity: appOnlyIdentity,
    })!;

    const mentionBotIdentity = withLarkClaims({
      externalId: "ou_monkey_king",
      kind: "bot" as const,
      displayName: "Monkey King",
      avatarUrl: "https://example.test/monkey.png",
      providerIds: {
        open_id: "ou_monkey_king",
        union_id: "on_monkey_king",
        tenant_key: "tenant-1",
      },
      rawProfile: {
        mentioned_type: "bot",
      },
    });
    const mentionPersisted = await channels.upsertIdentity({
      channel,
      identity: mentionBotIdentity,
    });
    const canonical = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: mentionPersisted.id,
      identity: mentionBotIdentity,
    })!;

    const appSenderIdentity = {
      externalId: "cli_monkey_king",
      kind: "bot" as const,
      displayName: "Monkey King",
      avatarUrl: "https://example.test/monkey.png",
      providerIds: {
        app_id: "cli_monkey_king",
        open_id: "ou_monkey_king",
        union_id: "on_monkey_king",
        tenant_key: "tenant-1",
      },
      identityClaims: [
        {
          namespace: "lark" as const,
          kind: "open_id" as const,
          value: "ou_monkey_king",
          scope: "app:test-app",
          confidence: "verified" as const,
        },
        {
          namespace: "lark" as const,
          kind: "union_id" as const,
          value: "on_monkey_king",
          scope: "developer:test-dev",
          confidence: "verified" as const,
        },
      ],
      rawProfile: {
        sender_type: "app",
      },
    };
    expect(() => channels.upsertIdentity({channel, identity: appSenderIdentity})).toThrow("identity_conflict");
    const allUsers = connection.db.select().from(users).all();
    expect(allUsers).toHaveLength(2);
    expect(allUsers.every(user => user.status === "active" && user.mergedIntoUserId === null)).toBe(true);
    expect(connection.db.select().from(channelUserBindings)
      .where(eq(channelUserBindings.channelIdentityId, appOnlyPersisted.id)).get()?.userId).toBe(duplicate.id);
    expect(canonical.id).not.toBe(duplicate.id);

    connection.close();
  });

  test("throws when verified claims already resolve to different users without moving links", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const aliceIdentity = withLarkClaims({
      externalId: "ou_alice",
      kind: "user" as const,
      displayName: "Alice",
      providerIds: {
        open_id: "ou_alice",
        union_id: "on_alice",
        tenant_key: "tenant-1",
      },
    });
    const bobIdentity = withLarkClaims({
      externalId: "ou_bob",
      kind: "user" as const,
      displayName: "Bob",
      providerIds: {
        open_id: "ou_bob",
        union_id: "on_bob",
        tenant_key: "tenant-1",
      },
    });

    const alicePersisted = await channels.upsertIdentity({
      channel,
      identity: aliceIdentity,
    });
    const bobPersisted = await channels.upsertIdentity({
      channel,
      identity: bobIdentity,
    });
    const alice = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: alicePersisted.id,
      identity: aliceIdentity,
    })!;
    const bob = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: bobPersisted.id,
      identity: bobIdentity,
    })!;
    const bobUnionBefore = connection.db
      .select()
      .from(userIdentityLinks)
      .where(
        and(
          eq(userIdentityLinks.identityNamespace, "lark"),
          eq(userIdentityLinks.identityKind, "union_id"),
          eq(userIdentityLinks.identityValue, "on_bob"),
        ),
      )
      .get()!;

    expect(() =>
      directory.materializeChannelIdentity({
        channel,
        channelIdentityId: alicePersisted.id,
        identity: withLarkClaims({
          externalId: "ou_alice",
          kind: "user",
          displayName: "Alice Conflict",
          providerIds: {
            open_id: "ou_alice",
            union_id: "on_bob",
            tenant_key: "tenant-1",
          },
        }),
      }),
    ).toThrow("Conflicting identity claims resolve to multiple users");

    const bobUnionAfter = connection.db
      .select()
      .from(userIdentityLinks)
      .where(
        and(
          eq(userIdentityLinks.identityNamespace, "lark"),
          eq(userIdentityLinks.identityKind, "union_id"),
          eq(userIdentityLinks.identityValue, "on_bob"),
        ),
      )
      .get()!;
    expect(bobUnionAfter.userId).toBe(bob.id);
    expect(bobUnionAfter.userId).not.toBe(alice.id);
    expect(bobUnionAfter.userId).toBe(bobUnionBefore.userId);

    connection.close();
  });

  test("repeated materialization of the same verified identity reuses one user", async () => {
    const connection = await openFreshDatabase();
    const directory = new IdentityDirectory(connection.db);
    const originalDateNow = Date.now;
    let now = 1000;
    Date.now = () => now;

    try {
      const input = {
        kind: "human" as const,
        displayName: "Repeat User",
        channelIdentityId: "channel_identity_repeat",
        claims: [
          {
            namespace: "lark",
            kind: "open_id",
            value: "ou_repeat",
            scope: "app:test-app",
            confidence: "verified" as const,
          },
        ],
      };

      const first = directory.materializeIdentityClaims(input);
      const userBefore = connection.db.select().from(users).get()!;
      const linkBefore = connection.db.select().from(userIdentityLinks).get()!;
      now = 2000;
      const second = directory.materializeIdentityClaims(input);

      expect(second.id).toBe(first.id);
      expect(connection.db.select().from(users).all()).toHaveLength(1);
      expect(connection.db.select().from(userIdentityLinks).all()).toHaveLength(1);
      expect(connection.db.select().from(users).get()).toMatchObject({
        updatedAt: userBefore.updatedAt,
      });
      expect(connection.db.select().from(userIdentityLinks).get()).toMatchObject({
        updatedAt: linkBefore.updatedAt,
        isPrimary: linkBefore.isPrimary,
      });
    } finally {
      Date.now = originalDateNow;
    }

    expect(connection.db.select().from(users).all()).toHaveLength(1);
    expect(connection.db.select().from(userIdentityLinks).all()).toHaveLength(1);

    connection.close();
  });

  test("same channel identity reuses one user when stronger claims arrive later", async () => {
    const connection = await openFreshDatabase();
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const channelIdentityId = "channel_identity_monkey";

    const first = directory.materializeChannelIdentity({
      channel,
      channelIdentityId,
      identity: {
        externalId: "ou_bot",
        kind: "bot",
        displayName: "Monkey King",
      },
    })!;

    const second = directory.materializeChannelIdentity({
      channel,
      channelIdentityId,
      identity: withLarkClaims({
        externalId: "ou_bot",
        kind: "bot" as const,
        displayName: "Monkey King",
        providerIds: {
          open_id: "ou_bot",
          union_id: "on_bot",
          tenant_key: "tenant-1",
        },
      }),
    })!;

    expect(second.id).toBe(first.id);
    expect(connection.db.select().from(users).all()).toHaveLength(1);
    const linkedUserIds = connection.db
      .select()
      .from(channelUserBindings)
      .where(eq(channelUserBindings.channelIdentityId, channelIdentityId))
      .all()
      .map((link) => link.userId);
    expect(linkedUserIds).toHaveLength(1);
    expect(connection.db.select().from(identityObservations).where(eq(identityObservations.channelIdentityId, channelIdentityId)).all()).toHaveLength(3);
    expect(new Set(linkedUserIds)).toEqual(new Set([first.id]));

    connection.close();
  });

  test("refreshes channel-sourced user profile without refreshing a principal", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const initialIdentity = withLarkClaims({
      externalId: "ou_rename",
      kind: "user" as const,
      displayName: "Old Name",
      avatarUrl: "https://example.com/old.png",
      providerIds: { open_id: "ou_rename", tenant_key: "tenant-1" },
    });

    const persistedIdentity = await channels.upsertIdentity({
      channel,
      identity: initialIdentity,
    });
    const materialized = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity: initialIdentity,
    })!;
    directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity: {
        ...initialIdentity,
        displayName: "New Name",
        avatarUrl: "https://example.com/new.png",
      },
    });

    expect(
      connection.db
        .select()
        .from(users)
        .where(eq(users.id, materialized.id))
        .get(),
    ).toMatchObject({
      displayName: "New Name",
      avatarUrl: "https://example.com/new.png",
    });
    expect(materialized).not.toHaveProperty("principalId");

    connection.close();
  });

  test("rejects changing a human canonical identity into a bot", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const initialIdentity = withLarkClaims({
      externalId: "ou_kind_upgrade",
      kind: "user" as const,
      displayName: "Aime Assistant",
      providerIds: { open_id: "ou_kind_upgrade", tenant_key: "tenant-1" },
    });

    const persistedIdentity = await channels.upsertIdentity({
      channel,
      identity: initialIdentity,
    });
    const materialized = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity: initialIdentity,
    })!;
    expect(
      connection.db.select().from(users).where(eq(users.id, materialized.id)).get(),
    ).toMatchObject({ kind: "human" });

    expect(() => directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity: {
        ...initialIdentity,
        rawProfile: {
          mentioned_type: "bot",
          name: "Aime Assistant",
        },
      },
    })).toThrow("identity_conflict");

    expect(
      connection.db.select().from(users).where(eq(users.id, materialized.id)).get(),
    ).toMatchObject({ kind: "human" });

    connection.close();
  });

  test("materializes fallback external id claim for unknown provider types", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "webhook", id: "webhook-main" };
    const identity = {
      externalId: "ext_1",
      kind: "user" as const,
      displayName: "Webhook User",
    };

    const persistedIdentity = await channels.upsertIdentity({
      channel,
      identity,
    });
    const materialized = directory.materializeChannelIdentity({
      channel,
      channelIdentityId: persistedIdentity.id,
      identity,
    });

    expect(materialized?.kind).toBe("human");
    expect(connection.db.select().from(userIdentityLinks).get()).toMatchObject({
      userId: materialized?.id,
      identityNamespace: "webhook",
      identityKind: "external_id",
      identityValue: "ext_1",
      identityScope: "channel:webhook-main",
      confidence: "inferred",
    });

    connection.close();
  });

  test("does not materialize unknown channel identities", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const channel = { type: "feishu", id: "feishu-main" };
    const identity = {
      externalId: "unknown_1",
      kind: "unknown" as const,
      displayName: "Mystery",
    };

    const persistedIdentity = await channels.upsertIdentity({
      channel,
      identity,
    });

    expect(
      directory.materializeChannelIdentity({
        channel,
        channelIdentityId: persistedIdentity.id,
        identity,
      }),
    ).toBeNull();
    expect(connection.db.select().from(users).all()).toHaveLength(0);
    expect(connection.db.select().from(userIdentityLinks).all()).toHaveLength(0);

    connection.close();
  });

  test("same display name across Feishu and WeChat creates separate users without shared identity", async () => {
    const connection = await openFreshDatabase();
    const channels = new ChannelDirectoryStore(connection.db);
    const directory = new IdentityDirectory(connection.db);
    const displayName = "Alex";
    const feishuChannel = { type: "feishu", id: "feishu-main" };
    const wechatChannel = { type: "wechat", id: "wechat-main" };
    const feishuIdentity = {
      externalId: "ou_alex",
      kind: "user" as const,
      displayName,
      providerIds: { open_id: "ou_alex", tenant_key: "tenant-1" },
    };
    const wechatIdentity = {
      externalId: "wx_alex",
      kind: "user" as const,
      displayName,
      providerIds: { open_id: "wx_alex", org_id: "corp-1" },
    };

    const feishuPersisted = await channels.upsertIdentity({
      channel: feishuChannel,
      identity: feishuIdentity,
    });
    const wechatPersisted = await channels.upsertIdentity({
      channel: wechatChannel,
      identity: wechatIdentity,
    });
    const feishuUser = directory.materializeChannelIdentity({
      channel: feishuChannel,
      channelIdentityId: feishuPersisted.id,
      identity: feishuIdentity,
    });
    const wechatUser = directory.materializeChannelIdentity({
      channel: wechatChannel,
      channelIdentityId: wechatPersisted.id,
      identity: wechatIdentity,
    });

    expect(feishuUser?.id).not.toBe(wechatUser?.id);
    expect(connection.db.select().from(users).all()).toHaveLength(2);

    connection.close();
  });
});

test("shared verified claims retain both bot observations without overwriting channel bindings", async () => {
  const connection = await openFreshDatabase();
  try {
    const directory = new IdentityDirectory(connection.db);
    const shared = {namespace: "feishu", kind: "user_id", value: "same-person", scope: "tenant:company", confidence: "verified" as const};
    const first = directory.materializeIdentityClaims({kind: "human", displayName: "用户", channelIdentityId: "bot-a-user",
      claims: [shared, {namespace: "feishu", kind: "open_id", value: "ou_a", scope: "app:test-app", confidence: "verified"}]});
    const second = directory.materializeIdentityClaims({kind: "human", displayName: "用户", channelIdentityId: "bot-b-user",
      claims: [shared, {namespace: "feishu", kind: "open_id", value: "ou_b", scope: "app:test-app", confidence: "verified"}]});
    expect(second.id).toBe(first.id);
    expect(connection.db.select().from(channelUserBindings).all().map(binding => binding.userId)).toEqual([first.id, first.id]);
    const sharedClaim = connection.db.select().from(userIdentityLinks).where(eq(userIdentityLinks.identityKind, "user_id")).get()!;
    expect(connection.db.select().from(identityObservations).where(eq(identityObservations.claimId, sharedClaim.id)).all()).toHaveLength(2);
    directory.materializeIdentityClaims({kind: "human", displayName: "用户", channelIdentityId: "bot-a-user",
      claims: [{...shared, confidence: "inferred"}]});
    expect(connection.db.select().from(userIdentityLinks).where(eq(userIdentityLinks.id, sharedClaim.id)).get()?.confidence).toBe("verified");
  } finally {connection.close();}
});

test("an unverified external ID cannot link users across different robots", async () => {
  const connection = await openFreshDatabase();
  try {
    const channels = new ChannelDirectoryStore(connection.db);
    channels.upsertIdentity({channel: {type: "webhook", id: "robot-a"}, identity: {externalId: "42", kind: "user", displayName: "Same name"}});
    channels.upsertIdentity({channel: {type: "webhook", id: "robot-b"}, identity: {externalId: "42", kind: "user", displayName: "Same name"}});
    const bindings = connection.db.select().from(channelUserBindings).all();
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map(binding => binding.userId)).size).toBe(2);
  } finally {connection.close();}
});
