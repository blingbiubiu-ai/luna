import { transaction, type SqlDatabase } from "@luna/execution-store";

/** Two durable records: accepted Jobs and their process attempts. */
export function initializeExecutorSchema(db: SqlDatabase): void {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS executor_jobs (
      job_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, request_json TEXT,
      snapshot_json TEXT NOT NULL, retry_json TEXT
    );
    CREATE TABLE IF NOT EXISTS executor_attempts (
      job_id TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, reason TEXT, process_json TEXT, exit_json TEXT,
      PRIMARY KEY(job_id,attempt)
    );`);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
    if (!columns("executor_jobs").includes("retry_json")) db.exec("ALTER TABLE executor_jobs ADD COLUMN retry_json TEXT");
    for (const column of ["process_json", "exit_json"]) if (!columns("executor_attempts").includes(column)) db.exec(`ALTER TABLE executor_attempts ADD COLUMN ${column} TEXT`);
    const exists = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (exists("executor_retry_state")) db.exec("UPDATE executor_jobs SET retry_json=(SELECT body FROM executor_retry_state WHERE job_id=executor_jobs.job_id) WHERE retry_json IS NULL");
    if (exists("executor_attempt_facts")) db.exec(`UPDATE executor_attempts SET
      process_json=(SELECT process_json FROM executor_attempt_facts f WHERE f.job_id=executor_attempts.job_id AND f.attempt=executor_attempts.attempt),
      exit_json=(SELECT exit_json FROM executor_attempt_facts f WHERE f.job_id=executor_attempts.job_id AND f.attempt=executor_attempts.attempt)`);
    for (const table of ["executor_attempt_facts", "executor_retry_state", "executor_identity", "executor_context_paths", "executor_job_credentials", "executor_maintenance", "executor_settings"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(`CREATE INDEX IF NOT EXISTS executor_jobs_state ON executor_jobs(json_extract(snapshot_json,'$.state'));
      CREATE INDEX IF NOT EXISTS executor_jobs_context ON executor_jobs(json_extract(binding_json,'$.contextId'));`);
  });
}
