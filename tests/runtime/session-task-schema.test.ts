import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ContextPackStore,
  type AppendTaskSourceItemInput,
} from "../../src/context";
import * as schema from "../../src/data/schema";
import { DataConnection, type DrizzleDB } from "../../src/data";
import { MessageStore } from "@/sessions/message-store";
import { config, setLunaHome } from "@/shared";
import { fixtureNamedSession, fixtureTaskOwnership } from "../helpers/platform-fixtures";
import { SessionTimelineEventStore } from "../../src/sessions/session-timeline-event-store";

let fixture: {home: string; previousHome: string; sqlite: Database; connection: DataConnection<typeof schema>} | undefined;

function openFreshDatabase() {
  const previousHome = config.paths.home;
  const home = mkdtempSync(join(tmpdir(), "luna-schema-"));
  setLunaHome(home);
  const connection = new DataConnection(schema);
  const sqlite = new Database(join(home, "data", "luna.db"), {readonly: true});
  fixture = {home, previousHome, sqlite, connection};
  return {sqlite, connection};
}

afterEach(() => {
  if (!fixture) return;
  fixture.sqlite.close();
  fixture.connection.close();
  setLunaHome(fixture.previousHome);
  rmSync(fixture.home, {recursive: true, force: true});
  fixture = undefined;
});

function appendTaskSourceContextItem(
  db: DrizzleDB,
  input: AppendTaskSourceItemInput,
): void {
  new ContextPackStore(db).appendTaskSourceItem(input);
}

function findTaskIdForSourceMessage(
  db: DrizzleDB,
  messageId: string,
): string | undefined {
  return new ContextPackStore(db).findTaskIdForSourceMessage(messageId);
}

function selectTaskSourceContextItems(db: DrizzleDB) {
  return new ContextPackStore(db).listTaskSourceItems();
}

describe("session/task schema", () => {
  test("creates only session/task runtime tables", () => {
    const { sqlite } = openFreshDatabase();
    const tableNames = new Set(
      (
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    expect(tableNames.has("runtime_generations")).toBe(false);
    expect(tableNames.has("sessions")).toBe(true);
    expect(tableNames.has("messages")).toBe(true);
    expect(tableNames.has("message_mentions")).toBe(true);
    expect(tableNames.has("session_timeline_entries")).toBe(true);
    expect(tableNames.has("session_timeline_events")).toBe(true);
    expect(tableNames.has("session_turn_entries")).toBe(true);
    expect(tableNames.has("runner_action_records")).toBe(false);
    expect(tableNames.has("session_inbox")).toBe(true);
    expect(tableNames.has("session_turns")).toBe(true);
    expect(tableNames.has("session_runner_attempts")).toBe(true);
    expect(tableNames.has("session_states")).toBe(true);
    expect(tableNames.has("session_surface_aliases")).toBe(true);
    expect(tableNames.has("tasks")).toBe(true);
    expect(tableNames.has("task_sources")).toBe(false);
    expect(tableNames.has("context_packs")).toBe(true);
    expect(tableNames.has("context_pack_items")).toBe(true);
    expect(tableNames.has("runner_context_seed_records")).toBe(true);
    expect(tableNames.has("task_participants")).toBe(true);
    expect(tableNames.has("task_runs")).toBe(true);
    expect(tableNames.has("task_subscriptions")).toBe(true);
    expect(tableNames.has("timeline_events")).toBe(true);
    expect(tableNames.has("artifacts")).toBe(true);
    expect(tableNames.has("managed_artifacts")).toBe(true);
    expect(tableNames.has("channel_identities")).toBe(true);
    expect(tableNames.has("channel_message_markers")).toBe(true);
    expect(tableNames.has("channel_surfaces")).toBe(true);
    expect(tableNames.has("groups")).toBe(true);
    expect(tableNames.has("group_memberships")).toBe(true);
    expect(tableNames.has("authorization_rules")).toBe(true);

    expect(tableNames.has("conversations")).toBe(false);
    expect(tableNames.has("session_messages")).toBe(false);
    expect(tableNames.has("session_message_refs")).toBe(false);
    expect(tableNames.has("session_message_mentions")).toBe(false);
    expect(tableNames.has("conversation_inbox")).toBe(false);
    expect(tableNames.has("conversation_turns")).toBe(false);
    expect(tableNames.has("conversation_states")).toBe(false);
    expect(tableNames.has("conversation_surface_aliases")).toBe(false);
    expect(tableNames.has("conversation_message_refs")).toBe(false);
    expect(tableNames.has("cases")).toBe(false);
    expect(tableNames.has("case_sources")).toBe(false);
    expect(tableNames.has("case_participants")).toBe(false);
    expect(tableNames.has("case_runs")).toBe(false);
    expect(tableNames.has("case_subscriptions")).toBe(false);
    expect(tableNames.has("channel_users")).toBe(false);
    expect(tableNames.has("channel_chats")).toBe(false);
    expect(tableNames.has("principals")).toBe(false);
    expect(tableNames.has("principal_memberships")).toBe(false);
    expect(tableNames.has("principal_operation_grants")).toBe(false);

    expect(getColumnNames(sqlite, "context_packs")).toEqual([
      "id",
      "owner_type",
      "owner_id",
      "kind",
      "selection_strategy",
      "trigger_entry_id",
      "trigger_message_id",
      "created_for_invocation_id",
      "created_at",
      "metadata_json",
    ]);

    expect(getColumnNames(sqlite, "context_pack_items")).toEqual([
      "id",
      "context_pack_id",
      "item_kind",
      "item_id",
      "source_session_id",
      "source_entry_id",
      "source_message_id",
      "source_identity_id",
      "role",
      "reason",
      "display_order",
      "metadata_json",
    ]);

    expect(getColumnNames(sqlite, "runner_context_seed_records")).toEqual([
      "id",
      "runner_context_id",
      "owner_type",
      "owner_id",
      "seed_context_pack_id",
      "seed_hash",
      "seed_entry_ids_json",
      "seed_context_item_ids_json",
      "created_at",
    ]);

    expect(getColumnNames(sqlite, "runner_contexts")).toEqual([
      "id",
      "owner_type",
      "owner_id",
      "runner_type",
      "runner_session_id",
      "runner_root_path",
      "last_run_id",
      "created_at",
      "updated_at",
      "instruction_fingerprint",
      "provider_fingerprint",
      "model_fingerprint",
      "agent_id",
      "shadow_id",
    ]);
  });

  test("message timeline tables use normalized message columns", () => {
    const { sqlite } = openFreshDatabase();

    expect(getColumnNames(sqlite, "messages")).toEqual([
      "id",
      "channel_type",
      "channel_id",
      "external_message_id",
      "sender_user_id",
      "sender_identity_id",
      "role",
      "content_kind",
      "presentation_kind",
      "provider_message_type",
      "content_json",
      "raw_payload_json",
      "occurred_at",
      "created_at",
      "owner_session_id",
      "deleted_at",
      "agent_id",
      "shadow_id",
      "binding_id",
    ]);
    expect(requiredColumnNames(sqlite, "messages")).toEqual(expect.arrayContaining(["sender_user_id", "agent_id", "shadow_id"]));

    expect(getColumnNames(sqlite, "session_timeline_entries")).toEqual([
      "id",
      "session_id",
      "message_id",
      "entry_kind",
      "created_at",
    ]);

    expect(getColumnNames(sqlite, "session_timeline_events")).toEqual([
      "id",
      "session_id",
      "entry_id",
      "event_type",
      "control_kind",
      "reason_kind",
      "source_message_id",
      "anchor_message_id",
      "session_source_message_id",
      "turn_id",
      "summary",
      "payload_json",
      "created_at",
    ]);

    expect(getColumnNames(sqlite, "session_turn_entries")).toEqual([
      "id",
      "turn_id",
      "session_id",
      "entry_id",
      "role",
      "created_at",
    ]);

    expect(getColumnNames(sqlite, "session_turns")).toEqual([
      "id",
      "session_id",
      "turn_kind",
      "status",
      "runner_invoked",
      "reason",
      "materialized_prompt",
      "started_at",
      "completed_at",
      "error",
      "created_at",
      "updated_at",
    ]);

    expect(getColumnNames(sqlite, "session_runner_attempts")).toEqual([
      "id",
      "session_id",
      "turn_id",
      "runner_context_id",
      "runner_type",
      "runner_session_id",
      "attempt_kind",
      "attempt_index",
      "status",
      "input_prompt",
      "raw_output",
      "raw_output_truncated",
      "parsed_action_json",
      "parse_error_json",
      "repair_source_attempt_id",
      "started_at",
      "completed_at",
      "created_at",
      "updated_at",
    ]);

    expect(getColumnNames(sqlite, "session_inbox")).toEqual([
      "id",
      "session_id",
      "entry_id",
      "message_id",
      "sender_identity_id",
      "received_at",
      "status",
      "turn_id",
      "claimed_at",
      "completed_at",
      "error",
      "created_at",
      "updated_at",
      "lane",
      "due_now",
    ]);

    expect(getColumnNames(sqlite, "channel_message_markers")).toEqual([
      "id",
      "channel_type",
      "channel_id",
      "message_id",
      "marker_type",
      "provider_marker_id",
      "provider_payload_json",
      "created_at",
      "updated_at",
    ]);

    expect(getColumnNames(sqlite, "task_runs")).toEqual([
      "id",
      "task_id",
      "run_index",
      "status",
      "reason",
      "input_snapshot",
      "materialized_prompt",
      "runner_type",
      "runner_context_id",
      "source_message_id",
      "started_at",
      "finished_at",
      "cancel_reason",
      "error",
      "final_report_artifact_id",
    ]);

    expect(getColumnNames(sqlite, "channel_identities")).toEqual([
      "id",
      "channel_type",
      "channel_id",
      "external_id",
      "identity_kind",
      "display_name",
      "avatar_url",
      "provider_ids_json",
      "raw_profile_json",
      "first_seen_at",
      "last_seen_at",
      "profile_updated_at",
      "created_at",
      "updated_at",
    ]);

    expect(getColumnNames(sqlite, "channel_surfaces")).toEqual([
      "id",
      "channel_type",
      "channel_id",
      "external_id",
      "surface_kind",
      "display_name",
      "avatar_url",
      "provider_ids_json",
      "raw_profile_json",
      "first_seen_at",
      "last_seen_at",
      "profile_updated_at",
      "created_at",
      "updated_at",
    ]);

    expect(getColumnNames(sqlite, "message_mentions")).toEqual([
      "id",
      "message_id",
      "mention_key",
      "mention_label",
      "target_identity_id",
      "target_external_id",
      "target_kind",
      "raw_mention_json",
      "created_at",
    ]);
    expect(getColumnType(sqlite, "message_mentions", "created_at")).toBe(
      "INTEGER",
    );

    expect(getIndexes(sqlite, "sessions")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "sessions_parent_session_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "messages")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "messages_channel_external_role_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "messages_channel_sender_created_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "session_timeline_entries")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "session_timeline_entries_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "session_timeline_entries_session_created_idx",
          unique: 0,
        }),
        expect.objectContaining({
          name: "session_timeline_entries_message_idx",
          unique: 0,
        }),
      ]),
    );

    expect(getIndexes(sqlite, "session_timeline_events")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "session_timeline_events_source_control_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "session_timeline_events_session_created_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "channel_message_markers")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "channel_message_markers_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "channel_message_markers_channel_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "session_turns")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "session_turns_session_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "session_runner_attempts")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "session_runner_attempts_turn_idx",
          unique: 0,
        }),
        expect.objectContaining({
          name: "session_runner_attempts_session_idx",
          unique: 0,
        }),
        expect.objectContaining({
          name: "session_runner_attempts_repair_source_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "session_inbox")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "session_inbox_entry_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "session_inbox_queue_idx",
          unique: 0,
        }),
        expect.objectContaining({
          name: "session_inbox_turn_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "channel_identities")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "channel_identities_channel_external_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "channel_identities_kind_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "channel_surfaces")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "channel_surfaces_channel_external_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "channel_surfaces_kind_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "message_mentions")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "message_mentions_message_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "context_packs")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "context_packs_owner_idx",
          unique: 0,
        }),
        expect.objectContaining({
          name: "context_packs_trigger_entry_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "context_pack_items")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "context_pack_items_pack_item_role_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "context_pack_items_pack_role_idx",
          unique: 0,
        }),
        expect.objectContaining({
          name: "context_pack_items_source_message_idx",
          unique: 0,
        }),
        expect.objectContaining({
          name: "context_pack_items_source_entry_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getIndexes(sqlite, "runner_context_seed_records")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runner_context_seed_records_context_pack_unique",
          unique: 1,
        }),
        expect.objectContaining({
          name: "runner_context_seed_records_owner_idx",
          unique: 0,
        }),
      ]),
    );
    expect(getForeignKeys(sqlite, "message_mentions")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "target_identity_id",
          table: "channel_identities",
          to: "id",
          on_delete: "SET NULL",
        }),
        expect.objectContaining({
          from: "message_id",
          table: "messages",
          to: "id",
          on_delete: "CASCADE",
        }),
      ]),
    );
  });

  test("authorization tables use typed subjects instead of principals", () => {
    const { sqlite } = openFreshDatabase();

    expect(getColumnNames(sqlite, "users")).toEqual([
      "id",
      "agent_id",
      "account_id",
      "kind",
      "display_name",
      "avatar_url",
      "status",
      "merged_into_user_id",
      "profile_source",
      "created_at",
      "updated_at",
    ]);
    expect(getColumnNames(sqlite, "groups")).toEqual([
      "id",
      "slug",
      "display_name",
      "description",
      "avatar_url",
      "status",
      "created_at",
      "updated_at",
      "agent_id",
    ]);
    expect(getColumnNames(sqlite, "group_memberships")).toEqual([
      "id",
      "group_id",
      "user_id",
      "role",
      "created_at",
      "updated_at",
    ]);
    expect(getColumnNames(sqlite, "authorization_rules")).toEqual([
      "id",
      "subject_type",
      "subject_id",
      "match_type",
      "target",
      "effect",
      "expires_at",
      "created_at",
      "updated_at",
      "scope_type",
      "agent_id",
    ]);
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name='capability_policies'").get()).toBeNull();
  });

  test("tasks store generic task context and require Agent and Shadow ownership", () => {
    const { sqlite } = openFreshDatabase();

    expect(getColumnNames(sqlite, "tasks")).toEqual([
      "id",
      "type",
      "title",
      "summary",
      "status",
      "priority",
      "severity",
      "creator_user_id",
      "primary_session_id",
      "source_message_id",
      "source_entry_id",
      "context_json",
      "created_at",
      "updated_at",
      "last_activity_at",
      "block_reason",
      "agent_id",
      "shadow_id",
    ]);
    expect(requiredColumnNames(sqlite, "tasks")).toEqual(expect.arrayContaining(["agent_id", "shadow_id"]));
  });

  test("task source context is represented by context pack source items", () => {
    const { connection } = openFreshDatabase();

    const {ownerUserId} = fixtureNamedSession(connection.db, "session_1", "user_1");
    connection.db.insert(schema.tasks).values({
      ...fixtureTaskOwnership(connection.db, "session_1"), id: "task_1", primary_session_id: "session_1",
      creator_user_id: ownerUserId, type: "work", title: "Source task", status: "completed",
      created_at: 1, updated_at: 1, last_activity_at: 1,
    }).run();
    const message = new MessageStore(connection.db).append({
      sessionId: "session_1", senderUserId: ownerUserId, role: "user", content: {text: "Source message"},
    });
    appendTaskSourceContextItem(connection.db, {
      taskId: "task_1",
      sessionId: "session_1",
      messageId: message.id,
      userId: ownerUserId,
      createdAt: 123,
    });

    expect(findTaskIdForSourceMessage(connection.db, message.id)).toBe(
      "task_1",
    );
    const [item] = selectTaskSourceContextItems(connection.db);
    expect(item).toMatchObject({
      taskId: "task_1",
      contextPackKind: "task_launch",
      sourceSessionId: "session_1",
      sourceMessageId: message.id,
      sourceIdentityId: null,
      role: "source",
      createdAt: 123,
    });
    expect(Object.keys(item ?? {})).not.toEqual(
      expect.arrayContaining([
        "task_id",
        "session_id",
        "message_id",
        "user_id",
        "created_at",
      ]),
    );
  });

  test("timeline events and artifacts use task_id instead of case_id", () => {
    const { sqlite } = openFreshDatabase();

    const timelineColumns = getColumns(sqlite, "timeline_events");
    expect(timelineColumns.has("task_id")).toBe(true);
    expect(timelineColumns.has("case_id")).toBe(false);

    const artifactColumns = getColumns(sqlite, "artifacts");
    expect(artifactColumns.has("task_id")).toBe(true);
    expect(artifactColumns.has("case_id")).toBe(false);
  });

  test("SessionTimelineEventStore deduplicates followup_interrupted events per source message", () => {
    const { connection } = openFreshDatabase();
    const store = new SessionTimelineEventStore(connection.db);

    const first = store.appendConversationControl({
      sessionId: "session-1",
      eventType: "conversation_control",
      controlKind: "followup_interrupted",
      reasonKind: "focus_shifted",
      sourceMessageId: "message-1",
      anchorMessageId: "anchor-1",
      sessionSourceMessageId: "anchor-ext-1",
      turnId: "turn-1",
      summary:
        "Detected conversation focus shift; current Luna follow-up chain was interrupted.",
    });
    const second = store.appendConversationControl({
      sessionId: "session-1",
      eventType: "conversation_control",
      controlKind: "followup_interrupted",
      reasonKind: "focus_shifted",
      sourceMessageId: "message-1",
      anchorMessageId: "anchor-1",
      sessionSourceMessageId: "anchor-ext-1",
      turnId: "turn-1",
      summary:
        "Detected conversation focus shift; current Luna follow-up chain was interrupted.",
    });

    expect(second.id).toBe(first.id);
    expect(store.listForSession("session-1")).toHaveLength(1);
  });
});

function getColumns(sqlite: Database, tableName: string): Set<string> {
  return new Set(getColumnNames(sqlite, tableName));
}

function getColumnNames(sqlite: Database, tableName: string): string[] {
  return (
    sqlite.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function requiredColumnNames(sqlite: Database, tableName: string): string[] {
  return (
    sqlite.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
      notnull: number;
    }>
  )
    .filter((row) => row.notnull === 1)
    .map((row) => row.name);
}

function getColumnType(
  sqlite: Database,
  tableName: string,
  columnName: string,
): string | undefined {
  return (
    sqlite.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
      type: string;
    }>
  ).find((row) => row.name === columnName)?.type;
}

function getIndexes(
  sqlite: Database,
  tableName: string,
): Array<{ name: string; unique: number }> {
  return sqlite.query(`PRAGMA index_list(${tableName})`).all() as Array<{
    name: string;
    unique: number;
  }>;
}

function getForeignKeys(
  sqlite: Database,
  tableName: string,
): Array<{ from: string; table: string; to: string; on_delete: string }> {
  return sqlite.query(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }>;
}
