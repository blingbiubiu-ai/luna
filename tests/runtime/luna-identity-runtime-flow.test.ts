import { fixtureSessionOwnership, fixtureTaskOwnership } from "../helpers/platform-fixtures";
import { expect, test } from "bun:test";

import {
  channelIdentities,
  sessions,
  sessionCommands,
  taskParticipants,
  taskSubscriptions,
  tasks,
  userIdentityLinks,
  users,
} from "../../src/data/schema";
import { createRuntimeHarnessForTest } from "./support/runtime-harness";

test("first Feishu message runs for a new human sender and keeps bot mentions out of canonical users", async () => {
  const harness = await createRuntimeHarnessForTest();
  try {
    await harness.emitFeishuMessage({
      messageId: "om_identity_human",
      senderOpenId: "ou_human",
      senderProfile: {
        openId: "ou_human",
        unionId: "on_human",
        userId: "user_human",
        tenantKey: "tenant-1",
        displayName: "示例用户",
        avatarUrl: "https://avatar.example/human.png",
      },
      text: "@Monkey King hello",
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Monkey King",
          mentioned_type: "bot",
        },
      ],
    });
    await harness.waitForIdle();

    const canonicalUsers = harness.db.select().from(users).all();
    expect(canonicalUsers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "human",
          displayName: "示例用户",
          avatarUrl: "https://avatar.example/human.png",
        }),
      ]),
    );
    const humanUser = canonicalUsers.find((user) => user.kind === "human" && user.displayName === "示例用户");
    const session = harness.db.select().from(sessions).get();
    const botUser = canonicalUsers.find((user) => user.id === session?.bot_user_id);
    expect(humanUser).toBeDefined();
    expect(botUser).toBeDefined();
    expect(botUser).toMatchObject({
      kind: "shadow",
    });
    expect(canonicalUsers.some(user => user.displayName === "Monkey King")).toBe(false);
    expect(harness.db.select().from(sessionCommands).all()).toEqual([expect.objectContaining({
      actorUserId: humanUser?.id, kind: "message.send", status: "sent",
    })]);
    expect(harness.countRows("tasks")).toBe(0);
    expect(harness.db.select().from(userIdentityLinks).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: humanUser?.id,
          identityNamespace: "feishu",
          identityKind: "open_id",
          identityValue: "ou_human",
          identityScope: "app:test:feishu:feishu-main",
        }),
        expect.objectContaining({
          userId: humanUser?.id,
          identityNamespace: "feishu",
          identityKind: "user_id",
          identityValue: "user_human",
          identityScope: "tenant:tenant-1",
        }),
      ]),
    );
    const rowCountsBeforeApiReads = {
      users: harness.countRows("users"),
      userIdentityLinks: harness.countRows("user_identity_links"),
    };
    if (humanUser === undefined) {
      throw new Error("expected human user to exist before Dashboard API reads");
    }
    expect(session).toBeDefined();
    const usersPath = `/api/users?agentId=${session!.agent_id}`;
    const usersResponse = await harness.fetchJson<{
      users: Array<{
        id: string;
        kind: string;
        displayName: string;
        linkedIdentities: Array<{
          identityNamespace: string;
          identityKind: string;
          identityValue: string;
        }>;
      }>;
    }>(usersPath);
    expect(usersResponse.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: humanUser?.id,
          kind: "human",
          displayName: "示例用户",
          linkedIdentities: expect.arrayContaining([
            expect.objectContaining({
              identityNamespace: "feishu",
              identityKind: "open_id",
              identityValue: "ou_human",
            }),
          ]),
        }),
      ]),
    );
    expect(usersResponse.users.find((user) => user.id === humanUser?.id)).not
      .toHaveProperty("principal");
    await harness.fetchJson(usersPath);
    expect(harness.countRows("user_identity_links")).toBe(
      rowCountsBeforeApiReads.userIdentityLinks,
    );
    expect(harness.countRows("users")).toBeGreaterThanOrEqual(
      rowCountsBeforeApiReads.users,
    );
  } finally {
    await harness.close();
  }
});

test("Feishu task runtime stores canonical requester and provider identity", async () => {
  const harness = await createRuntimeHarnessForTest();
  try {
    await harness.emitFeishuMessage({
      messageId: "om_identity_task",
      senderOpenId: "ou_task_requester",
      senderProfile: {
        openId: "ou_task_requester",
        unionId: "on_task_requester",
        userId: "user_task_requester",
        tenantKey: "tenant-1",
        displayName: "Task Requester",
      },
      text: "@Monkey King 排查 502",
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Monkey King",
          mentioned_type: "bot",
        },
      ],
    });
    await harness.waitForIdle();

    const canonicalUser = harness.db
      .select()
      .from(users)
      .all()
      .find((user) => user.displayName === "Task Requester");
    expect(canonicalUser).toBeDefined();
    if (canonicalUser === undefined) {
      throw new Error("expected canonical task requester");
    }
    const task = harness.db.select().from(tasks).get();
    expect(task?.creator_user_id).toBe(canonicalUser.id);
    expect(task?.creator_user_id).not.toBe("ou_task_requester");
    expect(task?.context_json).toMatchObject({
      requestedByIdentity: {
        provider: "feishu",
        externalUserId: "ou_task_requester",
        tenantKey: "tenant-1",
      },
    });
    expect(harness.db.select().from(taskParticipants).get()).toMatchObject({
      task_id: task?.id,
      user_id: canonicalUser.id,
      role: "requester",
    });
    harness.db
      .insert(channelIdentities)
      .values({
        id: "identity-collides-with-canonical-user-id",
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: canonicalUser.id,
        identityKind: "user",
        displayName: "Legacy External Id Collision",
        avatarUrl: null,
        providerIdsJson: JSON.stringify({ open_id: "ou_legacy_collision" }),
        rawProfileJson: null,
        firstSeenAt: "2026-06-21T00:00:00.000Z",
        lastSeenAt: "2026-06-21T00:00:00.000Z",
        profileUpdatedAt: null,
        createdAt: "2026-06-21T00:00:00.000Z",
        updatedAt: "2026-06-21T00:00:00.000Z",
      })
      .run();

    const dashboardTask = await harness.fetchJson<{
      creatorUserId: string | null;
      creatorUser: {
        id: string;
        displayName: string | null;
        kind: string;
      } | null;
      participants: Array<{
        userId: string;
        user: {
          id: string;
          displayName: string | null;
          kind: string;
        } | null;
      }>;
    }>(`/api/tasks/${task?.id}`);
    expect(dashboardTask.creatorUserId).toBe(canonicalUser.id);
    expect(dashboardTask.creatorUser).toMatchObject({
      id: canonicalUser.id,
      displayName: "Task Requester",
      kind: "human",
    });
    expect(dashboardTask.creatorUser?.displayName).not.toBe(
      "Legacy External Id Collision",
    );
    expect(dashboardTask.participants).toEqual([
      expect.objectContaining({
        userId: canonicalUser.id,
        user: expect.objectContaining({
          id: canonicalUser.id,
          displayName: "Task Requester",
          kind: "human",
        }),
      }),
    ]);
  } finally {
    await harness.close();
  }
});

test("Task API does not fall back to external-id identity for unlinked canonical user collision", async () => {
  const harness = await createRuntimeHarnessForTest();
  try {
    const now = Date.now();
    const isoNow = "2026-06-21T00:00:00.000Z";
    const ownership = fixtureSessionOwnership(harness.db, "feishu", "feishu-main", "local-dashboard-user");
    harness.db
      .insert(users)
      .values({
        id: "canonical-user-without-link",
        agentId: ownership.agent_id,
        kind: "human",
        displayName: "Canonical Without Link",
        avatarUrl: null,
        status: "active",
        mergedIntoUserId: null,
        profileSource: "manual",
        createdAt: isoNow,
        updatedAt: isoNow,
      })
      .run();
    harness.db
      .insert(sessions)
      .values({
        id: "session-canonical-collision",
        surface_key: "feishu:feishu-main:group-collision:root-collision:null",
        channel_type: "feishu",
        channel_id: "feishu-main",
        group_id: "group-collision",
        root_message_key: "root-collision",
        thread_key: null,
        parent_session_id: null,
        title: "Collision Session",
        status: "active",
        created_by_user_id: null,
        created_at: now,
        updated_at: now,
        last_activity_at: now, ...ownership})
      .run();
    harness.db
      .insert(channelIdentities)
      .values({
        id: "identity-external-id-collides-with-unlinked-user",
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "canonical-user-without-link",
        identityKind: "user",
        displayName: "Unrelated External Collision",
        avatarUrl: null,
        providerIdsJson: JSON.stringify({ open_id: "ou_unrelated_collision" }),
        rawProfileJson: null,
        firstSeenAt: isoNow,
        lastSeenAt: isoNow,
        profileUpdatedAt: null,
        createdAt: isoNow,
        updatedAt: isoNow,
      })
      .run();
    harness.db
      .insert(tasks)
      .values({
        id: "task-canonical-collision",
        type: "task",
        title: "Canonical collision",
        summary: "Canonical user id collides with an unrelated external id",
        status: "new",
        priority: "medium",
        severity: null,
        creator_user_id: "canonical-user-without-link",
        primary_session_id: "session-canonical-collision",
        source_message_id: null,
        source_entry_id: null,
        context_json: {},
        created_at: now,
        updated_at: now,
        last_activity_at: now, ...fixtureTaskOwnership(harness.db,"session-canonical-collision")})
      .run();
    harness.db
      .insert(taskParticipants)
      .values({
        id: "participant-canonical-collision",
        task_id: "task-canonical-collision",
        user_id: "canonical-user-without-link",
        role: "requester",
        created_at: now,
      })
      .run();
    harness.db
      .insert(taskSubscriptions)
      .values({
        id: "subscription-canonical-collision",
        task_id: "task-canonical-collision",
        session_id: "session-canonical-collision",
        channel_type: "feishu",
        channel_id: "feishu-main",
        group_id: "group-collision",
        thread_key: null,
        root_message_key: "root-collision",
        surface_key: "feishu:feishu-main:group-collision:root-collision:null",
        visibility: "full",
        notification_level: "major_updates",
        created_at: now,
        updated_at: now,
      })
      .run();

    const dashboardTask = await harness.fetchJson<{
      creatorUser: { id: string; displayName: string | null } | null;
      participants: Array<{
        user: { id: string; displayName: string | null } | null;
      }>;
    }>("/api/tasks/task-canonical-collision");

    expect(dashboardTask.creatorUser).toMatchObject({
      id: "canonical-user-without-link",
      displayName: "Canonical Without Link",
    });
    expect(dashboardTask.participants[0]?.user).toMatchObject({
      id: "canonical-user-without-link",
      displayName: "Canonical Without Link",
    });
  } finally {
    await harness.close();
  }
});

test("Task API does not render channel identity when raw open_id is stored as creator user id", async () => {
  const harness = await createRuntimeHarnessForTest();
  try {
    const now = Date.now();
    const isoNow = "2026-06-21T00:00:00.000Z";
    harness.db
      .insert(sessions)
      .values({
        id: "session-open-id-fallback",
        surface_key: "feishu:feishu-main:group-open-id:root-open-id:null",
        channel_type: "feishu",
        channel_id: "feishu-main",
        group_id: "group-open-id",
        root_message_key: "root-open-id",
        thread_key: null,
        parent_session_id: null,
        title: "Open ID Fallback Session",
        status: "active",
        created_by_user_id: null,
        created_at: now,
        updated_at: now,
        last_activity_at: now, ...fixtureSessionOwnership(harness.db, "feishu", "feishu-main", "local-dashboard-user")})
      .run();
    harness.db
      .insert(channelIdentities)
      .values({
        id: "identity-open-id-fallback",
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "ou_bad_creator",
        identityKind: "user",
        displayName: "Raw Open ID Channel User",
        avatarUrl: null,
        providerIdsJson: JSON.stringify({ open_id: "ou_bad_creator" }),
        rawProfileJson: null,
        firstSeenAt: isoNow,
        lastSeenAt: isoNow,
        profileUpdatedAt: null,
        createdAt: isoNow,
        updatedAt: isoNow,
      })
      .run();
    const badTask = {
        id: "task-open-id-fallback",
        type: "task",
        title: "Bad creator id",
        summary: "Raw open_id was stored in creator_user_id",
        status: "new",
        priority: "medium",
        severity: null,
        creator_user_id: "ou_bad_creator",
        primary_session_id: "session-open-id-fallback",
        source_message_id: null,
        source_entry_id: null,
        context_json: {},
        created_at: now,
        updated_at: now,
        last_activity_at: now, ...fixtureTaskOwnership(harness.db,"session-open-id-fallback")};
    // A raw open_id is not a user of the Agent, so it can no longer be stored as a task creator.
    expect(() => harness.db.insert(tasks).values(badTask).run()).toThrow("user_agent_mismatch");
    harness.db.insert(tasks).values({ ...badTask, creator_user_id: null }).run();
    harness.db
      .insert(taskParticipants)
      .values({
        id: "participant-open-id-fallback",
        task_id: "task-open-id-fallback",
        user_id: "ou_bad_creator",
        role: "requester",
        created_at: now,
      })
      .run();
    harness.db
      .insert(taskSubscriptions)
      .values({
        id: "subscription-open-id-fallback",
        task_id: "task-open-id-fallback",
        session_id: "session-open-id-fallback",
        channel_type: "feishu",
        channel_id: "feishu-main",
        group_id: "group-open-id",
        thread_key: null,
        root_message_key: "root-open-id",
        surface_key: "feishu:feishu-main:group-open-id:root-open-id:null",
        visibility: "full",
        notification_level: "major_updates",
        created_at: now,
        updated_at: now,
      })
      .run();

    const dashboardTask = await harness.fetchJson<{
      creatorUserId: string | null;
      creatorUser: { displayName: string | null } | null;
      participants: Array<{
        userId: string;
        user: { displayName: string | null } | null;
      }>;
    }>("/api/tasks/task-open-id-fallback");

    expect(dashboardTask.creatorUserId).toBeNull();
    expect(dashboardTask.creatorUser).toBeNull();
    expect(dashboardTask.participants).toEqual([
      expect.objectContaining({
        userId: "ou_bad_creator",
        user: null,
      }),
    ]);
  } finally {
    await harness.close();
  }
});
