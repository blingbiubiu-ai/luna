import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {fixtureScope} from "../helpers/platform-fixtures";
import {TaskResolver} from "@/tasks/task-resolver";
import {TaskProgressStore} from "@/timeline/task-progress-store";
import {InvocationStore} from "@/runners/invocation-store";
import type {RuntimeEvent} from "@luna/runner-protocol";

let home: string, connection: DataConnection<typeof schema>, taskId: string;
let store: InvocationStore, progress: TaskProgressStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-progress-")); setLunaHome(home);
  connection = new DataConnection(schema); const db = connection.db;
  const scope = fixtureScope(db);
  taskId = new TaskResolver(db).resolvePersistentTask({scope, text: "test", title: "test", workflow: "task", creatorUserId: scope.ownerUserId}).persistentTask.id;
  db.insert(schema.taskRuns).values({id: "run", task_id: taskId, run_index: 1, status: "running", reason: "initial", input_snapshot: {}, runner_type: "codex", started_at: 1}).run();
  db.insert(schema.runnerInvocations).values({id: "inv", agentId: scope.agentId, shadowId: scope.shadowId, runnerKind: "task", actorUserId: scope.ownerUserId, runnerContextId: "ctx", taskId, taskRunId: "run", originId: "run", state: "active", inputSnapshot: {version: 1, input: {}}, contextPackIds: [], createdAt: 1}).run();
  // The transport job is already admitted; these tests exercise its event transaction.
  db.insert(schema.runnerJobs).values({id: "job", runtimeId: "runtime", invocationId: "inv", request: {runnerKind: "task", taskId, taskRunId: "run", input: {runnerType: "codex"}} as any, requestHash: "hash", state: "active", createdAt: 1, updatedAt: 1}).run();
  store = new InvocationStore(db); progress = new TaskProgressStore(db);
});
afterEach(() => {connection.close(); rmSync(home, {recursive: true, force: true});});
function event(seq: number, data: unknown): RuntimeEvent {
  return {jobId: "job", seq, kind: "execution", data: {event: {seq, at: seq, kind: "provider", data}}};
}
const start = {status: "tool_start", id: "call", name: "Bash", title: "执行命令 · bun test"};
const result = {status: "tool_result", id: "call", text: "工具调用已结束"};

test("tools and public text share one durable timeline; results update instead of append", () => {
  store.consume(event(1, start), () => {});
  expect(progress.query(taskId).runningTools).toHaveLength(1);
  expect(progress.query(taskId).latestText).toBeNull();
  const before = progress.page(taskId).rows.find(r => r.type === "runner.tool")!;
  expect(store.consume(event(1, start), () => {throw Error("duplicate");})).toBe(false);
  store.consume(event(2, result), () => {});
  const after = progress.page(taskId).rows.find(r => r.type === "runner.tool")!;
  expect(after.id).toBe(before.id); expect(after.created_at).toBe(before.created_at);
  expect(after.data).toMatchObject({status: "ended", toolCallId: "call"});
  expect(progress.query(taskId).runningTools).toHaveLength(0);
  store.consume(event(3, {status: "stream", text: "正文".repeat(300)}), () => {});
  expect(progress.page(taskId).rows.filter(r => r.type === "runner.tool")).toHaveLength(1);
  expect(progress.page(taskId).rows.find(r => r.type === "runner.step")!.data).toMatchObject({text: "正文".repeat(300)});
  expect(progress.query(taskId).latestText?.kind).toBe("text");
});

test("projection failure rolls back tool row and cursor together; revoke preserves unknown outcome", () => {
  expect(() => store.consume(event(1, start), () => {throw Error("rollback");})).toThrow("rollback");
  expect(store.job("job")!.cursor).toBe(0);
  expect(progress.page(taskId).rows.filter(r => r.type === "runner.tool")).toHaveLength(0);
  store.consume(event(1, start), () => {}); store.revoke("inv", "cancelled");
  expect(progress.page(taskId).rows.find(r => r.type === "runner.tool")!.data).toMatchObject({status: "interrupted", finishedAt: null});
  store.consume(event(2, result), () => {});
  expect(progress.page(taskId).rows.find(r => r.type === "runner.tool")!.data).toMatchObject({status: "interrupted"});
});

test("pagination is bounded, complete and scoped; tool completion never moves its history position", () => {
  for(let i=1;i<=8;i++) store.consume(event(i, {...start, id: `call-${i}`}), () => {});
  const ids: string[] = []; let cursor: string | undefined;
  do {const page = progress.page(taskId, {runId: "run", limit: 3, cursor}); ids.push(...page.rows.map(r=>r.id)); cursor = page.nextCursor ?? undefined;} while(cursor);
  expect(new Set(ids).size).toBe(8);
  const first = progress.page(taskId, {runId: "run", limit: 3});
  expect(() => progress.page("foreign", {runId: "run", cursor: first.nextCursor!})).toThrow("Cursor scope mismatch");
  expect(() => progress.page(taskId, {runId: "other", cursor: first.nextCursor!})).toThrow("Cursor scope mismatch");
  expect(() => progress.page(taskId, {runId: "run", allEvents: true, cursor: first.nextCursor!})).toThrow("Cursor scope mismatch");
  store.consume(event(9, {...result, id: "call-1", text: "工具执行失败"}), () => {});
  expect(progress.page(taskId, {runId: "run", limit: 200}).rows.find(r => (r.data as any)?.toolCallId === "call-1")!.data).toMatchObject({status: "failed"});
  expect(() => progress.query(taskId, {runId: "other"})).toThrow("Run does not belong to Task");
});
