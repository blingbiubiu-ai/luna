import {TaskScopeResolver} from "@/agents/task-scope";
import type {AgentScope} from "@/agents/agent-store";
import { and, desc, eq, lte } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { operationInvocationAudits } from "@/data/schema";
import { uuid } from "@/shared";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type OperationInvocationAuditStatus =
  | "started"
  | "rejected"
  | "success"
  | "error";

export interface RecordOperationInvocationStartedInput {
  readonly scope:AgentScope;
  readonly invocationId: string;
  readonly operationId: string;
  readonly providerType: string;
  readonly pluginId?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly source: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly messageId?: string;
  readonly startedAt?: number;
}

export interface RecordOperationInvocationCompletedInput {
  readonly status: Exclude<OperationInvocationAuditStatus, "started">;
  readonly errorCode?: string;
  readonly artifactCount?: number;
  readonly endedAt?: number;
}

export interface ListRecentOperationInvocationsInput {
  readonly pluginId?: string;
  readonly operationId?: string;
  readonly limit?: number;
}

export class OperationInvocationAuditStore {
  constructor(private readonly _db: DrizzleDB) {}

  recordStarted(
    input: RecordOperationInvocationStartedInput,
  ): typeof operationInvocationAudits.$inferSelect {
    new TaskScopeResolver(this._db).active(input.scope);
    const startedAt = input.startedAt ?? Date.now();
    const row = {
      id: uuid(),
      agent_id:input.scope.agentId,shadow_id:input.scope.shadowId,
      invocation_id: input.invocationId,
      operation_id: input.operationId,
      provider_type: input.providerType,
      plugin_id: input.pluginId ?? null,
      subject_type: input.subjectType ?? null,
      subject_id: input.subjectId ?? null,
      source: input.source,
      session_id: input.sessionId ?? null,
      task_id: input.taskId ?? null,
      message_id: input.messageId ?? null,
      status: "started",
      error_code: null,
      artifact_count: 0,
      started_at: startedAt,
      ended_at: null,
      duration_ms: null,
      expires_at: startedAt + RETENTION_MS,
    } satisfies typeof operationInvocationAudits.$inferInsert;

    this._db.insert(operationInvocationAudits).values(row).run();
    return this.requireByInvocationId(input.invocationId);
  }

  recordAuthorization(invocationId: string, decision: unknown): void {
    this._db.update(operationInvocationAudits).set({authorization_json:decision})
      .where(eq(operationInvocationAudits.invocation_id,invocationId)).run();
  }

  recordCompleted(
    invocationId: string,
    input: RecordOperationInvocationCompletedInput,
  ): typeof operationInvocationAudits.$inferSelect {
    const existing = this.requireByInvocationId(invocationId);
    const endedAt = input.endedAt ?? Date.now();
    this._db
      .update(operationInvocationAudits)
      .set({
        status: input.status,
        error_code: input.errorCode ?? null,
        artifact_count: input.artifactCount ?? existing.artifact_count,
        ended_at: endedAt,
        duration_ms: Math.max(0, endedAt - existing.started_at),
      })
      .where(eq(operationInvocationAudits.invocation_id, invocationId))
      .run();
    return this.requireByInvocationId(invocationId);
  }

  cleanupExpired(now: number = Date.now()): number {
    const expiredCount = this._db
      .select({ id: operationInvocationAudits.id })
      .from(operationInvocationAudits)
      .where(lte(operationInvocationAudits.expires_at, now))
      .all().length;
    this._db
      .delete(operationInvocationAudits)
      .where(lte(operationInvocationAudits.expires_at, now))
      .run();
    return expiredCount;
  }

  listRecent(
    input: ListRecentOperationInvocationsInput = {},
  ): (typeof operationInvocationAudits.$inferSelect)[] {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    if (input.pluginId !== undefined && input.operationId !== undefined) {
      return this._db
        .select()
        .from(operationInvocationAudits)
        .where(
          and(
            eq(operationInvocationAudits.plugin_id, input.pluginId),
            eq(operationInvocationAudits.operation_id, input.operationId),
          ),
        )
        .orderBy(desc(operationInvocationAudits.started_at))
        .limit(limit)
        .all();
    }
    if (input.pluginId !== undefined) {
      return this._db
        .select()
        .from(operationInvocationAudits)
        .where(eq(operationInvocationAudits.plugin_id, input.pluginId))
        .orderBy(desc(operationInvocationAudits.started_at))
        .limit(limit)
        .all();
    }
    if (input.operationId !== undefined) {
      return this._db
        .select()
        .from(operationInvocationAudits)
        .where(eq(operationInvocationAudits.operation_id, input.operationId))
        .orderBy(desc(operationInvocationAudits.started_at))
        .limit(limit)
        .all();
    }
    return this._db
      .select()
      .from(operationInvocationAudits)
      .orderBy(desc(operationInvocationAudits.started_at))
      .limit(limit)
      .all();
  }

  requireByInvocationId(
    invocationId: string,
  ): typeof operationInvocationAudits.$inferSelect {
    const row = this._db
      .select()
      .from(operationInvocationAudits)
      .where(eq(operationInvocationAudits.invocation_id, invocationId))
      .get();
    if (row === undefined) {
      throw new Error(`Operation invocation audit not found: ${invocationId}`);
    }
    return row;
  }
}
