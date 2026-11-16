import { sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import type { ExecutionRuntime } from "@/runtime/execution-runtime";

type Pending = { jobId: string; runtimeId: string };

/** Called within the owner deletion transaction. Retain only IDs for downstream cleanup. */
export function deleteOwnerExecution(db: Omit<DrizzleDB, "$client">, kind: "session" | "task", id: string): void {
  const owner = sql.raw(kind === "session" ? "session_id" : "task_id");
  const contexts = sql`SELECT id FROM runner_contexts WHERE owner_type=${kind} AND owner_id=${id}`;
  const ownership = kind === "session" ? sql`session_id=${id} AND runner_kind<>'task'` : sql`task_id=${id}`;
  const invocations = sql`SELECT invocation_id FROM runner_invocations WHERE (${ownership}) OR runner_context_id IN (${contexts})`;
  const pending = db.all<Pending>(sql`SELECT job_id AS jobId, runtime_id AS runtimeId FROM runner_jobs WHERE invocation_id IN (${invocations})`);
  const table = sql.raw(kind === "session" ? "session_deletions" : "task_deletions");
  db.run(sql`UPDATE ${table} SET pending_execution=${JSON.stringify(pending)} WHERE ${owner}=${id}`);
  db.run(sql`DELETE FROM runner_jobs WHERE invocation_id IN (${invocations})`);
  db.run(sql`DELETE FROM runner_context_origins WHERE context_id IN (${contexts})`);
  // What these contexts' provider sessions were told about memory ends with them.
  db.run(sql`DELETE FROM memory_injected_entries WHERE runner_context_id IN (${contexts})`);
  db.run(sql`DELETE FROM memory_injection_cursors WHERE runner_context_id IN (${contexts})`);
  db.run(sql`DELETE FROM invocation_resource_snapshots WHERE invocation_id IN (${invocations})`);
  db.run(sql`DELETE FROM runner_invocations WHERE invocation_id IN (${invocations})`);
}

/** Retry through the existing deletion manifests; no prompts or credentials enter this queue. */
export async function drainExecutionCleanup(db: DrizzleDB, runtime: ExecutionRuntime, signal: AbortSignal): Promise<void> {
  for (const kind of ["session", "task"] as const) {
    const table = sql.raw(kind === "session" ? "session_deletions" : "task_deletions");
    const column = sql.raw(kind === "session" ? "session_id" : "task_id");
    const rows = db.all<{ id: string; pending: string }>(sql`SELECT ${column} AS id, pending_execution AS pending FROM ${table} WHERE pending_execution <> '[]'`);
    for (const row of rows) {
      let pending = JSON.parse(row.pending) as Pending[];
      for (const item of [...pending]) {
        if (signal.aborted) return;
        if (item.runtimeId !== runtime.runtimeId) continue;
        try { await runtime.delete(item.jobId, signal); }
        catch { continue; }
        if (signal.aborted) return;
        pending = pending.filter(other => other.jobId !== item.jobId);
        db.run(sql`UPDATE ${table} SET pending_execution=${JSON.stringify(pending)} WHERE ${column}=${row.id}`);
      }
    }
  }
}
