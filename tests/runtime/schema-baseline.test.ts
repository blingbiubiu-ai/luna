import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runServerCli } from "../../src/cli/server-main";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { fixtureAgent } from "../helpers/platform-fixtures";

let homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "luna-generation-"));
  homes.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    [
      "messaging:",
      "  default_channel_id: fake",
      "  channels: []",
      "",
    ].join("\n"),
  );
  return home;
}

async function useHome(home: string): Promise<void> {
  const config = await import("../../src/shared/config/index");
  config.setLunaHome(home);
  config.reloadConfig();
}

afterEach(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
  homes = [];
});

describe("Luna schema baseline", () => {
  test("initializes the consolidated schema and reopens without replay or data loss", async () => {
    const home = makeHome();
    await useHome(home);
    const first = new DataConnection(schema);
    const agent = fixtureAgent(first.db, "baseline-account");
    first.close();
    const sqlite = new Database(join(home, "data", "luna.db"));
    const baseline = readMigrationFiles({ migrationsFolder: "src/data/drizzle" });
    // One squashed baseline first; databases from before it are refused rather than upgraded,
    // and later migrations apply on top of it.
    expect(baseline[0]!.sql.join("\n")).toContain("luna_agents");
    expect(baseline.map(migration => migration.folderMillis)).toEqual([...baseline.map(migration => migration.folderMillis)].sort((a, b) => a - b));
    expect(sqlite.query("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'").get()).toEqual({n:92});
    expect(sqlite.query("SELECT hash, created_at FROM __drizzle_migrations").all()).toEqual([
      ...baseline.map(migration => ({ hash: migration.hash, created_at: migration.folderMillis })),
    ]);
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name IN ('runtime_generations','platform_migration_state','capability_grants','session_authorities')").all()).toEqual([]);
    sqlite.run("INSERT INTO users(id,agent_id,kind,display_name,status,created_at,updated_at) VALUES('baseline-user',?,'human','Preserved','active','1','1')", [agent.id]);
    sqlite.close();
    const second = new DataConnection(schema);
    expect(second.db.select({displayName: schema.users.displayName, agentId: schema.users.agentId}).from(schema.users)
      .where(eq(schema.users.id, "baseline-user")).all()).toEqual([{displayName: "Preserved", agentId: agent.id}]);
    second.close();
    const reopened = new Database(join(home, "data", "luna.db"), { readonly: true });
    try {
      expect(reopened.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: baseline.length });
      expect(reopened.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
  });

  test("rejects an unrelated database without modifying its contents", async () => {
    const home = makeHome();
    await useHome(home);
    const path = join(home, "data", "luna.db");
    const sqlite = new Database(path);
    sqlite.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep')");
    sqlite.close();
    expect(() => new DataConnection(schema)).toThrow("database_baseline_mismatch");
    const check = new Database(path, { readonly: true });
    try {
      expect(check.query("SELECT * FROM sentinel").all()).toEqual([{value: "keep"}]);
      expect(check.query("SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'").get()).toBeNull();
    } finally { check.close(); }
  });

  test("rejects stale baseline metadata without trying to upgrade the database", async () => {
    const home = makeHome();
    await useHome(home);
    const connection = new DataConnection(schema);
    connection.close();
    const path = join(home, "data", "luna.db");
    const sqlite = new Database(path);
    sqlite.run("UPDATE __drizzle_migrations SET hash='old-baseline'");
    sqlite.close();
    expect(() => new DataConnection(schema)).toThrow(/database_baseline_mismatch.*db reset/);
    const check = new Database(path, { readonly: true });
    try {
      expect(check.query("SELECT hash FROM __drizzle_migrations").all()).toEqual(readMigrationFiles({ migrationsFolder: "src/data/drizzle" }).map(() => ({hash: "old-baseline"})));
    } finally { check.close(); }
  });

  test("luna service db reset deletes luna sqlite files and requires confirmation", async () => {
    const home = makeHome();
    for (const suffix of ["", "-shm", "-wal"]) {
      writeFileSync(join(home, "data", `luna.db${suffix}`), "x");
    }

    const rejected = await runServerCli(["db", "reset", "--home", home]);
    expect(rejected).toMatchObject({
      status: "error",
      code: "agent_db_reset_requires_yes",
    });
    expect(existsSync(join(home, "data", "luna.db"))).toBe(true);

    const result = await runServerCli([
      "db",
      "reset",
      "--home",
      home,
      "--yes",
    ]);
    expect(result.status).toBe("ok");
    expect(existsSync(join(home, "data", "luna.db"))).toBe(false);
    expect(existsSync(join(home, "data", "luna.db-shm"))).toBe(false);
    expect(existsSync(join(home, "data", "luna.db-wal"))).toBe(false);
  });
});
