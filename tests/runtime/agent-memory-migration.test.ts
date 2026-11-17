import {afterEach, beforeEach, expect, test} from "bun:test";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {sql} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentMemoryStore} from "@/agents/agent-memory-store";
import {fixtureScope} from "../helpers/platform-fixtures";

const drizzle = join(import.meta.dir, "../../src/data/drizzle");
let home: string, db: DataConnection<typeof schema>;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "luna-memory-migration-")); setLunaHome(home); });
afterEach(() => { db?.close(); delete process.env.LUNA_MIGRATIONS_DIR; rmSync(home, {recursive: true, force: true}); });

/**
 * A database created by the baseline alone, as deployments were before memory entries, is seeded with legacy
 * documents and then opened with every migration, the way an upgraded Service opens it.
 */
function upgrade(seed: (legacy: DataConnection<typeof schema>) => void) {
  const baseline = join(home, "baseline-migrations");
  mkdirSync(join(baseline, "meta"), {recursive: true});
  copyFileSync(join(drizzle, "0001_luna_baseline.sql"), join(baseline, "0001_luna_baseline.sql"));
  const journal = JSON.parse(readFileSync(join(drizzle, "meta/_journal.json"), "utf8"));
  writeFileSync(join(baseline, "meta/_journal.json"), JSON.stringify({...journal, entries: journal.entries.slice(0, 1)}));
  process.env.LUNA_MIGRATIONS_DIR = baseline;
  const legacy = new DataConnection(schema);
  seed(legacy);
  legacy.close();
  delete process.env.LUNA_MIGRATIONS_DIR;
  db = new DataConnection(schema);
  return new AgentMemoryStore(db.db);
}
const entriesOf = (store: AgentMemoryStore, agentId: string) => store.page(agentId, {limit: 200}).entries;

test("legacy memory documents become one trusted reference entry per non-empty file", () => {
  let a!: ReturnType<typeof fixtureScope>, b!: ReturnType<typeof fixtureScope>;
  const before = Date.now();
  const store = upgrade(legacy => {
    a = fixtureScope(legacy.db, "alice"); b = fixtureScope(legacy.db, "bob");
    const files = {"用户/偏好.md": "只要结论", "notes/project.md": "11-20 前冻结发布", "empty.md": "  ", "blank.md": "\n\t\r\n"};
    legacy.db.run(sql`INSERT INTO agent_document_revisions (id, agent_id, shadow_id, kind, files_json, author_user_id, parent_revision, created_at)
      VALUES ('legacy-revision', ${a.agentId}, NULL, 'memory', ${JSON.stringify(files)}, 'alice', NULL, 1000)`);
    legacy.db.run(sql`UPDATE luna_agents SET memory_revision = 'legacy-revision' WHERE id = ${a.agentId}`);
  });
  const entries = entriesOf(store, a.agentId).sort((x, y) => x.title.localeCompare(y.title));
  expect(entries.map(entry => [entry.title, entry.body])).toEqual([["notes/project.md", "11-20 前冻结发布"], ["用户/偏好.md", "只要结论"]]);
  for (const entry of entries) {
    expect(entry).toMatchObject({type: "reference", originKind: "migration", originUserId: "alice", trusted: true, visibility: "agent", status: "active",
      revision: 1, createdAt: 1000, core: false, expiresAt: null, occurredAt: null, participants: []});
    expect(store.history(a.agentId, entry.id)).toMatchObject([{revision: 1, changeKind: "migration", snapshot: {title: entry.title, body: entry.body, trusted: true, status: "active"}}]);
    // The forgetting clock starts at the upgrade, so an old document is consolidated rather than forgotten at once.
    expect(entry.lastUsedAt).toBeGreaterThanOrEqual(before - 1000);
  }
  expect(new Set(entries.map(entry => entry.changeSeq)).size).toBe(2);
  expect(store.forget(180 * 24 * 60 * 60 * 1000)).toBe(0);
  // Imported entries have no search terms until Service indexes them at startup.
  expect(store.search({agentId: a.agentId, all: true}, "冻结")).toEqual([]);
  expect(store.reindex()).toBe(2);
  expect(store.search({agentId: a.agentId, all: true}, "冻结").map(entry => entry.title)).toEqual(["notes/project.md"]);
  expect(entriesOf(store, b.agentId)).toEqual([]);
  const edited = store.update({agentId: a.agentId, kind: "consolidation", trusted: true, userId: "alice", shadowId: a.shadowId},
    {agentId: a.agentId, all: true}, entries[0]!.id, {expectedRevision: 1, type: "project", description: "发布冻结日期"});
  expect(edited.changeSeq).toBeGreaterThan(Math.max(...entries.map(entry => entry.changeSeq)));
});

test("legacy USER/SOUL documents become persona entries of their Shadow; empty ones are skipped", () => {
  let a!: ReturnType<typeof fixtureScope>, b!: ReturnType<typeof fixtureScope>;
  const store = upgrade(legacy => {
    a = fixtureScope(legacy.db, "alice"); b = fixtureScope(legacy.db, "bob");
    legacy.db.run(sql`INSERT INTO agent_document_revisions (id, agent_id, shadow_id, kind, files_json, author_user_id, parent_revision, created_at)
      VALUES ('legacy-persona', ${a.agentId}, ${a.shadowId}, 'persona', ${JSON.stringify({"USER.md": "只要结论", "SOUL.md": "你叫小黑"})}, 'alice', NULL, 2000),
             ('legacy-empty', ${b.agentId}, ${b.shadowId}, 'persona', ${JSON.stringify({"USER.md": "\n", "SOUL.md": " \r\n "})}, 'bob', NULL, 2000)`);
    legacy.db.run(sql`UPDATE agent_shadows SET config_revision = 'legacy-persona' WHERE id = ${a.shadowId}`);
    legacy.db.run(sql`UPDATE agent_shadows SET config_revision = 'legacy-empty' WHERE id = ${b.shadowId}`);
  });
  const imported = entriesOf(store, a.agentId).sort((x, y) => x.title.localeCompare(y.title));
  expect(imported.map(entry => [entry.type, entry.title, entry.body])).toEqual([["persona", "SOUL.md", "你叫小黑"], ["persona", "USER.md", "只要结论"]]);
  for (const entry of imported) {
    expect(entry).toMatchObject({visibility: "shadow", originShadowId: a.shadowId, originKind: "migration", trusted: true, core: false, status: "active"});
    expect(store.history(a.agentId, entry.id)).toMatchObject([{revision: 1, changeKind: "migration", snapshot: {type: "persona", visibility: "shadow"}}]);
  }
  expect(store.standing({agentId: a.agentId, shadowId: a.shadowId, participants: []}).map(entry => entry.title).sort()).toEqual(["SOUL.md", "USER.md"]);
  expect(entriesOf(store, b.agentId)).toEqual([]);
});

test("after the upgrade the legacy documents, their triggers and the pointers into them are gone", () => {
  upgrade(legacy => { fixtureScope(legacy.db, "alice"); });
  const names = (type: string) => db.db.all<{name: string}>(sql`SELECT name FROM sqlite_master WHERE type = ${type}`).map(row => row.name);
  expect(names("table")).not.toContain("agent_document_revisions");
  expect(names("table").filter(name => name.endsWith("_hold") || name.endsWith("_next"))).toEqual([]);
  expect(names("trigger").filter(name => /document|pointer_scope/.test(name))).toEqual([]);
  const columns = (table: string) => db.db.all<{name: string}>(sql`SELECT name FROM pragma_table_info(${table})`).map(row => row.name);
  expect(columns("luna_agents")).not.toContain("memory_revision");
  expect(columns("agent_shadows")).not.toContain("config_revision");
  expect(db.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  // `service` is no longer an origin.
  const agent = db.db.select().from(schema.lunaAgents).get()!;
  expect(() => db.db.run(sql`INSERT INTO agent_memories (id, agent_id, type, title, description, body, visibility, origin_kind, trusted, revision, change_seq, status, core, last_used_at, created_at, updated_at)
    VALUES ('x', ${agent.id}, 'project', 't', 'd', 'b', 'agent', 'service', 1, 1, 1, 'active', 0, 1, 1, 1)`)).toThrow();
});
