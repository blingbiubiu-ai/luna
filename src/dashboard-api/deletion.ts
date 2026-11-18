import { deleteOwnerExecution } from "@/runners/execution-cleanup";
import { drainSessionFileCleanup, assertCleanupPath } from "@/data/session-file-cleanup";
import { createSessionRunnerPaths } from "@/shared/runner-paths";
import { sql, and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DrizzleDB } from "@/data";
import { runnerOperations, accounts, lunaAgents, accessTokens, authorizationRules, channelAuthTokens, channelUserBindings, cliAuthSessions, directRecipients, groupMemberships, identityObservations, messages, sessionChannelBindings, sessionCommands, sessionInbox, sessionSchedules, sessions, sessionSurfaceAliases, sessionTimelineEntries, sessionTriggers, sessionTurns, taskSubscriptions, tasks, userIdentityLinks, users } from "@/data/schema";

function deletionError(status: 404 | 409, message: string): never {
  throw new HTTPException(status, { message, res: Response.json({ message }, { status }) });
}

function busy(): never {
  deletionError(409, "仍有消息或任务正在处理，请完成后再删除。");
}

function assertSessionIdle(db: Omit<DrizzleDB, "$client">, id: string) {
  // Local business status alone cannot prove that remote execution has ended.
  if (db.get(sql`SELECT 1 FROM runner_invocations WHERE settled_at IS NULL AND (session_id = ${id} OR runner_context_id IN (SELECT id FROM runner_contexts WHERE owner_type = 'session' AND owner_id = ${id}))`)
    || db.select().from(runnerOperations).where(and(eq(runnerOperations.sessionId, id), inArray(runnerOperations.status, ["accepted", "prepared"]))).get()
    || db.select().from(sessionInbox).where(and(eq(sessionInbox.session_id, id), inArray(sessionInbox.status, ["pending", "claimed", "processing"]))).get()
    || db.select().from(sessionTurns).where(and(eq(sessionTurns.session_id, id), eq(sessionTurns.status, "running"))).get()
    || db.select().from(sessionTriggers).where(and(eq(sessionTriggers.sessionId, id), inArray(sessionTriggers.status, ["pending", "running", "processing"]))).get()
    || db.select().from(sessionCommands).where(and(or(eq(sessionCommands.sessionId, id), eq(sessionCommands.sourceSessionId, id)), inArray(sessionCommands.status, ["pending", "running"]))).get()
    || db.select().from(tasks).where(eq(tasks.primary_session_id, id)).all().some(task => !["completed", "cancelled", "failed"].includes(task.status))) busy();
}

/**
 * Delete the session, retaining content-free message tombstones for references.
 * The synchronous SQLite transaction serializes the idle check with routing cleanup.
 */
export function deleteDashboardSession(db: DrizzleDB, id: string): void {
  db.transaction(tx => {
    const session = tx.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!session) {
      if (tx.get(sql`SELECT 1 FROM session_deletions WHERE session_id = ${id}`)) return;
      deletionError(404, "会话不存在");
    }
    assertSessionIdle(tx, id);
    const owned = sql`SELECT id FROM messages WHERE owner_session_id = ${id} AND deleted_at IS NULL`;
    const referencing = tx.all<{ session_id: string }>(sql`SELECT DISTINCT session_id FROM session_timeline_entries WHERE message_id IN (${owned}) AND session_id <> ${id}`);
    for (const ref of referencing) assertSessionIdle(tx, ref.session_id);
    if (tx.get(sql`SELECT 1 FROM session_channel_deliveries WHERE dispatch_id IN (SELECT id FROM session_reply_dispatches WHERE session_id = ${id}) AND status IN ('pending', 'sending')`)) busy();

    const artifactRows = tx.all<{ id: string; storage_key: string; storage_backend: string; agent_id: string; shadow_id: string }>(
      sql`SELECT id, storage_key, storage_backend, agent_id, shadow_id FROM managed_artifacts WHERE scope_type = 'session' AND scope_id = ${id}`);
    const paths: string[] = [];
    // A file shared with a surviving managed artifact must remain available.
    for (const artifact of artifactRows) {
      const survivingMessage = tx.all<{ owner_session_id: string }>(sql`SELECT owner_session_id FROM messages WHERE agent_id = ${artifact.agent_id} AND shadow_id = ${artifact.shadow_id} AND deleted_at IS NULL AND owner_session_id <> ${id} AND (instr(content_json, ${artifact.id}) > 0 OR instr(raw_payload_json, ${artifact.id}) > 0) LIMIT 1`)[0];
      const survivingTask = tx.all<{ id: string }>(sql`SELECT id FROM tasks WHERE agent_id = ${artifact.agent_id} AND shadow_id = ${artifact.shadow_id} AND instr(context_json, ${artifact.id}) > 0 UNION SELECT a.task_id AS id FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.agent_id = ${artifact.agent_id} AND t.shadow_id = ${artifact.shadow_id} AND (instr(a.content, ${artifact.id}) > 0 OR instr(a.metadata, ${artifact.id}) > 0) LIMIT 1`)[0];
      if (survivingMessage || survivingTask) {
        tx.run(sql`UPDATE managed_artifacts SET scope_type = ${survivingTask ? "task" : "session"}, scope_id = ${survivingTask?.id ?? survivingMessage!.owner_session_id}, message_id = NULL WHERE id = ${artifact.id}`);
        continue;
      }
      const shared = tx.get(sql`SELECT 1 FROM managed_artifacts WHERE storage_key = ${artifact.storage_key} AND NOT (scope_type = 'session' AND scope_id = ${id}) AND status = 'active'`);
      if (!shared) {
        if (artifact.storage_backend !== 'local') throw new Error("Unsupported session artifact cleanup backend");
        paths.push(artifact.storage_key);
      }
    }
    const root = createSessionRunnerPaths(id).runnerRootPath;
    if (tx.get(sql`SELECT 1 FROM runner_contexts WHERE runner_root_path = ${root} AND NOT (owner_type = 'session' AND owner_id = ${id})`)) {
      throw new Error("Session runner directory is shared with another owner");
    }
    paths.push(root);
    for (const context of tx.all<{ runner_root_path: string }>(sql`SELECT runner_root_path FROM runner_contexts WHERE owner_type = 'session' AND owner_id = ${id}`)) {
      if (tx.get(sql`SELECT 1 FROM runner_contexts WHERE runner_root_path = ${context.runner_root_path} AND NOT (owner_type = 'session' AND owner_id = ${id})`)) throw new Error("Session runner directory is shared with another owner");
      paths.push(context.runner_root_path);
    }
    for (const path of paths) assertCleanupPath(path);
    tx.run(sql`INSERT INTO session_deletions (session_id, agent_id, deleted_at, pending_paths) VALUES (${id}, ${session.agent_id}, ${Date.now()}, ${JSON.stringify(paths)})`);

    // Reset resumed AI conversations that may have seen these messages.
    for (const ref of referencing) {
      tx.run(sql`UPDATE runner_contexts SET runner_session_id = NULL WHERE owner_type = 'session' AND owner_id = ${ref.session_id}`);
    }
    tx.run(sql`DELETE FROM channel_message_markers WHERE EXISTS (SELECT 1 FROM messages m WHERE m.owner_session_id = ${id} AND m.channel_type = channel_message_markers.channel_type AND m.channel_id = channel_message_markers.channel_id AND (m.external_message_id = channel_message_markers.message_id OR m.id = channel_message_markers.message_id))`);
    tx.run(sql`DELETE FROM message_mentions WHERE message_id IN (${owned})`);
    tx.run(sql`UPDATE context_pack_items SET metadata_json = NULL, source_identity_id = NULL WHERE source_message_id IN (${owned})`);
    // Neutral compatibility values contain no original author, routing or content.
    tx.run(sql`UPDATE messages SET owner_session_id = NULL, deleted_at = ${Date.now()},
      channel_type = 'deleted', channel_id = '', external_message_id = id,
      sender_user_id = '', sender_identity_id = NULL, role = 'user',
      content_kind = 'text', presentation_kind = 'plain', provider_message_type = NULL,
      content_json = '[{"type":"text","text":"该消息已删除"}]', raw_payload_json = NULL,
      occurred_at = 0, created_at = 0 WHERE id IN (${owned})`);

    tx.run(sql`DELETE FROM session_channel_deliveries WHERE dispatch_id IN (SELECT id FROM session_reply_dispatches WHERE session_id = ${id})`);
    tx.run(sql`DELETE FROM context_pack_items WHERE context_pack_id IN (SELECT id FROM context_packs WHERE owner_type = 'session' AND owner_id = ${id})`);
    tx.run(sql`DELETE FROM context_packs WHERE owner_type = 'session' AND owner_id = ${id}`);
    deleteOwnerExecution(tx, "session", id);
    tx.run(sql`DELETE FROM runner_context_seed_records WHERE owner_type = 'session' AND owner_id = ${id}`);
    tx.run(sql`DELETE FROM runner_contexts WHERE owner_type = 'session' AND owner_id = ${id}`);
    tx.run(sql`DELETE FROM managed_artifacts WHERE scope_type = 'session' AND scope_id = ${id}`);
    tx.run(sql`DELETE FROM notification_attempts WHERE subscription_id IN (SELECT id FROM task_subscriptions WHERE session_id = ${id})`);
    tx.run(sql`DELETE FROM schedule_occurrences WHERE schedule_id IN (SELECT id FROM session_schedules WHERE source_session_id = ${id} AND target_session_id = ${id})`);
    tx.run(sql`DELETE FROM session_schedules WHERE source_session_id = ${id} AND target_session_id = ${id}`);
    tx.run(sql`UPDATE session_schedules SET enabled = 0, paused = 1 WHERE source_session_id = ${id} OR target_session_id = ${id}`);
    tx.run(sql`DELETE FROM session_commands WHERE source_session_id = ${id} OR session_id = ${id}`);
    for (const table of [
      "session_inbox", "session_turn_entries", "session_turns", "session_runner_attempts",
      "session_triggers",
      "session_reply_dispatches", "session_states", "session_timeline_events", "session_timeline_entries",
      "session_channel_bindings", "session_surface_aliases", "direct_recipients",
      "task_subscriptions", "task_run_notifications",
    ]) tx.run(sql`DELETE FROM ${sql.raw(table)} WHERE session_id = ${id}`);
    tx.run(sql`DELETE FROM operation_invocation_audits WHERE session_id = ${id} AND task_id IS NULL`);
    tx.run(sql`UPDATE operation_invocation_audits SET session_id = NULL WHERE session_id = ${id}`);
    tx.run(sql`UPDATE timeline_events SET session_id = NULL WHERE session_id = ${id}`);
    tx.run(sql`UPDATE tasks SET primary_session_id = NULL WHERE primary_session_id = ${id}`);
    tx.run(sql`UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ${id}`);
    tx.update(accessTokens).set({ revokedAt: Date.now(), sourceSessionId: null }).where(eq(accessTokens.sourceSessionId, id)).run();
    tx.run(sql`DELETE FROM deleted_task_references WHERE session_id = ${id}`);
    tx.run(sql`DELETE FROM memory_reflection_checkpoints WHERE session_id = ${id}`);
    tx.delete(sessions).where(eq(sessions.id, id)).run();
  });
  // A failure is surfaced; the committed manifest makes a repeated DELETE resumable.
  drainSessionFileCleanup(db, id);
}

/**
 * Deletes a platform account. Its Agents must be deleted first. Its personal
 * tokens and platform rules go; where it took part in other Agents, its user
 * there is taken off the list but its history stays.
 */
export function deleteAccount(db: DrizzleDB, id: string, requesterAccountId: string | undefined): void {
  db.transaction(tx => {
    const account = tx.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!account) deletionError(404, "账号不存在");
    if (id === requesterAccountId) deletionError(409, "不能删除当前登录账号。");
    if (account.status === "deleted") return;
    if (tx.select({ id: lunaAgents.id }).from(lunaAgents).where(and(eq(lunaAgents.ownerAccountId, id), ne(lunaAgents.status, "deleted"))).get())
      deletionError(409, "请先删除此账号拥有的 Agent。");
    const now = Date.now();
    tx.update(accessTokens).set({ revokedAt: now }).where(and(eq(accessTokens.accountId, id), isNull(accessTokens.revokedAt))).run();
    tx.delete(cliAuthSessions).where(eq(cliAuthSessions.approvedByAccountId, id)).run();
    tx.delete(authorizationRules).where(and(eq(authorizationRules.scopeType, "platform"), eq(authorizationRules.subjectType, "user"), eq(authorizationRules.subjectId, id))).run();
    tx.update(users).set({ status: "removed", updatedAt: String(now) }).where(and(eq(users.accountId, id), ne(users.status, "merged"))).run();
    tx.update(accounts).set({ status: "deleted", updatedAt: now }).where(eq(accounts.id, id)).run();
  });
}
