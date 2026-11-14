#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, mkdirSync, cpSync, renameSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { connect } from "node:net";
import { readPrivateJson, writePrivateJson } from "@luna/execution-store";
import { z } from "zod";
import { absoluteRunnerPath, RunnerLayout } from "@luna/runner-protocol/runner-assets";

const LegacyWorkerConfig = z.looseObject({
  port: z.number().int().min(1).max(65535).default(8092),
  runnerLayout: RunnerLayout.extend({ homeSource: absoluteRunnerPath, commands: absoluteRunnerPath }).optional(),
});

/** Run offline after draining jobs and stopping Service, Worker and their containers. */
export function nestWorkerRunners(worker: string, runtime: string, backup: string) {
  const file = join(worker, "worker.json");
  const config = LegacyWorkerConfig.parse(readPrivateJson(file));
  const old = config.runnerLayout;
  const home = join(worker, "runner-home"), runners = join(home, "runners");
  if (!old || old.home !== worker || old.homeSource !== home || old.runners !== join(worker, "runners")) throw new Error("Expected legacy Worker layout; custom or migrated layouts require explicit review");
  if (existsSync(backup) || backup.startsWith(worker + "/") || backup.startsWith(runtime + "/")) throw new Error("Use a new backup directory outside component storage");
  if (lstatSync(old.runners).isSymbolicLink() || lstatSync(home).isSymbolicLink()) throw new Error("Symlink storage requires explicit migration");
  if (existsSync(runners) && (lstatSync(runners).isSymbolicLink() || readdirSync(runners).length)) throw new Error("Nested runners destination is not empty");
  const resources = [".runner_prompt", ".ssh", ".runner-gitconfig"].filter(name => existsSync(join(worker, name)));
  for (const name of resources) if (existsSync(join(home, name))) throw new Error(`Destination exists: ${name}`);
  const wd = new Database(join(worker, "worker.sqlite"));
  const rd = new Database(join(runtime, "runtime.sqlite"));
  try {
    if (wd.query("SELECT 1 FROM worker_reservations WHERE json_extract(record_json,'$.state') NOT IN ('released','cancelled') LIMIT 1").get()
      || rd.query("SELECT 1 FROM scheduled_jobs WHERE json_extract(record_json,'$.placementState')!='terminal' LIMIT 1").get()) throw new Error("Drain active work before migrating");
    wd.exec("PRAGMA wal_checkpoint(TRUNCATE)"); rd.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const name of ["worker.json", "worker.sqlite"]) cpSync(join(worker, name), join(backup, name));
    cpSync(join(runtime, "runtime.sqlite"), join(backup, "runtime.sqlite"));
    writePrivateJson(join(backup, "migration.json"), { worker, runtime, oldRunners: old.runners, runners, resources });
    if (existsSync(runners)) rmdirSync(runners);
    renameSync(old.runners, runners);
    for (const name of resources) renameSync(join(worker, name), join(home, name));
    config.runnerLayout = { ...old, home, runners };
    writePrivateJson(file, config);
    wd.transaction(() => {
      for (const row of wd.query("SELECT context_id,cwd FROM worker_context_paths").all() as { context_id: string; cwd: string }[]) {
        if (row.cwd.startsWith(old.runners + "/")) wd.query("UPDATE worker_context_paths SET cwd=? WHERE context_id=?").run(runners + row.cwd.slice(old.runners.length), row.context_id);
      }
      wd.exec("DELETE FROM worker_prepared_inputs");
    })();
    rd.exec("DELETE FROM runtime_prepared_contexts");
    return { home, runners, backup };
  } finally { wd.close(); rd.close(); }
}
async function listening(port: number): Promise<boolean> {
  return new Promise(accept => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); accept(value); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.setTimeout(1000, () => done(true));
  });
}
if (import.meta.main) {
  const option = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]!; };
  const worker = resolve(option("--worker-home", process.env.LUNA_WORKER_HOME ?? join(homedir(), ".luna-worker")));
  const runtime = resolve(option("--runtime", join(process.env.LUNA_HOME ?? join(homedir(), ".luna"), "runtime")));
  const config = LegacyWorkerConfig.parse(readPrivateJson(join(worker, "worker.json")));
  const rc = readPrivateJson(join(runtime, "runtime.json")) as { port: number };
  for (const port of [Number(option("--service-port", "8090")), config.port, rc.port]) if (await listening(port)) throw new Error(`Stop processes on port ${port} first`);
  console.log(JSON.stringify(nestWorkerRunners(worker, runtime, resolve(option("--backup", join(homedir(), `.luna-nested-backup-${Date.now()}`)))), null, 2));
}
