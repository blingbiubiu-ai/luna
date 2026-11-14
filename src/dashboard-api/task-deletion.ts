import { deleteOwnerExecution } from "@/runners/execution-cleanup";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DrizzleDB } from "@/data";
import { assertCleanupPath, drainTaskFileCleanup } from "@/data/session-file-cleanup";
import { createTaskRunnerPaths } from "@/shared/runner-paths";

function reject(status: 404 | 409, message: string): never {
  throw new HTTPException(status, { message, res: Response.json({ message }, { status }) });
}

export function deleteDashboardTask(db: DrizzleDB, id: string): void {
  db.transaction(tx => {
    const task = tx.all<{ status: string; agent_id: string }>(sql`SELECT status, agent_id FROM tasks WHERE id = ${id}`)[0];
    if (!task) {
      if (tx.get(sql`SELECT 1 FROM task_deletions WHERE task_id = ${id}`)) return;
      reject(404, "任务不存在");
    }
    // Revoked authority can still own a remote process until cancellation settles.
    if (tx.get(sql`SELECT 1 FROM runner_invocations WHERE settled_at IS NULL AND (task_id = ${id} OR runner_context_id IN (SELECT id FROM runner_contexts WHERE owner_type = 'task' AND owner_id = ${id}))`)
      || tx.get(sql`SELECT 1 FROM runner_operations WHERE (json_extract(result_json, '$.taskId') = ${id} OR json_extract(request_json, '$.payload.taskId') = ${id}) AND status IN ('accepted', 'prepared')`)
      || !['new', 'completed', 'failed', 'cancelled'].includes(task.status)
      || tx.get(sql`SELECT 1 FROM task_runs WHERE task_id = ${id} AND status = 'running'`)
      || tx.get(sql`SELECT 1 FROM task_run_notifications WHERE task_id = ${id} AND state = 'active'`)
      || tx.get(sql`SELECT 1 FROM session_triggers WHERE json_extract(payload_json, '$.result.taskId') = ${id} AND status IN ('pending', 'running', 'processing')`)
      || tx.get(sql`SELECT 1 FROM session_turns WHERE status = 'running' AND session_id IN (SELECT session_id FROM task_subscriptions WHERE task_id = ${id} UNION SELECT primary_session_id FROM tasks WHERE id = ${id})`)) {
      reject(409, "任务或关联回复仍在处理中，请结束后再删除。");
    }
    const paths: string[] = [createTaskRunnerPaths(id).runnerRootPath];
    for (const context of tx.all<{ runner_root_path: string }>(sql`SELECT runner_root_path FROM runner_contexts WHERE owner_type = 'task' AND owner_id = ${id}`)) paths.push(context.runner_root_path);
    for (const path of paths) {
      if (tx.get(sql`SELECT 1 FROM runner_contexts WHERE runner_root_path = ${path} AND NOT (owner_type = 'task' AND owner_id = ${id})`)) reject(409, "任务目录仍被其他工作使用。");
    }
    const artifacts = tx.all<{ id: string; storage_key: string; storage_backend: string; agent_id: string; shadow_id: string }>(sql`SELECT id, storage_key, storage_backend, agent_id, shadow_id FROM managed_artifacts WHERE scope_type = 'task' AND scope_id = ${id}`);
    for (const artifact of artifacts) {
      const survivingMessage = tx.all<{ owner_session_id: string }>(sql`SELECT owner_session_id FROM messages WHERE agent_id = ${artifact.agent_id} AND shadow_id = ${artifact.shadow_id} AND deleted_at IS NULL AND owner_session_id IS NOT NULL AND (instr(content_json, ${artifact.id}) > 0 OR instr(raw_payload_json, ${artifact.id}) > 0) LIMIT 1`)[0];
      const survivingTask = tx.all<{ id: string }>(sql`SELECT id FROM tasks WHERE agent_id = ${artifact.agent_id} AND shadow_id = ${artifact.shadow_id} AND id <> ${id} AND instr(context_json, ${artifact.id}) > 0 UNION SELECT a.task_id AS id FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.agent_id = ${artifact.agent_id} AND t.shadow_id = ${artifact.shadow_id} AND a.task_id <> ${id} AND (instr(a.content, ${artifact.id}) > 0 OR instr(a.metadata, ${artifact.id}) > 0) LIMIT 1`)[0];
      if (survivingMessage || survivingTask) {
        tx.run(sql`UPDATE managed_artifacts SET scope_type = ${survivingTask ? 'task' : 'session'}, scope_id = ${survivingTask?.id ?? survivingMessage!.owner_session_id} WHERE id = ${artifact.id}`);
      } else if (!tx.get(sql`SELECT 1 FROM managed_artifacts WHERE storage_key = ${artifact.storage_key} AND NOT (scope_type = 'task' AND scope_id = ${id}) AND status = 'active'`)) {
        if (artifact.storage_backend !== 'local') reject(409, "此任务产物的存储类型暂不支持删除。");
        paths.push(artifact.storage_key);
      }
    }
    for (const path of paths) assertCleanupPath(path);
    tx.run(sql`INSERT INTO task_deletions (task_id, agent_id, deleted_at, pending_paths) VALUES (${id}, ${task.agent_id}, ${Date.now()}, ${JSON.stringify([...new Set(paths)])})`);
    tx.run(sql`INSERT OR IGNORE INTO deleted_task_references (task_id, session_id, message_id)
      SELECT ${id}, primary_session_id, COALESCE(source_message_id, '') FROM tasks WHERE id = ${id} AND primary_session_id IS NOT NULL
      UNION SELECT ${id}, session_id, '' FROM task_subscriptions WHERE task_id = ${id}
      UNION SELECT ${id}, i.source_session_id, COALESCE(i.source_message_id, '') FROM context_pack_items i JOIN context_packs p ON p.id = i.context_pack_id WHERE p.owner_type = 'task' AND p.owner_id = ${id} AND i.source_session_id IS NOT NULL`);
    tx.run(sql`UPDATE access_tokens SET revoked_at = ${Date.now()}, source_task_id = NULL WHERE source_task_id = ${id}`);
    tx.run(sql`DELETE FROM context_pack_items WHERE context_pack_id IN (SELECT id FROM context_packs WHERE owner_type = 'task' AND owner_id = ${id})`);
    tx.run(sql`DELETE FROM context_packs WHERE owner_type = 'task' AND owner_id = ${id}`);
    deleteOwnerExecution(tx, "task", id);
    tx.run(sql`DELETE FROM runner_context_seed_records WHERE owner_type = 'task' AND owner_id = ${id}`);
    tx.run(sql`DELETE FROM runner_contexts WHERE owner_type = 'task' AND owner_id = ${id}`);
    tx.run(sql`DELETE FROM managed_artifacts WHERE scope_type = 'task' AND scope_id = ${id}`);
    tx.run(sql`DELETE FROM session_triggers WHERE json_extract(payload_json, '$.result.taskId') = ${id}`);
    for (const table of ['task_run_notifications', 'notification_attempts', 'task_subscriptions', 'task_participants', 'task_runs', 'timeline_events', 'artifacts', 'operation_invocation_audits']) {
      tx.run(sql`DELETE FROM ${sql.raw(table)} WHERE task_id = ${id}`);
    }
    tx.run(sql`DELETE FROM tasks WHERE id = ${id}`);
  });
  drainTaskFileCleanup(db, id);
}

export function deleteDashboardSchedule(db: DrizzleDB, id: string): void {
  db.transaction(tx => {
    if (!tx.get(sql`SELECT 1 FROM session_schedules WHERE id = ${id}`)) {
      if (tx.get(sql`SELECT 1 FROM schedule_deletions WHERE schedule_id = ${id}`)) return;
      reject(404, "定时任务不存在");
    }
    const commands = sql`SELECT command_id FROM schedule_occurrences WHERE schedule_id = ${id} AND command_id IS NOT NULL`;
    if (tx.get(sql`SELECT 1 FROM session_commands WHERE id IN (${commands}) AND status = 'running'`)) reject(409, "定时任务正在执行，请结束后再删除。");
    // The scheduler and command claim both re-read state in synchronous transactions.
    tx.run(sql`UPDATE session_schedules SET enabled = 0 WHERE id = ${id}`);
    tx.run(sql`UPDATE messages SET raw_payload_json = json_set(COALESCE(raw_payload_json, '{}'), '$.deliveryStatus', 'cancelled') WHERE deleted_at IS NULL AND id IN (SELECT message_id FROM session_commands WHERE id IN (${commands}) AND status = 'pending')`);
    tx.run(sql`DELETE FROM context_pack_items WHERE context_pack_id IN (SELECT id FROM context_packs WHERE created_for_invocation_id IN (SELECT id FROM session_commands WHERE id IN (${commands}) AND status = 'pending'))`);
    tx.run(sql`DELETE FROM context_packs WHERE created_for_invocation_id IN (SELECT id FROM session_commands WHERE id IN (${commands}) AND status = 'pending')`);
    tx.run(sql`DELETE FROM session_commands WHERE id IN (${commands})`);
    tx.run(sql`DELETE FROM schedule_occurrences WHERE schedule_id = ${id}`);
    tx.run(sql`DELETE FROM session_schedules WHERE id = ${id}`);
    tx.run(sql`INSERT INTO schedule_deletions (schedule_id, deleted_at) VALUES (${id}, ${Date.now()})`);
  });
}
