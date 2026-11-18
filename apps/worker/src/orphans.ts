import { z } from "zod";
import { AgentScope } from "@luna/runner-protocol";
import type { SqlDatabase } from "@luna/execution-store";
import type { ResourceScope } from "@luna/host-runtime/scoped-runner-resources";

/**
 * Service's answer for Shadows this Worker reported: `valid` are those it still knows and
 * has not deleted. Only scopes in `checked` are acted on, so a Shadow placed here after
 * the report is never touched.
 */
export const ScopeReconcile = z.object({
  checked: z.array(AgentScope).max(10000),
  valid: z.array(AgentScope).max(10000),
  retentionMs: z.number().int().positive(),
}).strict();

export const PruneRequest = z.object({
  /** When given, every Shadow of any other Agent is pruned too. */
  keepAgents: z.array(AgentScope.shape.agentId).max(1000).optional(),
  apply: z.boolean(),
}).strict();

export interface Orphan extends ResourceScope { since: number; }

export function scopeKey(scope: ResourceScope): string { return `${scope.agentId}/${scope.shadowId}`; }

/** Shadows Service no longer knows: when first seen so, for the retention period. */
export class WorkerOrphans {
  constructor(private readonly db: SqlDatabase) {
    db.exec("CREATE TABLE IF NOT EXISTS worker_orphans (shadow_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, since INTEGER NOT NULL)");
  }
  /** Record the Shadow as orphaned (keeping the first time) and return since when. */
  mark(scope: ResourceScope, now: number): number {
    this.db.prepare("INSERT OR IGNORE INTO worker_orphans VALUES (?,?,?)").run(scope.shadowId, scope.agentId, now);
    return (this.db.prepare("SELECT since FROM worker_orphans WHERE shadow_id=?").get(scope.shadowId) as { since: number }).since;
  }
  clear(scope: ResourceScope): void { this.db.prepare("DELETE FROM worker_orphans WHERE shadow_id=?").run(scope.shadowId); }
  list(): Orphan[] {
    return this.db.prepare("SELECT agent_id AS agentId, shadow_id AS shadowId, since FROM worker_orphans").all() as Orphan[];
  }
}
