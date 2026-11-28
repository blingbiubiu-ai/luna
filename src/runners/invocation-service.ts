import {resolveInvocationScope, validateInvocationSnapshot} from "./invocation-scope";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { accessTokens, sessions, taskRuns, tasks, users } from "@/data/schema";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { GatewayError } from "@/server/gateway-error";
import { InvocationStore } from "./invocation-store";
import { decodeInvocation } from "./invocation-codec";

/** Revalidates persisted invocation scope for each business command and token renewal. */
export class InvocationService {
  readonly store: InvocationStore;
  constructor(private readonly db: DrizzleDB) { this.store = new InvocationStore(db); }
  requireActive(claims: LunaAccessTokenClaims, expectedKind: "main" | "task") {
    const token = this.db.select().from(accessTokens).where(eq(accessTokens.id, claims.tokenId)).get();
    if (claims.source !== "runner" || claims.role !== "runner" || claims.runnerKind !== expectedKind || !token ||
      token.userId !== claims.actorUserId || token.revokedAt !== null || token.expiresAt <= Date.now()) throw new GatewayError("token_inactive", "Runner token is inactive", 403);
    const id = token.metadataJson?.invocationId;
    if (typeof id !== "string") throw new GatewayError("invocation_inactive", "Missing invocation identity", 409);
    const invocation = this.requireEligible(id);
    if (claims.agentId!==invocation.agentId||claims.shadowId!==invocation.shadowId)throw new GatewayError("invocation_scope_mismatch","Runner scope does not match its invocation",409);
    if (invocation.runnerKind !== expectedKind || invocation.actorUserId !== claims.actorUserId || invocation.runnerContextId !== claims.runnerJobId ||
      invocation.sessionId !== (claims.sessionId ?? null) || invocation.taskId !== (claims.taskId ?? null) || invocation.taskRunId !== (claims.taskRunId ?? null)) throw new GatewayError("invocation_inactive", "Runner scope does not match its invocation", 409);
    return { invocation, snapshot: decodeInvocation(invocation.inputSnapshot) };
  }
  requireEligible(id: string) {
    const invocation = this.requireScope(id);
    const job = invocation.activeJobId ? this.store.job(invocation.activeJobId) : undefined;
    if (!job || !["pending", "active"].includes(job.state)) throw new GatewayError("invocation_inactive", "No active Job belongs to this invocation", 409);
    return invocation;
  }
  /** Business scope remains checkable while a terminal Job awaits business settlement. */
  requireScope(id: string) {
    const invocation = this.store.find(id);
    if (invocation?.state !== "active") throw new GatewayError("invocation_inactive", "Invocation is no longer active", 409);
    const scope=resolveInvocationScope(this.db,invocation);
    validateInvocationSnapshot(invocation, scope);
    if(scope.agentId!==invocation.agentId||scope.shadowId!==invocation.shadowId)throw new GatewayError("invocation_scope_mismatch","Stored invocation scope changed",409);
    if (this.db.select().from(users).where(eq(users.id, invocation.actorUserId)).get()?.status !== "active") throw new GatewayError("actor_inactive", "Actor is inactive", 403);
    if (invocation.sessionId && this.db.select().from(sessions).where(eq(sessions.id, invocation.sessionId)).get()?.status !== "active") throw new GatewayError("session_unavailable", "Session is unavailable", 409);
    if (invocation.taskId) {
      const task = this.db.select().from(tasks).where(eq(tasks.id, invocation.taskId)).get();
      if (!task) throw new GatewayError("task_unavailable", "Task is unavailable", 409);
      // Main consumes completed reports; only Task owns a running Task Run.
      if (invocation.runnerKind === "task") {
        const latest = this.db.select().from(taskRuns).where(eq(taskRuns.task_id, invocation.taskId)).orderBy(desc(taskRuns.run_index)).get();
        if (latest?.id !== invocation.taskRunId || latest.status !== "running" || latest.runner_context_id !== invocation.runnerContextId) throw new GatewayError("run_inactive", "Task run is no longer current", 409);
      }
    }
    return invocation;
  }
  /** Revoke authority and every associated token before sending remote cancellation. */
  revoke(id: string, reason: string): void {
    this.db.transaction(() => {
      this.store.revoke(id, reason);
      this.db.update(accessTokens).set({ revokedAt: Date.now() }).where(and(isNull(accessTokens.revokedAt),
        eq(accessTokens.source, "runner"), sql`json_extract(${accessTokens.metadataJson}, '$.invocationId') = ${id}`)).run();
    });
  }
}
