import {createHash, randomUUID} from "node:crypto";
import {and, asc, eq, isNull, or, sql} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {agentLifecycleJobs, agentShadows, lunaAgents, runnerInvocations, sessions, sessionCommands, shadowBotBindings} from "@/data/schema";
import {AgentError, AgentStore, type AgentScope} from "./agent-store";

export type AgentLifeStatus = "active" | "disabled" | "deleted";
export type AgentLifecycleJob = typeof agentLifecycleJobs.$inferSelect;

/** Commits the admission barrier, queued-work cancellation and lifecycle intent atomically. */
export class AgentLifecycleStore {
  constructor(private readonly db: DrizzleDB) {}

  request(actorUserId: string, target: {agentId: string; shadowId?: string}, status: AgentLifeStatus, key: string): AgentLifecycleJob {
    if (!key || key.trim() !== key || key.length > 200) throw new AgentError("invalid_idempotency_key", 400);
    const shadowId = target.shadowId ?? null;
    const hash = createHash("sha256").update(JSON.stringify([target.agentId, shadowId, status])).digest("hex");
    return this.db.transaction(tx => {
      const agents = new AgentStore(tx);
      const agent = agents.requireOwner(actorUserId, target.agentId, {includeDeleted: true});
      const prior = tx.select().from(agentLifecycleJobs).where(and(eq(agentLifecycleJobs.actorUserId, actorUserId), eq(agentLifecycleJobs.idempotencyKey, key))).get();
      if (prior) {
        if (prior.requestHash !== hash) throw new AgentError("idempotency_conflict", 409);
        return prior;
      }
      if (agent.status === "deleted") throw new AgentError("agent_deleted", 409);
      const shadow = shadowId ? agents.shadow(shadowId) : undefined;
      if (shadow && shadow.agentId !== agent.id) throw new AgentError("scope_mismatch", 409);
      if (shadow?.status === "deleted") throw new AgentError("shadow_deleted", 409);
      if (shadowId === agent.defaultShadowId && status === "deleted") throw new AgentError("default_shadow_delete_forbidden", 409);
      if (shadow && status === "active" && agent.status !== "active") throw new AgentError("agent_disabled", 409);
      // An Agent-wide transition overlaps every Shadow; sibling Shadow jobs are independent.
      const unfinished = tx.select().from(agentLifecycleJobs).where(and(
        eq(agentLifecycleJobs.agentId, agent.id), eq(agentLifecycleJobs.status, "pending"),
        shadowId ? or(isNull(agentLifecycleJobs.shadowId), eq(agentLifecycleJobs.shadowId, shadowId)) : undefined,
      )).get();
      if (unfinished) throw new AgentError("lifecycle_pending", 409);
      const now = Date.now();
      const job: AgentLifecycleJob = {id: randomUUID(), agentId: agent.id, shadowId, actorUserId,
        idempotencyKey: key, requestHash: hash, targetStatus: status,
        status: status === "active" ? "completed" : "pending", lastError: null,
        createdAt: now, completedAt: status === "active" ? now : null};
      if (shadowId) tx.update(agentShadows).set({status, updatedAt: now}).where(eq(agentShadows.id, shadowId)).run();
      else {
        tx.update(lunaAgents).set({status, updatedAt: now}).where(eq(lunaAgents.id, agent.id)).run();
        if (status === "deleted") tx.update(agentShadows).set({status: "deleted", updatedAt: now}).where(eq(agentShadows.agentId, agent.id)).run();
      }
      if (status !== "active") {
        const selectedSessions = sql`SELECT id FROM sessions WHERE agent_id=${agent.id} ${shadowId ? sql`AND shadow_id=${shadowId}` : sql``}`;
        const selectedInvocations = sql`SELECT invocation_id FROM runner_invocations WHERE agent_id=${agent.id} ${shadowId ? sql`AND shadow_id=${shadowId}` : sql``}`;
        const reason = `scope_${status}`;
        tx.run(sql`UPDATE access_tokens SET revoked_at=${now} WHERE revoked_at IS NULL AND source='runner' AND agent_id=${agent.id} ${shadowId ? sql`AND shadow_id=${shadowId}` : sql``}`);
        tx.run(sql`UPDATE runner_invocations SET state='revoked',revoked_at=${now},revoke_reason=${reason} WHERE state='active' AND invocation_id IN (${selectedInvocations})`);
        tx.run(sql`UPDATE session_schedules SET enabled=0,paused=1,revision=revision+1 WHERE enabled=1 AND (source_session_id IN (${selectedSessions}) OR target_session_id IN (${selectedSessions}))`);
        tx.run(sql`UPDATE schedule_occurrences SET status='cancelled',reason=${reason} WHERE status='pending' AND schedule_id IN (SELECT id FROM session_schedules WHERE source_session_id IN (${selectedSessions}) OR target_session_id IN (${selectedSessions}))`);
        tx.run(sql`UPDATE session_commands SET status='cancelled',error=${reason},claim=NULL,updated_at=${now} WHERE status='pending' AND (session_id IN (${selectedSessions}) OR source_session_id IN (${selectedSessions}))`);
        tx.run(sql`UPDATE session_triggers SET status='cancelled',error=${reason},updated_at=${now} WHERE (status IN ('pending','failed') OR (kind='task_result' AND status='running')) AND session_id IN (${selectedSessions})`);
        tx.run(sql`UPDATE session_inbox SET status='cancelled',error=${reason},completed_at=${now},updated_at=${now} WHERE status='pending' AND session_id IN (${selectedSessions})`);
      }
      tx.insert(agentLifecycleJobs).values(job).run();
      return job;
    });
  }

  pending(): AgentLifecycleJob[] {
    return this.db.select().from(agentLifecycleJobs).where(eq(agentLifecycleJobs.status, "pending"))
      .orderBy(asc(agentLifecycleJobs.createdAt), asc(agentLifecycleJobs.id)).all();
  }

  getStatus(actorUserId: string, agentId: string, jobId: string) {
    new AgentStore(this.db).requireOwner(actorUserId, agentId, {includeDeleted: true});
    const job = this.db.select({
      status: agentLifecycleJobs.status,
      lastError: agentLifecycleJobs.lastError,
    }).from(agentLifecycleJobs).where(and(
      eq(agentLifecycleJobs.id, jobId), eq(agentLifecycleJobs.agentId, agentId),
    )).get();
    if (!job) throw new AgentError("lifecycle_job_not_found", 404);
    return job;
  }

  channels(target: Pick<AgentLifecycleJob, "agentId" | "shadowId">): string[] {
    return this.db.select({id: shadowBotBindings.channelConfigId}).from(shadowBotBindings).where(and(
      eq(shadowBotBindings.agentId, target.agentId), eq(shadowBotBindings.status, "active"),
      target.shadowId ? eq(shadowBotBindings.shadowId, target.shadowId) : undefined)).all().map(row => row.id);
  }

  async reconcile(job: AgentLifecycleJob, reloadChannel: (id: string) => Promise<void>, drainShadow: (scope: AgentScope) => Promise<void>): Promise<void> {
    try {
      for (const id of this.channels(job)) await reloadChannel(id);
      if (this.db.select({id: runnerInvocations.id}).from(runnerInvocations).where(and(
        eq(runnerInvocations.agentId, job.agentId), isNull(runnerInvocations.settledAt),
        job.shadowId ? eq(runnerInvocations.shadowId, job.shadowId) : undefined)).get()) return;
      const selectedSessions = this.db.select({id: sessions.id}).from(sessions).where(and(eq(sessions.agent_id, job.agentId),
        job.shadowId ? eq(sessions.shadow_id, job.shadowId) : undefined));
      if (this.db.select({id: sessionCommands.id}).from(sessionCommands).where(and(eq(sessionCommands.status, "running"),
        sql`(${sessionCommands.sessionId} IN (${selectedSessions}) OR ${sessionCommands.sourceSessionId} IN (${selectedSessions}))`)).get()) return;
      const shadows = job.shadowId ? [job.shadowId] : this.db.select({id: agentShadows.id}).from(agentShadows)
        .where(eq(agentShadows.agentId, job.agentId)).all().map(row => row.id);
      for (const shadowId of shadows) await drainShadow({agentId: job.agentId, shadowId});
      this.db.update(agentLifecycleJobs).set({status: "completed", lastError: null, completedAt: Date.now()})
        .where(and(eq(agentLifecycleJobs.id, job.id), eq(agentLifecycleJobs.status, "pending"))).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.update(agentLifecycleJobs).set({lastError: message})
        .where(and(eq(agentLifecycleJobs.id, job.id), eq(agentLifecycleJobs.status, "pending"))).run();
    }
  }
}
