#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";

interface Options { serviceHome: string; workerHome: string; backup: string; serviceUrl: string; }
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (file: string, value: unknown) => { writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); chmodSync(file, 0o600); };

/** Offline migration: backups precede edits; existing destination data is never merged. */
export function migrateWorkerHome(options: Options) {
  const { serviceHome: home, workerHome: worker, backup, serviceUrl } = options;
  if (worker === home || worker.startsWith(home + "/") || home.startsWith(worker + "/")) throw new Error("Service and Worker homes must be separate, non-nested directories");
  const oldRuntime = join(home, "execution/runtime"), oldWorker = join(home, "execution/worker");
  const newRuntime = join(home, "runtime");
  if ([worker, newRuntime, backup].some(existsSync)) throw new Error("Destination or backup already exists; refusing to overwrite or merge");
  const runtimeConfig = json(join(oldRuntime, "runtime.json")), workerConfig = json(join(oldWorker, "worker.json"));
  const oldRunners = workerConfig.runnerLayout?.runners ?? join(home, "runners");
  const oldHomeSource = workerConfig.runnerLayout?.homeSource ?? join(home, "runner-home");
  for (const path of [oldRunners, oldHomeSource]) if (!existsSync(path)) throw new Error(`Missing source: ${path}`);
  // Moving custom layouts needs an explicit mapping; do not silently adopt an unrelated tree.
  if (oldRunners !== join(home, "runners") || oldHomeSource !== join(home, "runner-home")) throw new Error("Custom Runner layout: migrate with an explicit directory mapping");
  const runtimeDb = new Database(join(oldRuntime, "runtime.sqlite"));
  const workerDb = new Database(join(oldWorker, "worker.sqlite"));
  try {
    if (runtimeDb.query("SELECT 1 FROM scheduled_jobs WHERE json_extract(record_json,'$.placementState')!='terminal' LIMIT 1").get()
      || workerDb.query("SELECT 1 FROM worker_reservations WHERE json_extract(record_json,'$.state') NOT IN ('released','cancelled') LIMIT 1").get()) throw new Error("Active jobs or reservations: drain before migration");
    runtimeDb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); workerDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { runtimeDb.close(); workerDb.close(); }
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  cpSync(join(home, "execution"), join(backup, "execution"), { recursive: true });
  for (const name of ["config.yaml", ".env"]) if (existsSync(join(home, name))) cpSync(join(home, name), join(backup, name));
  save(join(backup, "migration.json"), { ...options, oldRunners, oldHomeSource, note: "Runtime/Worker config and databases backed up. Runner trees are moved unchanged and can be renamed back after stopping both services." });
  renameSync(oldRuntime, newRuntime);
  renameSync(oldWorker, worker);
  renameSync(oldRunners, join(worker, "runners"));
  renameSync(oldHomeSource, join(worker, "runner-home"));
  // Resource source files remain owned by Service; Worker gets independent copies.
  for (const name of [".runner-skills", ".runner-bin", ".runner_prompt", "memory", ".ssh", ".runner-gitconfig"]) {
    const source = name === ".runner-skills" ? (workerConfig.runnerAssets?.skills ?? join(home, name))
      : name === "memory" ? (workerConfig.runnerAssets?.memory ?? join(home, name))
      : name === ".runner-bin" ? (workerConfig.runnerLayout?.commands ?? join(home, name)) : join(home, name);
    if (existsSync(source)) cpSync(source, join(worker, name), { recursive: true, dereference: true });
  }
  workerConfig.dataRoot = worker;
  workerConfig.serviceUrl ??= serviceUrl;
  workerConfig.runnerLayout = { home: worker, runners: join(worker, "runners"), homeSource: join(worker, "runner-home"), commands: join(worker, ".runner-bin") };
  workerConfig.runnerAssets = { memory: join(worker, "memory"), skills: join(worker, ".runner-skills") };
  runtimeConfig.dataRoot = newRuntime;
  save(join(worker, "worker.json"), workerConfig);
  save(join(newRuntime, "runtime.json"), runtimeConfig);
  const db = new Database(join(worker, "worker.sqlite"));
  try {
    db.transaction(() => {
      for (const row of db.query("SELECT context_id,cwd FROM worker_context_paths").all() as { context_id: string; cwd: string }[]) {
        if (row.cwd.startsWith(oldRunners + "/")) db.query("UPDATE worker_context_paths SET cwd=? WHERE context_id=?").run(join(worker, "runners") + row.cwd.slice(oldRunners.length), row.context_id);
      }
      // No active reservations remain; old prepared leases must not pin stale paths.
      db.exec("DELETE FROM worker_prepared_inputs");
    })();
  } finally { db.close(); }
  // The cache contains old absolute paths. Regenerate it on the next preparation.
  const rd = new Database(join(newRuntime, "runtime.sqlite"));
  try { rd.exec("DELETE FROM runtime_prepared_contexts"); } finally { rd.close(); }
  for (const name of ["config.yaml", ".env"]) {
    const path = join(home, name);
    if (existsSync(path)) writeFileSync(path, readFileSync(path, "utf8").replaceAll(oldRuntime, newRuntime));
  }
  if (!readdirSync(join(home, "execution")).length) rmdirSync(join(home, "execution"));
  return { runtime: newRuntime, worker, backup };
}

async function listening(port: number): Promise<boolean> {
  return new Promise(accept => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value: boolean) => { socket.destroy(); accept(value); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(1000, () => finish(true));
  });
}
if (import.meta.main) {
  const option = (name: string, fallback: string) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]!; };
  const serviceHome = resolve(option("--service-home", process.env.LUNA_HOME ?? join(homedir(), ".luna")));
  const workerHome = resolve(option("--worker-home", process.env.LUNA_WORKER_HOME ?? join(homedir(), ".luna-worker")));
  const serviceUrl = option("--service", "http://127.0.0.1:8090");
  const runtime = json(join(serviceHome, "execution/runtime/runtime.json"));
  const worker = json(join(serviceHome, "execution/worker/worker.json"));
  for (const port of [Number(new URL(serviceUrl).port || 80), runtime.port ?? 8091, worker.port ?? 8092]) {
    if (await listening(port)) throw new Error(`Port ${port} is still listening; stop Service and Worker first`);
  }
  const backup = resolve(option("--backup", join(homedir(), `.luna-layout-backup-${new Date().toISOString().replaceAll(":", "-")}`)));
  console.log(JSON.stringify(migrateWorkerHome({ serviceHome, workerHome, serviceUrl, backup }), null, 2));
}
