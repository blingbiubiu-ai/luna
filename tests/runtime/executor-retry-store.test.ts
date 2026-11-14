import {fixtureJobScope} from "../helpers/job-scope";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutorStore } from "@luna/executor/executor/store";
import { openExecutionDatabase, contentHash } from "@luna/execution-store";
import { JobRequest, RetryPolicy } from "@luna/runner-protocol";

const policy = { maxConsecutiveRetries: 1, maxTotalRetries: 2, baseDelayMs: 10, maxDelayMs: 100 };

test("retry strategy is optional without changing old Job hashes, strict and bounded", () => {
  const old = { version: 2, ...fixtureJobScope(), jobId: "j", invocationId: "i", environmentId: "e", runnerContextId: "c", scopeKey: "session:c", runnerKind: "main", sessionId: "s", input: { runnerType: "codex", prompt: "test" }, credentialsRevision: 1, timeoutMs: 1000 };
  expect(contentHash(JobRequest.parse(old))).toBe(contentHash(old));
  expect(JobRequest.parse(old)).not.toHaveProperty("retryPolicy");
  expect(contentHash(JobRequest.parse({ ...old, retryPolicy: policy }))).not.toBe(contentHash(old));
  for (const invalid of [{ ...policy, maxTotalRetries: -1 }, { ...policy, maxConsecutiveRetries: 101 }, { ...policy, baseDelayMs: 101 }, { ...policy, maxDelayMs: 300001 }, { ...policy, unknown: 1 }]) expect(RetryPolicy.safeParse(invalid).success).toBe(false);
});

test("durable claims, backoff and cancellation survive reopening without another attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-retries-")); const file = join(root, "state.sqlite");
  let db = openExecutionDatabase(file);
  try {
    let store = retryStore(db);
    store.initialize("job", policy, 1000);
    expect(store.claim("job", 10)?.attempt).toBe(1);
    db.close(); db = openExecutionDatabase(file); store = retryStore(db);
    expect(store.claim("job", 11)).toBeNull();
    expect(store.schedule("job", 1, { now: 20, delayMs: 100, checkpoint: false, reason: "rate_limited" })).toBe(true);
    expect(store.schedule("job", 1, { now: 21, delayMs: 100, checkpoint: false, reason: "duplicate" })).toBe(false);
    db.close(); db = openExecutionDatabase(file); store = retryStore(db);
    expect(store.require("job").nextRetryAt).toBe(120);
    expect(store.claim("job", 119)).toBeNull();
    store.cancel("job");
    expect(store.require("job").state).toBe("cancel_requested");
    expect(store.claim("job", 120)).toBeNull();
    store.finish("job", 121, "cancelled");
    expect(store.require("job").state).toBe("finished");
    expect(db.query("SELECT count(*) AS n FROM executor_attempts").get()).toEqual({ n: 1 });
    expect(() => store.initialize("job", { ...policy, maxTotalRetries: 3 }, 1000)).toThrow("retry_policy_conflict");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("checkpoint resets only consecutive budget; deadline and total budget never reset", () => {
  const db = openExecutionDatabase(":memory:");
  try {
    const store = retryStore(db);
    store.initialize("job", policy, 1000);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(store.claim("job", attempt * 100)?.attempt).toBe(attempt);
      expect(store.schedule("job", attempt, { now: attempt * 100 + 1, delayMs: 10, checkpoint: true, reason: "rate_limited" })).toBe(attempt < 3);
    }
    expect(store.require("job")).toMatchObject({ state: "finished", totalRetries: 2, reason: "retry_budget_exhausted", deadlineAt: 1000 });
    store.initialize("deadline", policy, 100);
    store.claim("deadline", 1);
    expect(store.schedule("deadline", 1, { now: 90, delayMs: 10, checkpoint: false, reason: "rate_limited" })).toBe(false);
    expect(store.require("deadline").reason).toBe("deadline_exceeded");
    store.initialize("consecutive", policy, 1000); store.claim("consecutive", 1);
    expect(store.schedule("consecutive", 1, { now: 2, delayMs: 0, checkpoint: false, reason: "rate_limited" })).toBe(true);
    store.claim("consecutive", 3);
    expect(store.schedule("consecutive", 2, { now: 4, delayMs: 0, checkpoint: false, reason: "rate_limited" })).toBe(false);
    expect(store.require("consecutive").totalRetries).toBe(1);
  } finally { db.close(); }
});


test("legacy defaults freeze once and attempt process facts survive reopen without overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-attempt-facts-")); const path = join(root, "state.sqlite");
  let db = openExecutionDatabase(path);
  try {
    let store = retryStore(db);
    store.initialize("custom", policy, 10000);
    expect(store.initialize("custom", undefined, 10000).policy).toEqual(policy);
    const initial = store.initialize("legacy", undefined, 10000);
    expect(initial.policy).toEqual({ maxConsecutiveRetries: 5, maxTotalRetries: 10, baseDelayMs: 2000, maxDelayMs: 30000 });
    store.claim("legacy", 1);
    const identity = { pid: 123, startTime: "456", uid: 200001 };
    store.recordProcess("legacy", 1, identity);
    store.recordProcess("legacy", 1, identity);
    expect(() => store.recordProcess("legacy", 1, { ...identity, startTime: "457" })).toThrow("attempt_fact_conflict");
    db.close(); db = openExecutionDatabase(path); store = retryStore(db);
    expect(store.initialize("legacy", undefined, 10000).policy).toEqual(initial.policy);
    store.recordExit("legacy", 1, { code: 1, signal: null });
    expect(store.schedule("legacy", 1, { now: 2, delayMs: 10, checkpoint: false, reason: "rate_limited" })).toBe(true);
    const facts = db.query("SELECT process_json,exit_json FROM executor_attempts WHERE job_id='legacy'").get() as { process_json: string; exit_json: string };
    expect(JSON.parse(facts.process_json)).toEqual(identity);
    expect(JSON.parse(facts.exit_json)).toEqual({ code: 1, signal: null });
    expect(() => store.recordExit("legacy", 1, { code: 0, signal: null })).toThrow("attempt_not_active");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("fresh-session intent survives later transient retries and database reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-session-reset-")); const file = join(root, "state.sqlite");
  let db = openExecutionDatabase(file);
  try {
    let store = retryStore(db);
    store.initialize("job", { ...policy, maxConsecutiveRetries: 3 }, 1000);
    store.claim("job", 1);
    expect(store.schedule("job", 1, { now: 2, delayMs: 1, checkpoint: false, reason: "session_unusable", resetSession: true })).toBe(true);
    db.close(); db = openExecutionDatabase(file); store = retryStore(db);
    expect(store.claim("job", 3)?.sessionReset).toBe(true);
    expect(store.schedule("job", 2, { now: 4, delayMs: 1, checkpoint: false, reason: "rate_limited" })).toBe(true);
    expect(store.claim("job", 5)).toMatchObject({ attempt: 3, sessionReset: true, reason: "rate_limited", totalRetries: 2 });
    expect(store.schedule("job", 3, { now: 6, delayMs: 1, checkpoint: false, reason: "rate_limited" })).toBe(false);
    expect(store.require("job").reason).toBe("retry_budget_exhausted");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

function retryStore(db: ReturnType<typeof openExecutionDatabase>) {
  const store = new ExecutorStore(db, "instance");
  const { scope } = fixtureJobScope();
  for (const id of ["job", "deadline", "consecutive", "custom", "legacy"]) store.register({ scope, jobId: id, assignmentId: id, reservationId: id,
    instanceId: "instance", workerId: "worker", executionEnvironmentId: "environment", contextId: "context", scopeKey: "session:context", requestHash: "a".repeat(64) });
  return store.retries;
}
