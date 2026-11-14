import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime";
import { RuntimeConfig } from "../../src/runtime/config";
import { writePrivateJson } from "@luna/execution-store";
import type { JobRequest } from "@luna/runner-protocol";
import { runRuntimeCli } from "../../src/cli/commands/runtime";

async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}
const job: JobRequest = { version: 2, ...fixtureJobScope(), jobId: "job", invocationId: "inv", environmentId: "luna", runnerContextId: "context", scopeKey: "session:context", runnerKind: "main", sessionId: "session", input: { runnerType: "codex", prompt: "test" }, credentialsRevision: 1, timeoutMs: 30000 };

test("Service-owned Runtime uses local calls, persists across restart and exposes only callback/admin HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-embedded-"));
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", dataRoot: root, serviceToken: "s".repeat(43), adminToken: "a".repeat(43), homeWorkerId: "worker", port: await port(),  sharedProject: { projectId: "shared" } });
  const file = join(root, "runtime.json"); writePrivateJson(file, config);
  let runtime: Runtime | undefined;
  try {
    runtime = await Runtime.start(file);
    const client = runtime;
    await client.verify();
    expect(client.sharedProject).toEqual({ projectId: "shared" });
    const submitted = await client.submit(job);
    submitted.job.input.prompt = "mutated by caller";
    expect((await client.query(job.jobId)).job.input.prompt).toBe("test");
    await expect(client.submit({ ...job, input: { ...job.input, prompt: "conflict" } })).rejects.toMatchObject({ code: "job_conflict" });
    const detach = new AbortController();
    const events = client.events("job", 0, detach.signal);
    expect((await events.next()).value?.seq).toBe(1);
    detach.abort(); expect((await events.next()).done).toBe(true);
    expect((await client.query("job")).cancelRequested).toBe(false);
    const denied = await fetch(`http://127.0.0.1:${config.port}/v1/jobs`, { headers: {Authorization:`Bearer ${config.serviceToken}`} });
    expect([401,403,404]).toContain(denied.status);
    const health = await fetch(`http://127.0.0.1:${config.port}/v1/health`, {headers:{Authorization:`Bearer ${config.adminToken}`}});
    expect(health.status).toBe(200);
    // A second owner fails without stopping the first owner's listener.
    await expect(Runtime.start(file)).rejects.toThrow("already in use");
    await runtime.close(); runtime = undefined;
    await expect(client.query("job")).rejects.toMatchObject({ code: "runtime_stopped" });
    runtime = await Runtime.start(file);
    expect((await runtime.query("job")).job.jobId).toBe("job");
    await runtime.cancel("job");
    const replay = [];
    for await (const event of runtime.events("job", 1, AbortSignal.timeout(5000))) replay.push(event);
    expect(replay.at(-1)?.kind).toBe("placement");
    expect((await runtime.query("job")).placementState).toBe("terminal");
    await runtime.delete("job");
    await expect(runtime.submit(job)).rejects.toMatchObject({ code: "job_deleted" });
    expect((await runRuntimeCli(["start"])).code).toBe("runtime_embedded");
  } finally { await runtime?.close(); rmSync(root, {recursive:true,force:true}); }
});

test("detached local observer closes on Runtime shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-embedded-observer-"));
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", dataRoot: root, serviceToken: "s".repeat(43), adminToken: "a".repeat(43), homeWorkerId: "worker", port: await port() });
  const file = join(root,"runtime.json");
  writePrivateJson(file, { ...config, sharedProject: { projectId: "test-project" } });
  const runtime = await Runtime.start(file);
  try {
    expect(runtime.sharedProject?.projectId).toBe("test-project");
    await runtime.submit(job);
    const events = runtime.events("job", 1, new AbortController().signal);
    const next = events.next();
    await runtime.close();
    expect((await next).done).toBe(true);
  } finally { await runtime.close(); rmSync(root,{recursive:true,force:true}); }
});
