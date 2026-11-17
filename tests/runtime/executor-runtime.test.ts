import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { chmodSync, chownSync, mkdirSync, statSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { openExecutionDatabase, contentHash } from "@luna/execution-store";
import { ExecutionClient, TokenAuthority, closeExecutionServer, executionServer, json, readJson, requirePeer } from "@luna/execution-transport";
import { type Assignment, type ExecutorEvent, type JobRequest } from "@luna/runner-protocol";
import { ExecutorContexts } from "@luna/executor/executor/contexts";
import { createExecutor } from "@luna/executor/executor/server";
import { SchedulerStore } from "../../src/runtime/scheduler-store";
import { RuntimeEventStore } from "../../src/runtime/event-store";

async function listen(server: ReturnType<typeof executionServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listen address");
  return `http://127.0.0.1:${address.port}`;
}
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!predicate() && Date.now() < deadline) await delay(25);
  expect(predicate(), message).toBe(true);
}

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("Executor uses the Worker identity, direct live reporting, context lanes and single-Job cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-executor-")); chmodSync(root, 0o755);
  const db = openExecutionDatabase(join(root, "executor.sqlite"));
  const runtimeDb = openExecutionDatabase(join(root, "runtime.sqlite"));
  const grants = new TokenAuthority(); const runtimeGrants = new TokenAuthority(runtimeDb);
  const control = grants.issue("runtime-control", { role: "runtime", id: "runtime1" });
  const maintenance = grants.issue("worker-control", { role: "worker", id: "worker1" });
  const upload = runtimeGrants.issue("instance-upload", { role: "executor", id: "instance1" });
  const scheduler = new SchedulerStore(runtimeDb); const events = new RuntimeEventStore(runtimeDb);
  const receiver = executionServer(runtimeGrants, async ({ peer, request, response, url }) => {
    requirePeer(peer, "executor", "instance1");
    const match = /^\/v1\/ingest\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (!match) throw new Error("Unexpected route");
    events.ingest(match[1]!, peer.id, await readJson(request, 16 * 1024 * 1024));
    json(response, 204);
  });
  const endpoint = await listen(receiver);
  const updates = (id: string) => events.list(id).map(row => (row.data as { event: ExecutorEvent }).event);
  const entry = join(root, "job.js");
  writeFileSync(entry, `const input = JSON.parse(await Bun.stdin.text());
const output = value => console.log('---LUNA_OUTPUT_START---\\n'+JSON.stringify(value)+'\\n---LUNA_OUTPUT_END---');
output({status:'stream',text:'uid='+process.getuid()+';control='+(process.env.RUNTIME_CONTROL_TOKEN??'absent')+';token='+input.env.LUNA_ACCESS_TOKEN+';home='+process.env.HOME+';cwd='+process.cwd()});
if(input.prompt==='descendant') { const {spawn}=await import('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]}).unref(); }
if(input.prompt==='project') { require('node:fs').writeFileSync(process.env.HOME+'/projects/created', 'project'); output({status:'stream',text:'gid='+process.getgid()}); }
const fs=require('node:fs');
if(input.prompt.startsWith('retry')) fs.writeFileSync(process.cwd()+'/retry-prompt',input.prompt);
else if(input.sessionId==='retry-session' && input.prompt.startsWith('Continue the previous invocation')) input.prompt=fs.readFileSync(process.cwd()+'/retry-prompt','utf8');
if(input.prompt.startsWith('retry')) {
 const fs=require('node:fs'); const file=process.cwd()+'/'+input.prompt; const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1; fs.writeFileSync(file,String(n));
 output({status:'init',sessionId:'retry-session'}); output({status:'checkpoint'});
 if(n===1 || input.prompt!=='retry-success') { output({status:'stream',text:'partial-attempt-'+n}); output({status:'error',error:'rate limit',failure:{kind:'rate_limited',provider:'claude',message:'rate limit'}}); process.exit(1); }
}
if(input.prompt.startsWith('resume-')) {
 fs.appendFileSync(process.cwd()+'/resume-inputs',JSON.stringify(input)+'\\n');
 if(input.sessionId || input.prompt==='resume-repeat') {
  if(input.prompt==='resume-checkpoint') output({status:'checkpoint'});
  output({status:'error',error:'missing resume',code:'runner_session_not_found',failure:{kind:'session_unusable',provider:'claude',message:'missing resume'}}); process.exit(1);
 }
 output({status:'init',sessionId:'fresh-session'});
}
if(input.prompt.startsWith('failure:')) { const kind=input.prompt.slice(8); output({status:'error',error:kind,failure:{kind,provider:'claude',message:kind}}); process.exit(1); }
if(input.prompt==='unclassified') { output({status:'error',error:'unclassified process failure'}); process.exit(1); }
if(input.prompt==='long') { setInterval(()=>{},1000); } else { output({status:'success',result:'LUNA_NOTHING_TO_SEND'}); }
`, { mode: 0o644 });
  const executor = createExecutor(db, grants, { scope:fixtureJobScope().scope,instanceId: "instance1", runtimeId: "runtime1", workerId: "worker1", dataRoot: join(root, "data"), runnerEntry: entry, runtimeEndpoint: endpoint, capacity: 2 });
  const executorEndpoint = await listen(executor.server);
  const client = new ExecutionClient(executorEndpoint, control); const worker = new ExecutionClient(executorEndpoint, maintenance);
  async function submit(id: string, context: string, prompt: string, project = false, legacy = false, options: { credentials?: boolean; timeoutMs?: number; kind?: JobRequest["runnerKind"]; resume?: string } = {}): Promise<Assignment> {
    const job: JobRequest = { ...(project ? { projectId: "project" } : {}), ...(prompt.startsWith("retry") && !legacy ? { retryPolicy: { maxConsecutiveRetries: 1, maxTotalRetries: 1, baseDelayMs: 500, maxDelayMs: 500 } } : {}), version: 2, ...fixtureJobScope(), jobId: id, invocationId: `inv_${id}`, environmentId: "luna", runnerContextId: context, scopeKey: `session:${context}`, runnerKind: options.kind ?? "main", ...(options.kind === "task" ? { taskId: `task_${id}`, taskRunId: `run_${id}` } : {}), sessionId: `session_${context}`, input: { runnerType: "claude", prompt, ...(options.resume ? { sessionId: options.resume } : {}) }, credentialsRevision: 1, timeoutMs: options.timeoutMs ?? 15000 };
    scheduler.submit(job); const reserved = scheduler.reserve(id, "worker1");
    const assignment: Assignment = { scope:job.scope, jobId: id, assignmentId: reserved.assignmentId!, instanceId: "instance1", workerId: "worker1", executionEnvironmentId: "env1", contextId: context, scopeKey: job.scopeKey, requestHash: contentHash(job), reservationId: `reservation_${id}` };
    scheduler.bind(id, assignment);
    const mounted = executor.contexts.provision(context, project ? { project: { projectId: "project" } } : {});
    if (project) {
      const directory = join(mounted.home, "projects");
      mkdirSync(directory, { recursive: true });
      chownSync(directory, mounted.uid, mounted.gid);
    }
    await worker.call("PUT", `/v1/contexts/${context}`, {scope:job.scope,...(project ? { project: { projectId: "project" } } : {})});
    await client.call("POST", "/v1/contexts", { scope:job.scope,contextId: context });
    await worker.call("PUT", `/v1/reservations/${assignment.reservationId}`, assignment);
    await client.call("POST", "/v1/jobs", { job, assignment });
    if (options.credentials !== false) await client.call("PUT", `/v1/jobs/${id}/credentials`, { assignment, credentials: { revision: 1, expiresAt: Date.now() + 60000, env: { LUNA_ACCESS_TOKEN: `test-token-${id}`, LUNA_SERVICE_URL: "http://service.test" } } });
    return assignment;
  }
  try {
    await executor.start();
    await client.call("PUT", "/v1/ingest-credentials", { credentialId: "instance-upload", token: upload, runtimeId: "runtime1" });
    await submit("resume-work", "resume-work-context", "resume-success", false, false, { kind: "work", resume: "stale" });
    await until(() => executor.store.snapshot("resume-work").state === "succeeded", "Work clears invalid resume within the same Job")
      .catch(error => { console.error(executor.store.snapshot("resume-work"), updates("resume-work")); throw error; });
    expect(executor.store.retries.require("resume-work")).toMatchObject({ attempt: 2, totalRetries: 1 });
    const resumeInputs = readFileSync(join(executor.contexts.get("resume-work-context").cwd, "resume-inputs"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(resumeInputs).toHaveLength(2);
    expect(resumeInputs[0].sessionId).toBe("stale");
    expect(resumeInputs[1]).not.toHaveProperty("sessionId");
    expect(executor.store.snapshot("resume-work").providerSessionId).toBe("fresh-session");
    for (const kind of ["main", "task"] as const) {
      await submit(`resume-${kind}`, `resume-${kind}-context`, "resume-success", false, false, { kind, resume: "stale" });
      await until(() => executor.store.snapshot(`resume-${kind}`).state === "failed", "Only Work can reset execution input here");
      expect(executor.store.retries.require(`resume-${kind}`).attempt).toBe(1);
    }
    for (const prompt of ["resume-checkpoint", "resume-repeat"]) {
      await submit(prompt, `${prompt}-context`, prompt, false, false, { kind: "work", resume: "stale" });
      await until(() => executor.store.snapshot(prompt).state === "failed", "Invalid resume cannot replay checkpoints or loop indefinitely");
      expect(executor.store.retries.require(prompt).attempt).toBe(prompt === "resume-checkpoint" ? 1 : 2);
    }
    await submit("retry1", "retryctx", "retry-success");
    await until(() => executor.store.snapshot("retry1").state === "succeeded", "same Job retries and succeeds");
    expect(executor.store.retries.require("retry1")).toMatchObject({ attempt: 2, totalRetries: 1, state: "finished" });
    const facts = db.query("SELECT process_json,exit_json FROM executor_attempts WHERE job_id='retry1' ORDER BY attempt").all() as { process_json: string; exit_json: string }[];
    expect(facts).toHaveLength(2);
    for (const fact of facts) {
      const identity = JSON.parse(fact.process_json);
      expect(identity.uid).toBe(executor.contexts.get("retryctx").uid);
      expect(identity.pid).toBeGreaterThan(0);
      expect(identity.startTime).toMatch(/^\d+$/);
    }
    expect(facts.map(fact => JSON.parse(fact.exit_json).code)).toEqual([1, 0]);
    await until(() => scheduler.require("retry1").placementState === "terminal", "online terminal is reported");
    const retryEvents = updates("retry1");
    expect(retryEvents.filter(event => event.kind === "terminal")).toHaveLength(1);
    expect(retryEvents.filter(event => event.kind === "provider" && event.data.status === "error")).toHaveLength(0);
    expect(retryEvents.some(event => event.kind === "state" && event.data.state === "retry_wait")).toBe(true);

    await closeExecutionServer(receiver);
    await submit("offline-retry", "offline-context", "retry-success");
    await until(() => executor.store.snapshot("offline-retry").state === "succeeded", "Runtime outage does not stop Executor retry");
    expect(executor.store.retries.require("offline-retry")).toMatchObject({ attempt: 2, totalRetries: 1 });
    await delay(250);
    expect(updates("offline-retry")).toEqual([]);
    await new Promise<void>(resolve => receiver.listen(Number(new URL(endpoint).port), "127.0.0.1", resolve));
    await delay(250);
    expect(updates("offline-retry")).toEqual([]);
    events.observe("offline-retry", executor.store.snapshot("offline-retry"));
    expect(events.list("offline-retry").filter(event => event.kind === "execution" && (event.data as { event: { kind: string } }).event.kind === "terminal")).toHaveLength(1);
    await submit("legacy-retry", "legacy-retry-context", "retry-success", false, true);
    await until(() => executor.store.snapshot("legacy-retry").state === "succeeded", "old request retries under its frozen default without changing hash");
    expect(executor.store.request("legacy-retry")).not.toHaveProperty("retryPolicy");
    expect(executor.store.retries.require("legacy-retry")).toMatchObject({ attempt: 2, policy: { maxConsecutiveRetries: 5, maxTotalRetries: 10 } });
    const retryCancel = await submit("retry2", "retryctx", "retry-cancel");
    await until(() => executor.store.snapshot("retry2").state === "retry_wait", "retry waiting persists");
    expect((await client.call<{ activeJobs: number }>("GET", "/v1/health")).activeJobs).toBeGreaterThan(0);
    await client.call("POST", "/v1/jobs/retry2/cancel", { assignment: retryCancel });
    await delay(650);
    expect(executor.store.snapshot("retry2").state).toBe("cancelled");
    expect(executor.store.retries.require("retry2").attempt).toBe(1);
    await submit("retry3", "retryctx", "retry-exhaust");
    await until(() => executor.store.snapshot("retry3").state === "failed", "retry budget ends the Job");
    expect(executor.store.retries.require("retry3")).toMatchObject({ attempt: 2, reason: "retry_budget_exhausted" });
    await until(() => updates("retry3").filter(event => event.kind === "terminal").length === 1, "one final report");
    for (const kind of ["authentication_failed", "permission_denied", "invalid_request", "unknown"]) {
      const id = `permanent-${kind}`;
      await submit(id, `context-${kind}`, `failure:${kind}`);
      await until(() => executor.store.snapshot(id).state === "failed", "permanent errors do not enter retry wait");
      expect(executor.store.retries.require(id)).toMatchObject({ attempt: 1, totalRetries: 0, state: "finished" });
      await until(() => updates(id).filter(event => event.kind === "terminal").length === 1, "one final report");
    }
    await submit("unclassified", "unclassified-context", "unclassified");
    await until(() => executor.store.snapshot("unclassified").state === "failed", "unknown process failure is not inferred as transient");
    expect(executor.store.retries.require("unclassified").attempt).toBe(1);
    await submit("task-no-checkpoint", "task-no-checkpoint-context", "failure:rate_limited", false, false, { kind: "task" });
    await until(() => executor.store.snapshot("task-no-checkpoint").state === "failed", "Task cannot retry without recoverable session and checkpoint");
    expect(executor.store.retries.require("task-no-checkpoint").attempt).toBe(1);
    for (const kind of ["work", "task"] as const) {
      await submit(`${kind}-checkpoint`, `${kind}-checkpoint-context`, "retry-success", false, false, { kind });
      await until(() => executor.store.snapshot(`${kind}-checkpoint`).state === "succeeded", "all Runner kinds share same-Job checkpoint continuation");
      expect(executor.store.retries.require(`${kind}-checkpoint`)).toMatchObject({ attempt: 2, totalRetries: 1 });
    }
    const first = await submit("job1", "context1", "long");
    await submit("queue-deadline", "context1", "short", false, false, { credentials: false, timeoutMs: 300 });
    await until(() => executor.store.snapshot("queue-deadline").state === "failed", "deadline applies while context is occupied and credentials are absent");
    expect(executor.store.retries.require("queue-deadline")).toMatchObject({ attempt: 0, state: "finished", reason: "deadline_exceeded" });
    expect(executor.store.snapshot("queue-deadline").error?.code).toBe("execution_timeout");

    const second = await submit("job2", "context1", "short");
    await submit("job3", "context2", "short");
    await until(() => executor.store.snapshot("job3").state === "succeeded", "other context completes while first runs");
    expect(executor.store.snapshot("job2").state).toBe("queued");
    await expect(worker.call("POST", "/v1/jobs/job1/cancel", { assignment: first })).rejects.toThrow("peer_role_denied");
    await client.call("POST", "/v1/jobs/job1/cancel", { assignment: first });
    await until(() => executor.store.snapshot("job2").state === "succeeded", "same context proceeds after cleanup");
    expect(executor.store.snapshot("job1").state).toBe("cancelled");
    await until(() => scheduler.require("job2").placementState === "terminal", "live terminal arrives directly");
    const output = updates("job2").filter((event) => event.kind === "provider");
    expect(JSON.stringify(output)).toContain(`uid=${executor.contexts.get("context1").uid};control=absent`);
    expect(JSON.stringify(output)).toContain("token=test-token-job2");
    expect(JSON.stringify(output)).not.toContain("test-token-job1");
    expect(executor.contexts.get("context1").home).toBe(executor.contexts.get("context2").home);
    expect(executor.contexts.get("context1").cwd).not.toBe(executor.contexts.get("context2").cwd);
    expect(JSON.stringify(output)).toContain(`home=${executor.contexts.get("context1").home}`);
    expect(JSON.stringify(output)).toContain(`cwd=${executor.contexts.get("context1").cwd}`);
    await submit("job4", "context2", "descendant");
    await until(() => executor.store.snapshot("job4").state === "succeeded", "detached child holding stdout is cleaned before terminal");
    expect((await client.call<{ state: string }>("POST", "/v1/jobs/job2/query", { assignment: second })).state).toBe("succeeded");
    await submit("project-job", "project-context", "project", true);
    await until(() => executor.store.snapshot("project-job").state === "succeeded", "project Runner completes with its assigned group");
    const created = statSync(join(executor.contexts.get("project-context").home, "projects", "created"));
    expect(created.gid).toBe(executor.contexts.get("project-context").gid);
    for (let index = 0; index < 10; index++) {
      const active = `cancel-stress-${index}`, next = `after-cancel-${index}`;
      const assignment = await submit(active, "cancel-stress-context", "long");
      await until(() => executor.store.snapshot(active).state === "running", "cancel owns a running process");
      await submit(next, "cancel-stress-context", "short");
      await client.call("POST", `/v1/jobs/${active}/cancel`, { assignment });
      await until(() => executor.store.snapshot(next).state === "succeeded", "completed cleanup cannot kill the next Job");
      expect(executor.store.snapshot(active).state).toBe("cancelled");
    }
    await submit("restart-retry", "restart-context", "retry-restart");
    await until(() => executor.store.snapshot("restart-retry").state === "retry_wait", "restart begins during persisted backoff");
    await executor.stop();
    const beforeRestart = executor.store.snapshot("restart-retry");
    const restarted = createExecutor(db, grants, { scope:fixtureJobScope().scope,instanceId: "instance1", runtimeId: "runtime1", workerId: "worker1", dataRoot: join(root, "data"), runnerEntry: entry, runtimeEndpoint: endpoint, capacity: 2 });
    try {
      restarted.reporter.configure(upload);
      await restarted.start();
      const afterRestart = restarted.store.snapshot("restart-retry");
      expect(afterRestart.state).toBe("interrupted");
      expect(afterRestart.streamId).toBe(beforeRestart.streamId);
      expect(afterRestart.lastSeq).toBe(beforeRestart.lastSeq + 1);
      expect(restarted.store.retries.require("restart-retry")).toMatchObject({ state: "finished", attempt: 1, reason: "executor_restarted" });
      await delay(650);
      expect(readFileSync(join(executor.contexts.get("restart-context").cwd, "retry-restart"), "utf8")).toBe("1");
      await until(() => updates("restart-retry").filter(event => event.kind === "terminal").length === 1, "the new interruption is reported once");
    } finally { await restarted.stop(); }

  } finally {
    await executor.stop(); await closeExecutionServer(executor.server); await closeExecutionServer(receiver);
    db.close(); runtimeDb.close(); rmSync(root, { recursive: true, force: true });
  }
}, 60000);


test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("context registration preserves its working directory and project binding", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-context-conflict-"));
  const db = openExecutionDatabase(":memory:");
  try {
    const contexts = new ExecutorContexts(root);
    const context = contexts.provision("context", { project: { projectId: "project" } });
    writeFileSync(join(context.cwd, "original"), "preserve");
    expect(() => contexts.provision("context", { requireMount: true, project: { projectId: "other" } })).toThrow("context_directory_conflict");
    expect(() => contexts.provision("outside", { cwd: join(root, "outside") })).toThrow("context_directory_conflict");
    expect(readFileSync(join(context.cwd, "original"), "utf8")).toBe("preserve");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
