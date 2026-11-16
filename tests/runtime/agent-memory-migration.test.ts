import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {sql} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentMemoryStore} from "@/agents/agent-memory-store";
import {fixtureScope} from "../helpers/platform-fixtures";

let home: string, db: DataConnection<typeof schema>;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "luna-memory-migration-")); setLunaHome(home); db = new DataConnection(schema); });
afterEach(() => { db.close(); rmSync(home, {recursive: true, force: true}); });

/** The import statements at the end of the migration, run here against legacy rows created after the fact. */
function importLegacyDocuments() {
  const migration = readFileSync(join(import.meta.dir, "../../src/data/drizzle/0002_agent_memories.sql"), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").filter(part => part.includes("'migration'") && part.includes("INSERT INTO"))) db.db.run(sql.raw(statement));
}

test("legacy memory documents become one trusted reference entry per non-empty file, and the documents are kept", () => {
  const a = fixtureScope(db.db, "alice"), b = fixtureScope(db.db, "bob");
  const files = {"用户/偏好.md": "只要结论", "notes/project.md": "11-20 前冻结发布", "empty.md": "  "};
  db.db.run(sql`INSERT INTO agent_document_revisions (id, agent_id, shadow_id, kind, files_json, author_user_id, parent_revision, created_at)
    VALUES ('legacy-revision', ${a.agentId}, NULL, 'memory', ${JSON.stringify(files)}, 'alice', NULL, 1000)`);
  db.db.run(sql`UPDATE luna_agents SET memory_revision = 'legacy-revision' WHERE id = ${a.agentId}`);
  importLegacyDocuments();

  const store = new AgentMemoryStore(db.db);
  const entries = store.listAll(a.agentId).sort((x, y) => x.title.localeCompare(y.title));
  expect(entries.map(entry => [entry.title, entry.body])).toEqual([["notes/project.md", "11-20 前冻结发布"], ["用户/偏好.md", "只要结论"]]);
  for (const entry of entries) {
    expect(entry).toMatchObject({type: "reference", originKind: "migration", originUserId: "alice", trusted: true, visibility: "agent", status: "active", revision: 1, createdAt: 1000});
    expect(store.history(a.agentId, entry.id)).toMatchObject([{revision: 1, changeKind: "migration", snapshot: {title: entry.title, body: entry.body, trusted: true, status: "active"}}]);
  }
  expect(new Set(entries.map(entry => entry.changeSeq)).size).toBe(2);
  for (const entry of entries) expect(entry).toMatchObject({core: false, expiresAt: null, lastUsedAt: 1000});
  // Imported entries have no search terms until Service indexes them at startup.
  expect(store.search({agentId: a.agentId, all: true}, "冻结")).toEqual([]);
  expect(store.reindex()).toBe(2);
  expect(store.search({agentId: a.agentId, all: true}, "冻结").map(entry => entry.title)).toEqual(["notes/project.md"]);
  expect(store.listAll(b.agentId)).toEqual([]);
  expect(store.index({agentId: a.agentId, shadowId: a.shadowId, participants: []}).entries).toHaveLength(2);
  const edited = store.update({agentId: a.agentId, kind: "consolidation", trusted: true, userId: "alice", shadowId: a.shadowId},
    {agentId: a.agentId, all: true}, entries[0]!.id, {expectedRevision: 1, type: "project", description: "发布冻结日期"});
  expect(edited).toMatchObject({type: "project", revision: 2});
  expect(edited.changeSeq).toBeGreaterThan(Math.max(...entries.map(entry => entry.changeSeq)));
  expect(db.db.select().from(schema.agentDocumentRevisions).all().map(row => row.id)).toEqual(["legacy-revision"]);
});

test("legacy USER/SOUL documents become persona entries of their Shadow; empty ones are skipped", () => {
  const a = fixtureScope(db.db, "alice"), b = fixtureScope(db.db, "bob");
  db.db.run(sql`INSERT INTO agent_document_revisions (id, agent_id, shadow_id, kind, files_json, author_user_id, parent_revision, created_at)
    VALUES ('legacy-persona', ${a.agentId}, ${a.shadowId}, 'persona', ${JSON.stringify({"USER.md": "只要结论", "SOUL.md": "你叫小黑"})}, 'alice', NULL, 2000),
           ('legacy-empty', ${b.agentId}, ${b.shadowId}, 'persona', ${JSON.stringify({"USER.md": "", "SOUL.md": " "})}, 'bob', NULL, 2000)`);
  db.db.run(sql`UPDATE agent_shadows SET config_revision = 'legacy-persona' WHERE id = ${a.shadowId}`);
  db.db.run(sql`UPDATE agent_shadows SET config_revision = 'legacy-empty' WHERE id = ${b.shadowId}`);
  const store = new AgentMemoryStore(db.db);
  store.add({agentId: a.agentId, kind: "owner", trusted: true, userId: "alice", shadowId: null}, {type: "project", title: "已有条目", description: "d", body: "b"});
  importLegacyDocuments();
  const imported = store.listAll(a.agentId).filter(entry => entry.type === "persona").sort((x, y) => x.title.localeCompare(y.title));
  expect(imported.map(entry => [entry.title, entry.body])).toEqual([["SOUL.md", "你叫小黑"], ["USER.md", "只要结论"]]);
  for (const entry of imported) {
    expect(entry).toMatchObject({visibility: "shadow", originShadowId: a.shadowId, originKind: "migration", trusted: true, core: false, status: "active"});
    expect(store.history(a.agentId, entry.id)).toMatchObject([{revision: 1, changeKind: "migration", snapshot: {type: "persona", visibility: "shadow"}}]);
  }
  expect(new Set(store.listAll(a.agentId).map(entry => entry.changeSeq)).size).toBe(3);
  expect(store.standing({agentId: a.agentId, shadowId: a.shadowId, participants: []}).map(entry => entry.title).sort()).toEqual(["SOUL.md", "USER.md"]);
  expect(store.listAll(b.agentId)).toEqual([]);
});
