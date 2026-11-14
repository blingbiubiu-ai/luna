import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";

let homes: string[] = [];

async function openFreshDatabase(): Promise<{
  connection: DataConnection<typeof schema>;
  sqlite: Database;
}> {
  const home = mkdtempSync(join(tmpdir(), "luna-root-handoff-schema-"));
  homes.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    "messaging:\n  default_channel_id: fake\n  channels: []\n",
  );

  const config = await import("../../src/shared/config/index");
  config.setLunaHome(home);
  config.reloadConfig();

  const connection = new DataConnection(schema);
  const sqlite = new Database(join(home, "data", "luna.db"));
  return { connection, sqlite };
}

afterEach(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
  homes = [];
});

describe("Luna execution schema", () => {
  test("keeps current execution tables and omits retired delivery tables", async () => {
    const { connection, sqlite } = await openFreshDatabase();

    try {
      const tableNames = new Set(
        (
          sqlite
            .query("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
      );
      expect(tableNames.has("session_runner_attempts")).toBe(true);
      for (const name of ["runner_decisions", "session_handoffs", "outbound_delivery_records"]) expect(tableNames.has(name)).toBe(false);
      expect(tableNames.has("runner_action_records")).toBe(false);
      expect(tableNames.has("work_contexts")).toBe(false);
      expect(tableNames.has("task_sources")).toBe(false);

      expect(columnNames(sqlite, "session_runner_attempts")).toEqual([
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
      expect(indexNames(sqlite, "session_runner_attempts")).toEqual(
        expect.arrayContaining([
          "session_runner_attempts_turn_idx",
          "session_runner_attempts_session_idx",
          "session_runner_attempts_repair_source_idx",
        ]),
      );

      expect(columnNames(sqlite, "tasks")).toEqual(
        expect.arrayContaining([
          "primary_session_id",
          "source_message_id",
          "source_entry_id",
        ]),
      );
      expect(columnNames(sqlite, "tasks")).not.toContain("session_id");
    } finally {
      sqlite.close();
      connection.close();
    }
  });
});

function columnNames(sqlite: Database, tableName: string): string[] {
  return tableInfo(sqlite, tableName).map((row) => row.name);
}

function notNullColumnNames(sqlite: Database, tableName: string): string[] {
  return tableInfo(sqlite, tableName)
    .filter((row) => row.notnull === 1)
    .map((row) => row.name);
}

function indexNames(sqlite: Database, tableName: string): string[] {
  return (
    sqlite.query(`PRAGMA index_list(${tableName})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function tableInfo(
  sqlite: Database,
  tableName: string,
): Array<{ name: string; notnull: 0 | 1 }> {
  return (
    sqlite.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
      notnull: 0 | 1;
    }>
  );
}
