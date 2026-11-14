import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExecutionDatabase } from "@luna/execution-store";
import { ExecutionClient, TokenAuthority, closeExecutionServer } from "@luna/execution-transport";
import { runRuntimeCli } from "../../src/cli/commands/runtime";
import { RuntimeConfig } from "../../src/runtime/config";
import { RuntimeFiles } from "../../src/runtime/files";
import { Runtime } from "../../src/runtime/runtime";
import { RuntimeScheduler } from "../../src/runtime/scheduler";
import { runtimeServer } from "../../src/runtime/server";

test("Runtime drain preserves retries and cancellation, rejects isolated mode, and survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-mode-"));
  let db = openExecutionDatabase(join(root, "runtime.sqlite"));
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", dataRoot: root, mode: "shared", homeWorkerId: "home",  serviceToken: "s".repeat(43), adminToken: "a".repeat(43) });
  const grants = new TokenAuthority(db); grants.register("admin", config.adminToken, { role: "runtime", id: "runtime" }); grants.register("service", config.serviceToken, { role: "service", id: "service" });
  const scheduler = new RuntimeScheduler(db, config, grants);
  const server = runtimeServer(grants, scheduler); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin = new ExecutionClient(endpoint, config.adminToken); const service = new Runtime(scheduler, new RuntimeFiles(scheduler));
  const job = { version: 2, ...fixtureJobScope(), jobId: "job", invocationId: "inv", environmentId: "luna", runnerContextId: "context", scopeKey: "session:context", runnerKind: "main", sessionId: "session", input: { runnerType: "codex", prompt: "test" }, credentialsRevision: 1, timeoutMs: 10000 } as const;
  try {
    await expect(new ExecutionClient(endpoint, config.serviceToken).call("POST", "/v1/mode/drain")).rejects.toMatchObject({ status: 403 });
    await expect(admin.call("PUT", "/v1/mode", { mode: "isolated" })).rejects.toMatchObject({ code: "isolated_mode_unsupported" });
    expect(await runRuntimeCli(["mode", "set", "isolated", "--home", root])).toMatchObject({code: "isolated_mode_unsupported"});
    expect(await runRuntimeCli(["init", "--mode", "isolated", "--home", root])).toMatchObject({code: "isolated_mode_unsupported"});
    await service.submit(job);
    await admin.call("POST", "/v1/mode/drain");
    await service.submit(job);
    await expect(service.submit({ ...job, jobId: "new" })).rejects.toMatchObject({ code: "runtime_draining" });
    expect(scheduler.jobs.find("new")).toBeUndefined();
    const cancelled = { ...job, jobId: "cancel-before-submit" };
    await expect(admin.call("POST", "/v1/jobs/cancel-intent", cancelled)).rejects.toMatchObject({ status: 404 });
    await service.cancelIntent(cancelled);
    const sequence = scheduler.events.lastSequence(cancelled.jobId);
    await service.cancelIntent(cancelled);
    await service.submit(cancelled);
    expect(scheduler.events.lastSequence(cancelled.jobId)).toBe(sequence);
    expect(scheduler.jobs.require(cancelled.jobId)).toMatchObject({ placementState: "terminal", workerId: null, cancelRequested: true });
    await expect(service.cancelIntent({ ...cancelled, input: { ...cancelled.input, prompt: "different" } })).rejects.toMatchObject({ code: "job_conflict" });
    await expect(service.files({ operationId: "file", contextId: "context", scopeKey: "session:context", operation: { kind: "provision" } })).rejects.toMatchObject({ code: "runtime_draining" });
    await scheduler.tick(); expect(scheduler.jobs.require("job").workerId).toBeNull();
    await expect(admin.call("PUT", "/v1/mode", { mode: "isolated" })).rejects.toMatchObject({ code: "isolated_mode_unsupported" });
    await service.cancel("job");
    expect(await admin.call<{mode: string; draining: boolean}>("PUT", "/v1/mode", { mode: "shared" })).toEqual({ mode: "shared", draining: true });
    await closeExecutionServer(server); db.close(); db = openExecutionDatabase(join(root, "runtime.sqlite"));
    expect(() => new RuntimeScheduler(db, { ...config, mode: "isolated" }, new TokenAuthority(db))).toThrow("isolated_mode_unsupported");
    const restored = new RuntimeScheduler(db, config, new TokenAuthority(db));
    expect(restored.mode.state()).toEqual({ mode: "shared", draining: true });
    expect(restored.mode.resume()).toEqual({ mode: "shared", draining: false });
  } finally {
    if (server.listening) await closeExecutionServer(server);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
