import { Id } from "@luna/runner-protocol";
import { ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";

export interface WorkerContext { contextId: string; scopeKey: string; }

/** Context identity belongs to the Worker, independently of any Executor lifetime or mode. */
export class WorkerContextStore {
  constructor(private readonly db: SqlDatabase) {
    db.exec("CREATE TABLE IF NOT EXISTS worker_contexts (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,context_id TEXT UNIQUE NOT NULL,scope_key TEXT NOT NULL)");
  }
  ensure(contextId: string, scopeKey: string): WorkerContext {
    Id.parse(contextId);
    return transaction(this.db, () => {
      const find = () => this.db.prepare("SELECT scope_key FROM worker_contexts WHERE context_id=?").get(contextId) as { scope_key: string } | undefined;
      let row = find();
      if (!row) {
        this.db.prepare("INSERT INTO worker_contexts(context_id,scope_key) VALUES (?,?)").run(contextId, scopeKey);
        row = find()!;
      }
      if (row.scope_key !== scopeKey) throw new ExecutionError(409, "context_scope_conflict");
      return { contextId, scopeKey };
    });
  }
}
