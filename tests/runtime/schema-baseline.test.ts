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
    "{}\n",
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
    expect(sqlite.query("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'").get()).toEqual({n:99});
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

  test("0008_thread_parent_session backfills parent_session_id for main topic sessions and synthesizes missing group roots", async () => {
    const home = makeHome();
    await useHome(home);
    const migrations = readMigrationFiles({ migrationsFolder: "src/data/drizzle" });
    const migration0006 = migrations.find((m) => m.sql.join("\n").includes("sessions_parent_session_idx"))!;
    expect(migration0006).toBeDefined();

    const conn = new DataConnection(schema);
    const { fixtureSessionOwnership } = await import("../helpers/platform-fixtures");
    const ownership = fixtureSessionOwnership(conn.db, "feishu", "feishu-mig", "migration-owner");
    conn.db.insert(schema.sessions).values([
      {
        id: "existing-group-root",
        ...ownership,
        surface_key: JSON.stringify(["v2", ownership.binding_id, "feishu", "feishu-mig", "group-with-root", "channel", "rootless"]),
        channel_type: "feishu",
        channel_id: "feishu-mig",
        group_id: "group-with-root",
        thread_key: null,
        root_message_key: null,
        parent_session_id: null,
        status: "active",
        kind: "main",
        created_at: 100,
        updated_at: 100,
      },
      {
        id: "topic-with-root",
        ...ownership,
        surface_key: JSON.stringify(["v2", ownership.binding_id, "feishu", "feishu-mig", "group-with-root", "thread", "t1"]),
        channel_type: "feishu",
        channel_id: "feishu-mig",
        group_id: "group-with-root",
        thread_key: "t1",
        root_message_key: "om_1",
        parent_session_id: null,
        status: "active",
        kind: "main",
        created_at: 200,
        updated_at: 200,
      },
      {
        id: "topic-orphan-group",
        ...ownership,
        surface_key: JSON.stringify(["v2", ownership.binding_id, "feishu", "feishu-mig", "group-without-root", "thread", "t2"]),
        channel_type: "feishu",
        channel_id: "feishu-mig",
        group_id: "group-without-root",
        thread_key: "t2",
        root_message_key: "om_2",
        parent_session_id: null,
        status: "active",
        kind: "main",
        created_at: 300,
        updated_at: 300,
      },
      {
        id: "work-thread-untouched",
        ...ownership,
        surface_key: JSON.stringify(["v2", ownership.binding_id, "feishu", "feishu-mig", "group-with-root", "thread", "w1"]),
        channel_type: "feishu",
        channel_id: "feishu-mig",
        group_id: "group-with-root",
        thread_key: "w1",
        root_message_key: "om_w1",
        parent_session_id: null,
        status: "active",
        kind: "work",
        created_at: 400,
        updated_at: 400,
      },
    ]).run();
    conn.close();

    const sqlite = new Database(join(home, "data", "luna.db"));
    try {
      for (const stmt of migration0006.sql.slice(1)) {
        sqlite.exec(stmt);
      }
      const topicWithRoot = sqlite.query("SELECT parent_session_id FROM sessions WHERE id='topic-with-root'").get() as { parent_session_id: string | null };
      expect(topicWithRoot.parent_session_id).toBe("existing-group-root");

      const synthesizedRoot = sqlite.query("SELECT id, created_at FROM sessions WHERE group_id='group-without-root' AND thread_key IS NULL AND kind='main'").get() as { id: string; created_at: number } | null;
      expect(synthesizedRoot).not.toBeNull();
      expect(synthesizedRoot!.created_at).toBe(300);

      const topicOrphan = sqlite.query("SELECT parent_session_id FROM sessions WHERE id='topic-orphan-group'").get() as { parent_session_id: string | null };
      expect(topicOrphan.parent_session_id).toBe(synthesizedRoot!.id);

      const workThread = sqlite.query("SELECT parent_session_id FROM sessions WHERE id='work-thread-untouched'").get() as { parent_session_id: string | null };
      expect(workThread.parent_session_id).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
