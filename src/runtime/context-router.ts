import { ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";
import { WorkerRegistry } from "./worker-registry";

export interface ContextRoute { contextId: string; scopeKey: string; workerId: string; projectId: string | null; }

/** Stable context/project affinity is committed before preparing execution storage. */
export class ContextRouter {
  constructor(private readonly db: SqlDatabase, private readonly workers: WorkerRegistry) {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_contexts (context_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,worker_id TEXT NOT NULL,project_id TEXT);
      CREATE TABLE IF NOT EXISTS runtime_projects (project_id TEXT PRIMARY KEY,worker_id TEXT NOT NULL);`);
  }
  find(id: string): ContextRoute | null {
    const row = this.db.prepare("SELECT context_id AS contextId,scope_key AS scopeKey,worker_id AS workerId,project_id AS projectId FROM runtime_contexts WHERE context_id=?").get(id);
    return row as ContextRoute | null;
  }
  route(contextId: string, scopeKey: string, projectId?: string): ContextRoute {
    return transaction(this.db, () => {
      const prior = this.find(contextId);
      let project = projectId ? this.db.prepare("SELECT worker_id FROM runtime_projects WHERE project_id=?").get(projectId) as { worker_id: string } | undefined : undefined;
      if (project && this.workers.list().some(w => w.workerId === project?.worker_id && w.reverse)) project = undefined;
      if (prior) {
        if (prior.scopeKey !== scopeKey || (project && !this.workers.require(prior.workerId).reverse && project.worker_id !== prior.workerId) || (projectId && prior.projectId && projectId !== prior.projectId)) throw new ExecutionError(409, "affinity_conflict");
        if (projectId && !prior.projectId) {
          if (!this.workers.require(prior.workerId).reverse) this.db.prepare("INSERT OR IGNORE INTO runtime_projects VALUES (?,?)").run(projectId, prior.workerId);
          this.db.prepare("UPDATE runtime_contexts SET project_id=? WHERE context_id=?").run(projectId, contextId); prior.projectId = projectId;
        }
        return prior;
      }
      const selected = this.workers.list().filter(worker => (!project || worker.workerId === project.worker_id)
        && (!projectId || !worker.reverse || worker.health?.projects?.includes(projectId))
        && worker.health?.ready !== false && !worker.draining && worker.lastSeen > Date.now() - 30000
        && !!worker.health)
        .sort((a, b) => {
          const loadA = this.occupied(a.workerId), loadB = this.occupied(b.workerId);
          const fullA = loadA >= (a.health?.capacity ?? 0), fullB = loadB >= (b.health?.capacity ?? 0);
          return Number(fullA) - Number(fullB) || loadA - loadB;
        })[0];
      if (!selected?.health) throw new ExecutionError(503, "no_worker_available");
      // Routing/preparation establishes ownership, not a slot reservation. A full
      // Worker can own a context whose submitted job will wait in the scheduler.
      if (projectId && !selected.reverse) this.db.prepare("INSERT OR IGNORE INTO runtime_projects VALUES (?,?)").run(projectId, selected.workerId);
      this.db.prepare("INSERT INTO runtime_contexts VALUES (?,?,?,?)").run(contextId, scopeKey, selected.workerId, projectId ?? null);
      return { contextId, scopeKey, workerId: selected.workerId, projectId: projectId ?? null };
    });
  }
  private occupied(workerId: string): number {
    const assigned = this.db.prepare(`SELECT count(*) AS count FROM scheduled_jobs
      WHERE json_extract(record_json, '$.workerId') = ?
        AND json_extract(record_json, '$.placementState') != 'terminal'`).get(workerId) as { count: number };
    return Math.max(this.workers.require(workerId).health?.occupied ?? 0, assigned.count);
  }

  /** Called inside the scheduler's reservation transaction for every new job. */
  requireCapacity(workerId: string): void {
    const worker = this.workers.require(workerId);
    if (!worker.health || worker.health.ready === false || worker.draining
        || worker.lastSeen <= Date.now() - 30000) {
      throw new ExecutionError(503, "no_worker_available");
    }
    if (this.occupied(workerId) >= worker.health.capacity) throw new ExecutionError(503, "capacity_exhausted");
  }

}
