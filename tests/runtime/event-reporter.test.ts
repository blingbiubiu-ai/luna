import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { contentHash, openExecutionDatabase } from "@luna/execution-store";
import { TokenAuthority, closeExecutionServer, executionServer, json, readJson } from "@luna/execution-transport";
import { ExecutorStore } from "@luna/executor/executor/store";
import { ExecutorEventReporter } from "@luna/executor/executor/event-reporter";
import type { JobRequest } from "@luna/runner-protocol";

test("a failed live report is discarded and new output can still arrive", async () => {
  const db = openExecutionDatabase(":memory:");
  const grants = new TokenAuthority(); const token = grants.issue("upload", { role: "executor", id: "instance1" });
  let calls = 0;
  let arrived!: () => void; let release!: () => void;
  const received = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = executionServer(grants, async ({ request, response }) => {
    await readJson(request); calls++; arrived(); await gate;
    json(response, calls === 1 ? 503 : 204);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new ExecutorStore(db, "instance1");
  const job: JobRequest = { version: 2, ...fixtureJobScope(), jobId: "job1", invocationId: "inv1", environmentId: "luna", runnerContextId: "ctx1", scopeKey: "session:ctx1", runnerKind: "main", sessionId: "session1", input: { runnerType: "claude", prompt: "test" }, credentialsRevision: 1, timeoutMs: 10000 };
  const assignment = { scope:job.scope, jobId: job.jobId, assignmentId: "assignment1", instanceId: "instance1", workerId: "worker1", executionEnvironmentId: "environment1", contextId: "ctx1", scopeKey: job.scopeKey, requestHash: contentHash(job), reservationId: "reservation1" };
  store.register(assignment); store.submit({ job, assignment });
  const reporter = new ExecutorEventReporter(store, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  try {
    reporter.configure(token);
    const uploading = reporter.tick();
    await received;
    reporter.configure(token); release();
    await uploading;
    expect(reporter.status().lastError).toBeTruthy();
    await reporter.tick();
    expect(calls).toBe(1);
    store.output(job.jobId, { status: "stream", text: "new live output" });
    await reporter.tick();
    expect(calls).toBe(2);
    expect(reporter.status().lastError).toBeNull();
  } finally { release(); reporter.stop(); await closeExecutionServer(server); db.close(); }
});

test("terminal snapshot retains the last message after live output is discarded", () => {
  const db = openExecutionDatabase(":memory:");
  try {
    const store = new ExecutorStore(db, "instance");
    const job: JobRequest = { version: 2, ...fixtureJobScope(), jobId: "job", invocationId: "inv", environmentId: "luna",
      runnerContextId: "context", scopeKey: "session:context", runnerKind: "main", sessionId: "session",
      input: { runnerType: "codex", prompt: "test" }, credentialsRevision: 1, timeoutMs: 10000 };
    const assignment = { scope:job.scope, jobId: job.jobId, assignmentId: "assignment", instanceId: "instance", workerId: "worker",
      executionEnvironmentId: "environment", contextId: "context", scopeKey: job.scopeKey, requestHash: contentHash(job), reservationId: "reservation" };
    store.register(assignment);
    store.submit({ job, assignment });
    store.transition(job.jobId, "starting");
    store.transition(job.jobId, "running");
    store.output(job.jobId, { status: "stream", text: "<Bash> luna messages send" });
    store.output(job.jobId, { status: "stream", text: "LUNA_NOTHING_TO_SEND" });
    store.output(job.jobId, { status: "success", result: "LUNA_NOTHING_TO_SEND" });
    store.takeLiveEvents();
    expect(store.transition(job.jobId, "succeeded").finalText).toBe("LUNA_NOTHING_TO_SEND");
    expect(new ExecutorStore(db, "instance").snapshot(job.jobId).finalText).toBe("LUNA_NOTHING_TO_SEND");
  } finally { db.close(); }
});
