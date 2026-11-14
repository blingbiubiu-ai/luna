import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { ContextPackStore } from "../../src/context";
import { DataConnection, type DrizzleDB } from "../../src/data";
import * as schema from "../../src/data/schema";
import { config, setLunaHome } from "../../src/shared/config/index";
import { moveTimelineEntriesToCanonicalSession } from "../../src/sessions/session-timeline-merge";
import { fixtureNamedSession, fixtureRunnerContext, fixtureTaskOwnership } from "../helpers/platform-fixtures";

const databases: {home: string; connection: DataConnection<typeof schema>}[] = [];
let originalHome: string | undefined;
const owner = "context-test-owner";

function openFreshDatabase(): DataConnection<typeof schema> {
  const home = mkdtempSync(join(tmpdir(), "luna-context-pack-store-"));
  originalHome ??= config.paths.home;
  setLunaHome(home);
  const connection = new DataConnection(schema);
  databases.push({home, connection});
  return connection;
}

afterEach(() => {
  for (const {home, connection} of databases.splice(0)) {
    connection.close();
    rmSync(home, {recursive: true, force: true});
  }
  if (originalHome !== undefined) {
    setLunaHome(originalHome);
    originalHome = undefined;
  }
});

function seedTask(db: DrizzleDB, taskId: string, sessionId: string) {
  db.insert(schema.tasks).values({
    ...fixtureTaskOwnership(db, sessionId), id: taskId, primary_session_id: sessionId, creator_user_id: owner,
    type: "work", title: taskId, status: "completed", created_at: 1, updated_at: 1, last_activity_at: 1,
  }).run();
}

function seedMessage(db: DrizzleDB, sessionId: string, messageId: string, entryId?: string, senderIdentityId?: string) {
  const scope = fixtureTaskOwnership(db, sessionId);
  db.insert(schema.messages).values({
    id: messageId, agentId: scope.agent_id, shadowId: scope.shadow_id, ownerSessionId: sessionId,
    channelType: "dashboard", channelId: "dashboard", externalMessageId: messageId,
    senderUserId: owner, senderIdentityId, role: "user", contentKind: "text", presentationKind: "plain",
    contentJson: [{type: "text", text: messageId}], occurredAt: 1, createdAt: 1,
  }).run();
  if (entryId) {
    db.insert(schema.sessionTimelineEntries).values({
      id: entryId, sessionId, messageId, entryKind: "message", createdAt: 1,
    }).run();
  }
}

function seedTaskSource(db: DrizzleDB, taskId = "task_1", sessionId = "session_1", messageId = "msg_1", entryId = "entry_1") {
  fixtureNamedSession(db, sessionId, owner);
  seedTask(db, taskId, sessionId);
  seedMessage(db, sessionId, messageId, entryId, "identity_1");
}

function seedRunnerInput(db: DrizzleDB, store: ContextPackStore) {
  seedTaskSource(db);
  seedMessage(db, "session_1", "msg_2", "entry_2");
  const pack = store.createPack({ownerType: "task", ownerId: "task_1", kind: "task_launch", selectionStrategy: "source_turn"});
  const [firstItem, secondItem] = store.addItems(pack.id, ["msg_1", "msg_2"].map(itemId => ({
    itemKind: "message", itemId, role: "context", reason: "runner seed fixture",
  })));
  db.insert(schema.runnerContexts).values(fixtureRunnerContext(db, {
    id: "runner_context_1", owner_type: "task", owner_id: "task_1", runner_type: "test",
    runner_root_path: "/unused", created_at: 1, updated_at: 1,
  })).run();
  return {
    input: {
      runnerContextId: "runner_context_1", ownerType: "task" as const, ownerId: "task_1",
      seedContextPackId: pack.id, seedHash: "hash_1", seedEntryIdsJson: ["entry_1"], seedContextItemIdsJson: [firstItem!.id],
    },
    secondItemId: secondItem!.id,
  };
}

describe("ContextPackStore", () => {
  test("appends task source items through semantic task source API", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    fixtureNamedSession(connection.db, "session_semantic", owner);
    seedTask(connection.db, "task_semantic", "session_semantic");
    seedMessage(connection.db, "session_semantic", "message_semantic");

    const first = store.appendTaskSourceItem({
      taskId: "task_semantic",
      sessionId: "session_semantic",
      messageId: "message_semantic",
      userId: "user_semantic",
      createdAt: 123,
    });
    const duplicate = store.appendTaskSourceItem({
      taskId: "task_semantic",
      sessionId: "session_semantic",
      messageId: "message_semantic",
      userId: "user_semantic",
      createdAt: 456,
    });

    expect(duplicate).toEqual(first);
    expect(store.findTaskIdForSourceMessage("message_semantic")).toBe(
      "task_semantic",
    );
    expect(
      store.hasTaskSourceForSession({
        taskId: "task_semantic",
        sessionId: "session_semantic",
      }),
    ).toBe(true);

    const [source] = store.listTaskSourceItems();
    expect(source).toMatchObject({
      id: first.id,
      contextPackId: first.contextPackId,
      taskId: "task_semantic",
      contextPackKind: "task_launch",
      sourceSessionId: "session_semantic",
      sourceEntryId: null,
      sourceMessageId: "message_semantic",
      sourceIdentityId: null,
      role: "source",
      reason: "task source message",
      displayOrder: 0,
      createdAt: 123,
    });

    const packs = store.listPacksForOwner("task", "task_semantic");
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      kind: "task_launch",
      selectionStrategy: "source_turn",
      triggerMessageId: "message_semantic",
      createdAt: 123,
    });
  });

  test("moves task source session references through semantic API", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    seedTaskSource(connection.db, "task_move", "session_source", "message_move");
    fixtureNamedSession(connection.db, "session_canonical", owner);

    store.appendTaskSourceItem({
      taskId: "task_move",
      sessionId: "session_source",
      messageId: "message_move",
      userId: "user_move",
      createdAt: 123,
    });

    moveTimelineEntriesToCanonicalSession(connection.db, "session_source", "session_canonical");
    store.moveSourceSessionReferences("session_source", "session_canonical");

    expect(
      store.hasTaskSourceForSession({
        taskId: "task_move",
        sessionId: "session_source",
      }),
    ).toBe(false);
    expect(
      store.hasTaskSourceForSession({
        taskId: "task_move",
        sessionId: "session_canonical",
      }),
    ).toBe(true);
    expect(store.listTaskSourceItems()[0]).toMatchObject({
      taskId: "task_move",
      sourceSessionId: "session_canonical",
      sourceMessageId: "message_move",
    });
  });

  test("moves session-owned context packs to canonical session", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    fixtureNamedSession(connection.db, "session_source", owner);
    fixtureNamedSession(connection.db, "session_canonical", owner);
    seedMessage(connection.db, "session_source", "message_move_owner", "entry_move_owner");
    const pack = store.createPack({
      ownerType: "session",
      ownerId: "session_source",
      kind: "group_activation",
      selectionStrategy: "deterministic_window",
      triggerEntryId: "entry_move_owner",
      triggerMessageId: "message_move_owner",
    });
    store.addItems(pack.id, [
      {
        itemKind: "timeline_entry",
        itemId: "entry_move_owner",
        sourceSessionId: "session_source",
        sourceEntryId: "entry_move_owner",
        sourceMessageId: "message_move_owner",
        role: "delta_context",
        reason: "group activation context",
      },
    ]);

    store.moveOwnerPacksToCanonicalSession(
      "session_source",
      "session_canonical",
    );

    expect(store.listPacksForOwner("session", "session_source")).toEqual([]);
    expect(store.listPacksForOwner("session", "session_canonical")).toEqual([
      expect.objectContaining({
        id: pack.id,
        ownerType: "session",
        ownerId: "session_canonical",
        kind: "group_activation",
      }),
    ]);
  });

  test("creates task source packs and reads task links", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    seedTaskSource(connection.db);

    const pack = store.createPack({
      ownerType: "task",
      ownerId: "task_1",
      kind: "task_launch",
      selectionStrategy: "source_turn",
      triggerEntryId: "entry_1",
      triggerMessageId: "msg_1",
      createdForInvocationId: "invocation_1",
      metadataJson: { source: "test" },
    });

    const items = store.addItems(pack.id, [
      {
        itemKind: "message",
        itemId: "msg_1",
        sourceSessionId: "session_1",
        sourceEntryId: "entry_1",
        sourceMessageId: "msg_1",
        sourceIdentityId: "identity_1",
        role: "source",
        reason: "task source message",
        displayOrder: 0,
        metadataJson: { source: "test" },
      },
    ]);

    expect(pack).toMatchObject({
      ownerType: "task",
      ownerId: "task_1",
      kind: "task_launch",
      selectionStrategy: "source_turn",
      triggerEntryId: "entry_1",
      triggerMessageId: "msg_1",
      createdForInvocationId: "invocation_1",
      metadataJson: { source: "test" },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      contextPackId: pack.id,
      itemKind: "message",
      itemId: "msg_1",
      sourceSessionId: "session_1",
      sourceEntryId: "entry_1",
      sourceMessageId: "msg_1",
      sourceIdentityId: "identity_1",
      role: "source",
      reason: "task source message",
      displayOrder: 0,
      metadataJson: { source: "test" },
    });

    expect(store.findTaskIdForSourceMessage("msg_1")).toBe("task_1");
    expect(store.listPacksForOwner("task", "task_1")).toEqual([pack]);
    expect(store.listItemsForPack(pack.id)).toEqual(items);
    expect(store.linkedSessionIdsForTask("task_1")).toEqual(["session_1"]);
  });

  test("assigns monotonic createdAt values when multiple packs are created in one millisecond", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    seedTaskSource(connection.db, "task_monotonic", "session_1", "message_first_update");
    seedMessage(connection.db, "session_1", "message_second_update");
    const originalNow = Date.now;
    Date.now = () => 10_000;
    try {
      const first = store.createPack({
        ownerType: "task",
        ownerId: "task_monotonic",
        kind: "task_update",
        selectionStrategy: "task_restart",
        triggerMessageId: "message_first_update",
      });
      const second = store.createPack({
        ownerType: "task",
        ownerId: "task_monotonic",
        kind: "task_update",
        selectionStrategy: "task_restart",
        triggerMessageId: "message_second_update",
      });

      expect(second.createdAt).toBeGreaterThan(first.createdAt);
      expect(store.listPacksForOwner("task", "task_monotonic").at(-1)).toMatchObject({
        id: second.id,
        triggerMessageId: "message_second_update",
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("records runner seeds idempotently", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    const {input} = seedRunnerInput(connection.db, store);
    const first = store.recordSeed(input);
    const second = store.recordSeed(input);

    expect(second).toEqual(first);
    expect(store.listSeedRecords("task", "task_1")).toEqual([first]);
  });

  test("rejects conflicting runner seed records", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    const {input, secondItemId} = seedRunnerInput(connection.db, store);
    seedTask(connection.db, "task_2", "session_1");
    const original = store.recordSeed(input);

    for (const override of [
      {seedHash: "hash_2"}, {seedEntryIdsJson: ["entry_2"]}, {seedContextItemIdsJson: [secondItemId]},
    ]) {
      expect(() => store.recordSeed({...input, ...override})).toThrow(/Conflicting runner context seed record/);
    }
    expect(() => store.recordSeed({...input, ownerType: "session", ownerId: "session_1"}))
      .toThrow("context_seed_owner_mismatch");
    expect(() => store.recordSeed({...input, ownerId: "task_2"})).toThrow("context_seed_owner_mismatch");
    expect(store.listSeedRecords("task", "task_1")).toEqual([original]);
  });

  test("adds duplicate pack items idempotently", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    seedTaskSource(connection.db);
    const pack = store.createPack({
      ownerType: "task",
      ownerId: "task_1",
      kind: "task_launch",
      selectionStrategy: "source_turn",
    });
    const input = {
      itemKind: "message",
      itemId: "msg_1",
      sourceSessionId: "session_1",
      sourceEntryId: "entry_1",
      sourceMessageId: "msg_1",
      role: "source",
      reason: "task source message",
      displayOrder: 0,
    } as const;

    const first = store.addItems(pack.id, [input]);
    const second = store.addItems(pack.id, [input]);

    expect(second).toEqual(first);
    expect(store.listItemsForPack(pack.id)).toEqual(first);
  });

  test("adds duplicate default-ordered pack items idempotently", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    seedTaskSource(connection.db);
    const pack = store.createPack({
      ownerType: "task",
      ownerId: "task_1",
      kind: "task_launch",
      selectionStrategy: "source_turn",
    });
    const input = {
      itemKind: "message",
      itemId: "msg_1",
      sourceSessionId: "session_1",
      sourceEntryId: "entry_1",
      sourceMessageId: "msg_1",
      role: "source",
      reason: "task source message",
    } as const;

    const first = store.addItems(pack.id, [input]);
    const second = store.addItems(pack.id, [input]);

    expect(first).toHaveLength(1);
    expect(first[0]?.displayOrder).toBe(0);
    expect(second).toEqual(first);
    expect(store.listItemsForPack(pack.id)).toEqual(first);
  });

  test("rejects conflicting duplicate pack items", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    seedTaskSource(connection.db);
    fixtureNamedSession(connection.db, "session_2", owner);
    seedMessage(connection.db, "session_2", "msg_2", "entry_2");
    const pack = store.createPack({ownerType: "task", ownerId: "task_1", kind: "task_launch", selectionStrategy: "source_turn"});
    const input = {
      itemKind: "message", itemId: "msg_1", sourceSessionId: "session_1", sourceEntryId: "entry_1",
      sourceMessageId: "msg_1", sourceIdentityId: "identity_1", role: "source", reason: "task source message",
      displayOrder: 0, metadataJson: {source: "test"},
    };
    const original = store.addItems(pack.id, [input]);

    for (const override of [
      {sourceEntryId: "entry_2"}, {sourceMessageId: "msg_2"}, {sourceSessionId: "session_2"},
    ]) {
      expect(() => store.addItems(pack.id, [{...input, ...override}])).toThrow("context_provenance_mismatch");
    }
    for (const override of [
      {sourceIdentityId: "identity_2"}, {reason: "different reason"}, {displayOrder: 9}, {metadataJson: {source: "different"}},
    ]) {
      expect(() => store.addItems(pack.id, [{...input, ...override}])).toThrow(/Conflicting context pack item/);
    }
    expect(store.listItemsForPack(pack.id)).toEqual(original);
  });

  test("appends default item display order after existing pack items", () => {
    const connection = openFreshDatabase();
    const store = new ContextPackStore(connection.db);
    seedTaskSource(connection.db, "task_1", "session_1", "msg_a");
    seedMessage(connection.db, "session_1", "msg_b");
    seedMessage(connection.db, "session_1", "msg_c");
    const pack = store.createPack({
      ownerType: "task",
      ownerId: "task_1",
      kind: "task_launch",
      selectionStrategy: "source_turn",
    });

    store.addItems(pack.id, [
      {
        itemKind: "message",
        itemId: "msg_a",
        role: "source",
        reason: "A",
      },
      {
        itemKind: "message",
        itemId: "msg_b",
        role: "source",
        reason: "B",
      },
    ]);
    store.addItems(pack.id, [
      {
        itemKind: "message",
        itemId: "msg_c",
        role: "source",
        reason: "C",
      },
    ]);

    const items = store.listItemsForPack(pack.id);
    expect(items.map((item) => item.itemId)).toEqual(["msg_a", "msg_b", "msg_c"]);
    expect(items.map((item) => item.displayOrder)).toEqual([0, 1, 2]);
  });
});
