import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultWorkerHome, WorkerConfig } from "../../apps/worker/src/config";
import { loadLunaEnvAt } from "@luna/host-runtime/env";
import { openExecutionDatabase } from "@luna/execution-store";
import { ProjectMounts } from "../../apps/worker/src/project-mounts";
import { runtimeConfigFile } from "../../src/runtime/runtime";

test("Worker defaults are independent from Service home and environment files", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-worker-home-"));
  try {
    const service = join(root, "service"), worker = join(root, "worker");
    mkdirSync(service); mkdirSync(worker);
    writeFileSync(join(service, ".env"), "LUNA_WORKER_BIND_CODE=service-secret\nLUNA_RUNNERS_DIR=/service/runners\n");
    writeFileSync(join(worker, ".env"), "LUNA_WORKER_PROJECTS_DIR=/worker/projects\n");
    expect(defaultWorkerHome({ HOME: root, LUNA_HOME: service })).toBe(join(root, ".luna-worker"));
    expect(defaultWorkerHome({ HOME: root, LUNA_WORKER_HOME: worker })).toBe(worker);
    const env = loadLunaEnvAt(worker, { LUNA_HOME: service });
    expect(env.LUNA_WORKER_BIND_CODE).toBeUndefined();
    expect(env.LUNA_RUNNERS_DIR).toBeUndefined();
    expect(env.LUNA_WORKER_PROJECTS_DIR).toBe("/worker/projects");
    expect(runtimeConfigFile(service, {})).toBe(join(service, "runtime/runtime.json"));
    expect(runtimeConfigFile(service, { runtimeConfigFile: "/custom/runtime.json" })).toBe("/custom/runtime.json");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("consolidated Worker allows its projects directory but never exposes control or resource directories", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-worker-projects-"));
  const db = openExecutionDatabase(":memory:");
  try {
    const config = WorkerConfig.parse({ workerId: "local", runtimeId: "runtime", dataRoot: root, controlToken: "w".repeat(43), runtimeEndpoint: "http://127.0.0.1:8091", imageDigest: `sha256:${"a".repeat(64)}`, projects: [{ projectId: "shared", hostPath: join(root, "projects") }] });
    expect(() => new ProjectMounts(db, config).prepare()).not.toThrow();
    for (const path of [root, join(root, "environments"), join(root, ".ssh"), join(root, "agents/agent/shadow-resources/shadow"), join(root, "agents/agent/shadows/shadow/runners")]) {
      config.projects = [{ projectId: "shared", hostPath: path }];
      expect(() => new ProjectMounts(db, config).prepare()).toThrow("project_storage_overlap");
    }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("offline migration preserves identities, external projects and Runner files while moving control paths", async () => {
  const { migrateWorkerHome } = await import("../../scripts/migrations/separate-worker-home");
  const { Database } = await import("bun:sqlite");
  const { readFileSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "luna-layout-migration-"));
  const service = join(root, "service"), worker = join(root, "worker"), backup = join(root, "backup");
  const runtime = join(service, "execution/runtime"), control = join(service, "execution/worker");
  try {
    for (const path of [runtime, control, join(service, "runners/context"), join(service, "runner-home"), join(service, ".runner-bin")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(runtime, "runtime.json"), JSON.stringify({ runtimeId: "runtime", dataRoot: runtime }));
    writeFileSync(join(control, "worker.json"), JSON.stringify({ workerId: "local", runtimeId: "runtime", controlToken: "retained-token", dataRoot: control, runnerLayout: { home: service, runners: join(service, "runners"), homeSource: join(service, "runner-home"), commands: join(service, ".runner-bin") }, projects: [{ projectId: "existing", hostPath: "/external/projects" }] }));
    writeFileSync(join(service, "runners/context/work.txt"), "keep working files");
    writeFileSync(join(service, ".runner-bin/tool"), "tool source");
    writeFileSync(join(service, "config.yaml"), `sandbox:\n  runtimeConfigFile: ${runtime}/runtime.json\n`);
    const rd = new Database(join(runtime, "runtime.sqlite"));
    rd.exec("CREATE TABLE scheduled_jobs(record_json TEXT); CREATE TABLE runtime_prepared_contexts(context_id TEXT,body TEXT)"); rd.close();
    const wd = new Database(join(control, "worker.sqlite"));
    wd.exec("CREATE TABLE worker_reservations(record_json TEXT); CREATE TABLE worker_context_paths(context_id TEXT,cwd TEXT); CREATE TABLE worker_prepared_inputs(context_id TEXT)");
    wd.query("INSERT INTO worker_context_paths VALUES (?,?)").run("context", join(service, "runners/context")); wd.close();
    const opts = { serviceHome: service, workerHome: worker, backup, serviceUrl: "http://127.0.0.1:8090" };
    migrateWorkerHome(opts);
    const config = JSON.parse(readFileSync(join(worker, "worker.json"), "utf8"));
    expect(config.workerId).toBe("local"); expect(config.controlToken).toBe("retained-token");
    expect(config.dataRoot).toBe(worker); expect(config.runnerLayout.home).toBe(worker);
    expect(config.projects[0].hostPath).toBe("/external/projects");
    expect(readFileSync(join(worker, "runners/context/work.txt"), "utf8")).toBe("keep working files");
    expect(readFileSync(join(service, ".runner-bin/tool"), "utf8")).toBe("tool source");
    expect(existsSync(join(service, "execution"))).toBe(false);
    expect(existsSync(join(backup, "execution/worker/worker.json"))).toBe(true);
    const migrated = new Database(join(worker, "worker.sqlite"));
    expect(migrated.query("SELECT cwd FROM worker_context_paths").get()).toEqual({ cwd: join(worker, "runners/context") }); migrated.close();
    expect(() => migrateWorkerHome(opts)).toThrow("refusing to overwrite");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit local binding writes only Worker home and stores registration for subsequent independent starts", async () => {
  const { runWorkerCli } = await import("../../apps/worker/src/cli");
  const { readFileSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "luna-worker-bind-"));
  let registration: Record<string, unknown> | undefined;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    expect(request.headers.get("authorization")).toBe(`Bearer ${"a".repeat(43)}`);
    registration = await request.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  } });
  try {
    const service = join(root, "service"), worker = join(root, "worker"), bin = join(root, "bin");
    mkdirSync(join(service, "runtime"), { recursive: true }); mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho sha256:${"a".repeat(64)}\n`, { mode: 0o755 });
    writeFileSync(join(service, "runtime/runtime.json"), JSON.stringify({ runtimeId: "runtime", homeWorkerId: "local", port: server.port, adminToken: "a".repeat(43), sharedProject: { projectId: "project" } }), { mode: 0o600 });
    writeFileSync(join(service, ".env"), "LUNA_WORKER_HOME=/incorrect\nLUNA_WORKER_PROJECTS_DIR=/incorrect/projects\n");
    const init = await runWorkerCli(["init", "--home", worker, "--image", "luna-runner-developer:latest", "--port", "8192"], { HOME: root, PATH: bin });
    expect(init.status).toBe("ok");
    const before = readFileSync(join(worker, "worker.json"), "utf8");
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const result = await runWorkerCli(["bind", "--local", "--service", "http://127.0.0.1:8090", "--home", worker], { HOME: root, PATH: bin, LUNA_HOME: service, LUNA_WORKER_HOME: join(root, "ignored") });
    expect(result.status).toBe("ok");
    const config = JSON.parse(readFileSync(join(worker, "worker.json"), "utf8"));
    const binding = JSON.parse(readFileSync(join(worker, "binding.json"), "utf8"));
    expect(binding.workerId).toBe("local"); expect(binding.runtimeId).toBe("runtime");
    expect(binding.serviceUrl).toBe("http://127.0.0.1:8090");
    expect(config.workerId).toBeUndefined(); expect(config.runtimeId).toBeUndefined();
    expect(config.port).toBe(8192);
    expect(readFileSync(join(worker, "worker.json"), "utf8")).toBe(before);
    expect(config.runnerLayout).toBeUndefined();
    expect(config.runnerAssets).toBeUndefined();
    expect(config.projects).toEqual([{ projectId: "shared", hostPath: join(worker, "projects") }]);
    expect(binding.controlToken).toBe(registration?.controlToken);
    expect(existsSync(join(service, "execution"))).toBe(false);
    expect((await runWorkerCli(["bind", "--local", "--service", "http://127.0.0.1:8090", "--home", worker], {})).code).toBe("worker_service_mismatch");
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("nesting migration preserves work and identity and refuses a nonempty destination", async () => {
  const { nestWorkerRunners } = await import("../../scripts/migrations/nest-worker-runners");
  const { Database } = await import("bun:sqlite");
  const { readFileSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "luna-nest-migration-"));
  const worker = join(root, "worker"), runtime = join(root, "runtime"), backup = join(root, "backup");
  try {
    for (const path of [runtime, join(worker, "runners/session"), join(worker, "runner-home/runners"), join(worker, ".runner_prompt")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(worker, "runners/session/result.txt"), "saved result");
    const config = { workerId: "local", runtimeId: "runtime", dataRoot: worker, controlToken: "w".repeat(43), runtimeEndpoint: "http://127.0.0.1:8092", imageDigest: `sha256:${"a".repeat(64)}`, runnerLayout: { home: worker, homeSource: join(worker, "runner-home"), runners: join(worker, "runners"), commands: join(worker, ".runner-bin") } };
    writeFileSync(join(worker, "worker.json"), JSON.stringify(config), { mode: 0o600 });
    const wd = new Database(join(worker, "worker.sqlite"));
    wd.exec("CREATE TABLE worker_reservations(record_json TEXT); CREATE TABLE worker_context_paths(context_id TEXT,cwd TEXT); CREATE TABLE worker_prepared_inputs(context_id TEXT)");
    wd.query("INSERT INTO worker_context_paths VALUES (?,?)").run("context", join(worker, "runners/session")); wd.close();
    const rd = new Database(join(runtime, "runtime.sqlite")); rd.exec("CREATE TABLE scheduled_jobs(record_json TEXT); CREATE TABLE runtime_prepared_contexts(context_id TEXT,body TEXT)"); rd.close();
    writeFileSync(join(worker, "runner-home/runners/conflict"), "existing");
    expect(() => nestWorkerRunners(worker, runtime, backup)).toThrow("not empty");
    rmSync(join(worker, "runner-home/runners/conflict"));
    nestWorkerRunners(worker, runtime, backup);
    expect(readFileSync(join(worker, "runner-home/runners/session/result.txt"), "utf8")).toBe("saved result");
    expect(existsSync(join(worker, "runners"))).toBe(false);
    expect(existsSync(join(worker, "runner-home/.runner_prompt"))).toBe(true);
    const updated = JSON.parse(readFileSync(join(worker, "worker.json"), "utf8"));
    expect(updated.controlToken).toBe(config.controlToken);
    expect(updated.runnerLayout.home).toBe(join(worker, "runner-home"));
    const migrated = new Database(join(worker, "worker.sqlite"));
    expect(migrated.query("SELECT cwd FROM worker_context_paths").get()).toEqual({ cwd: join(worker, "runner-home/runners/session") }); migrated.close();
    expect(existsSync(join(backup, "worker.sqlite"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
