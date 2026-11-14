import {TaskResolver} from "@/tasks/task-resolver";
import {deleteDashboardTask} from "@/dashboard-api/task-deletion";
import {afterEach, beforeEach, expect, test} from "bun:test";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {config, setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {SessionStore} from "@/sessions/session-store";
import {MessageStore} from "@/sessions/message-store";
import {ArtifactRegistry} from "@/artifacts/artifact-registry";
import {deleteDashboardSession} from "@/dashboard-api/deletion";
import {fixtureScope} from "../helpers/platform-fixtures";

let home: string, connection: DataConnection<typeof schema>;
let scope: ReturnType<typeof fixtureScope>, first: string, second: string, sibling: string;
const owner = "owner";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-platform-artifacts-")); setLunaHome(home);
  connection = new DataConnection(schema); scope = fixtureScope(connection.db, owner);
  const shadow = new AgentStore(connection.db).createShadow(owner, scope.agentId, {name: "Other"}, "other");
  const sessions = new SessionStore(connection.db);
  first = sessions.createLocalSession(owner, scope).id;
  sibling = sessions.createLocalSession(owner, scope).id;
  second = sessions.createLocalSession(owner, {...scope, shadowId: shadow.id}).id;
});
afterEach(() => {connection.close(); rmSync(home, {recursive: true, force: true});});
function register(scopeId = first, scopeType = "session") {
  return new ArtifactRegistry(connection.db).registerContent({scopeType, scopeId, producer: "test", kind: "file", name: "report.txt", content: Buffer.from("private")});
}
function reference(sessionId: string, artifactId: string) {
  new MessageStore(connection.db).append({sessionId, senderUserId: owner, role: "user", content: {text: `artifact://${artifactId}`}});
}

test("registration rejects nonexistent owners before writing managed content", () => {
  expect(() => register("missing")).toThrow("session_not_found");
  expect(connection.db.select().from(schema.managedArtifacts).all()).toHaveLength(0);
  expect(existsSync(config.paths.artifacts)).toBe(false);
});
test("identical content stays in separate Shadow directories with immutable stored scope", () => {
  const one = register(), two = register(second);
  expect(one).toMatchObject({agent_id: scope.agentId, shadow_id: scope.shadowId});
  expect(one.storage_key).toContain(`/agents/${scope.agentId}/shadows/${scope.shadowId}/`);
  expect(two.storage_key).not.toBe(one.storage_key);
  expect(register().id).toBe(one.id);
  expect(() => connection.db.update(schema.managedArtifacts).set({scope_id: second}).where(eq(schema.managedArtifacts.id, one.id)).run()).toThrow("artifact_owner_mismatch");
  expect(() => connection.db.update(schema.managedArtifacts).set({shadow_id: two.shadow_id}).where(eq(schema.managedArtifacts.id, one.id)).run()).toThrow("artifact_scope_immutable");
});
test("session deletion preserves an artifact referenced by a surviving same-Shadow session", () => {
  const artifact = register(); reference(sibling, artifact.id);
  deleteDashboardSession(connection.db, first);
  expect(new ArtifactRegistry(connection.db).get(artifact.id)).toMatchObject({scope_id: sibling, agent_id: scope.agentId, shadow_id: scope.shadowId});
  expect(existsSync(artifact.storage_key)).toBe(true);
});
test("foreign Shadow references cannot acquire an artifact when its owner is deleted", () => {
  const artifact = register(); reference(second, artifact.id);
  deleteDashboardSession(connection.db, first);
  expect(new ArtifactRegistry(connection.db).get(artifact.id)).toBeUndefined();
  expect(existsSync(artifact.storage_key)).toBe(false);
});


for (const sameShadow of [true, false]) test(`task deletion preserves only same-Shadow references (${sameShadow})`, () => {
  const task = new TaskResolver(connection.db).resolvePersistentTask({scope, title: "Artifact task", text: "test", workflow: "task", creatorUserId: owner}).persistentTask;
  const artifact = register(task.id, "task"); reference(sameShadow ? sibling : second, artifact.id);
  deleteDashboardTask(connection.db, task.id);
  if (sameShadow) expect(new ArtifactRegistry(connection.db).get(artifact.id)).toMatchObject({scope_type: "session", scope_id: sibling, shadow_id: scope.shadowId});
  else expect(new ArtifactRegistry(connection.db).get(artifact.id)).toBeUndefined();
  expect(existsSync(artifact.storage_key)).toBe(sameShadow);
});
