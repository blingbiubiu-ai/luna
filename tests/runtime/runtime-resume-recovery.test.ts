import {fixtureExecutionReference} from "../helpers/platform-fixtures";
import {decodeInvocation} from "../../src/runners/invocation-codec";
import {fixtureRunnerContext, fixtureNamedSession} from "../helpers/platform-fixtures";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@luna/runner-protocol";
import { runnerContexts } from "../../src/data/schema";
import { MainRunnerFreshLaunchReplayRequiredError } from "../../src/main-runner/main-runner";
import type { DrizzleDB } from "../../src/data";
import { PluginRegistry } from "../../src/plugins/registry";
import { AgentResourceBuilder } from "../../src/runners/agent-resource-builder";
import { InvocationResources } from "../../src/runners/invocation-resources";
import { InvocationStore } from "../../src/runners/invocation-store";
import { RuntimeAgentTransport } from "../../src/runners/runtime-agent-transport";
import { runtimeStub } from "../fixtures/runtime-stub";

for (const checkpoint of [false, true]) {
  test(`Main missing resume with checkpoint=${checkpoint} preserves its recovery boundary`, async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-resume-"));
    const sqlite = new Database(":memory:"); const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: "src/data/drizzle" });
    fixtureNamedSession(db, "session");
    db.insert(runnerContexts).values(fixtureRunnerContext(db, { id: "context", owner_type: "session", owner_id: "session", runner_type: "codex", runner_root_path: root, runner_session_id: "stale", created_at: 0, updated_at: 0 })).run();
    const events = [
      { jobId: "job", seq: 1, kind: "execution", data: { event: { seq: 1, at: 1, kind: "provider", data: { status: "error", error: "missing resume", code: "runner_session_not_found", failure: { kind: "session_unusable", provider: "codex", message: "missing resume" } } } } },
      { jobId: "job", seq: 2, kind: "execution", data: { event: { seq: 2, at: 2, kind: "terminal", data: { jobId: "job", assignmentId: "assignment", instanceId: "instance", bootId: "boot", streamId: "stream", requestHash: "hash", state: "failed", lastSeq: 2, createdAt: 1, providerCheckpoint: checkpoint,
        retry: { attempt: 1, totalRetries: 0, consecutiveRetries: 0, deadlineAt: 1000, nextRetryAt: null, reason: "runner_failed" } } } } },
    ];
    const calls: string[] = [];
    const client = runtimeStub({
      async submit() { calls.push("submit"); return { placementState: "terminal" } as never; },
      async *events(_id, after) { yield* events.filter(event => event.seq > after) as RuntimeEvent[]; },
      async query() { return { placementState: "terminal", lastSeq: events.length } as never; },
    });
    const transport = new RuntimeAgentTransport(db, client);
    try {
      transport.store.register({ agentConfig:fixtureExecutionReference(db), id: "inv", runnerKind: "main", actorUserId: "user:user", runnerContextId: "context", sessionId: "session", taskId: null, taskRunId: null, originId: "turn", inputSnapshot: mainSnapshot(db), contextPackIds: [] });
      transport.store.createJob("runtime", { version: 2, ...fixtureInvocationJobScope(db, transport.store, "inv", root), jobId: "job", invocationId: "inv", environmentId: "luna", runnerContextId: "context", scopeKey: "session:context", runnerKind: "main", sessionId: "session", input: { runnerType: "codex", prompt: "original", sessionId: "stale" }, credentialsRevision: 1, timeoutMs: 1000 });
      let invalidations = 0;
      const run = async () => {
        for await (const _ of transport.stream({ id: "message", role: "user", session_id: "session", content: [{ type: "text", text: "original" }] }, {
          cwd: root, runnerContextId: "context", runnerSessionId: "stale", isNewSession: false, env: { LUNA_INVOCATION_ID: "inv" },
          invalidateRunnerSession: () => { invalidations++; throw new MainRunnerFreshLaunchReplayRequiredError(); },
        }, "codex", undefined, {})) { /* Terminal failure produces no business answer. */ }
      };
      if (checkpoint) await expect(run()).rejects.toThrow("missing resume");
      else await expect(run()).rejects.toBeInstanceOf(MainRunnerFreshLaunchReplayRequiredError);
      expect(invalidations).toBe(checkpoint ? 0 : 1);
      expect(transport.store.require("inv").state).toBe(checkpoint ? "active" : "settled");
      expect(transport.store.job("job")!.state).toBe(checkpoint ? "terminal" : "settled");
      expect(db.select().from(runnerContexts).where(eq(runnerContexts.id, "context")).get()!.runner_session_id).toBeNull();
      expect(transport.store.jobsFor("inv")).toHaveLength(1);
      expect(calls.filter(call => call === "submit")).toHaveLength(1);
    } finally {
      await transport.detach();
      sqlite.close(); rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const delivery of ["live", "reattach", "reattach-live", "snapshot", "partial", "partial-success", "empty", "missing-final"] as const) {
  test(`Main completion survives a missing success event with ${delivery} output`, async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-terminal-output-"));
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: "src/data/drizzle" });
    fixtureNamedSession(db, "session");
    db.insert(runnerContexts).values(fixtureRunnerContext(db, {id: "context", owner_type: "session", owner_id: "session", runner_type: "codex", runner_root_path: root, created_at: 0, updated_at: 0})).run();
    const marker = "LUNA_NOTHING_TO_SEND";
    const trace = "<Bash> luna messages send --text answer";
    const stream = [trace, marker].map((text, index) => ({ jobId: "job", seq: index + 1, kind: "execution" as const,
      data: { event: { seq: index + 1, at: index + 1, kind: "provider", data: { status: "stream", text } } } }));
    const freshText = [marker, "New phase", marker];
    const freshStream = freshText.map((text, index) => ({ jobId: "job", seq: index + 3, kind: "execution" as const,
      data: { event: { seq: index + 3, at: index + 3, kind: "provider", data: { status: "stream", text } } } }));
    const terminal = { jobId: "job", seq: delivery === "reattach-live" ? 6 : delivery === "snapshot" ? 1 : ["partial", "empty", "missing-final"].includes(delivery) ? 2 : 3, kind: "execution" as const,
      data: { event: { seq: 4, at: 4, kind: "terminal", data: {
        jobId: "job", assignmentId: "assignment", instanceId: "instance", bootId: "boot", streamId: "stream",
        requestHash: "hash", state: "succeeded", lastSeq: 4, createdAt: 1,
        result: trace + "\n" + marker,
        ...(delivery === "missing-final" ? {} : { finalText: delivery === "empty" ? "" : marker }),
      } } } };
    const success = { jobId: "job", seq: 2, kind: "execution" as const,
      data: { event: { seq: 3, at: 3, kind: "provider", data: { status: "success", result: trace + "\n" + marker } } } };
    const events = delivery === "reattach-live" ? [...stream, ...freshStream, terminal] : delivery === "live" ? [...stream, terminal]
      : ["partial", "empty", "missing-final"].includes(delivery) ? [stream[0]!, terminal]
      : delivery === "partial-success" ? [stream[0]!, success, terminal] : [terminal];
    const client = runtimeStub({
      async submit() { return { placementState: "terminal" } as never; },
      async *events(_id, after) { yield* events.filter(event => event.seq > after) as RuntimeEvent[]; },
      async query() { return { placementState: "terminal", lastSeq: events.length } as never; },
    });
    const transport = new RuntimeAgentTransport(db, client);
    try {
      transport.store.register({ agentConfig:fixtureExecutionReference(db), id: "inv", runnerKind: "main", actorUserId: "user:user", runnerContextId: "context",
        sessionId: "session", taskId: null, taskRunId: null, originId: "turn", inputSnapshot: mainSnapshot(db), contextPackIds: [] });
      transport.store.createJob("runtime", { version: 2, ...fixtureInvocationJobScope(db, transport.store, "inv", root), jobId: "job", invocationId: "inv", environmentId: "luna",
        runnerContextId: "context", scopeKey: "session:context", runnerKind: "main", sessionId: "session",
        input: { runnerType: "codex", prompt: "test" }, credentialsRevision: 1, timeoutMs: 1000 });
      if (delivery === "reattach" || delivery === "reattach-live") for (const event of stream) transport.store.consume(event, () => {});
      const text: string[] = [];
      const collect = async () => {
        for await (const event of transport.stream({ id: "message", role: "user", session_id: "session", content: [{ type: "text", text: "test" }] },
          { cwd: root, runnerContextId: "context", isNewSession: true, env: { LUNA_INVOCATION_ID: "inv" } }, "codex", undefined, {})) {
          if (event.role === "assistant") for (const part of event.content) if (part.type === "text") text.push(part.text);
        }
      };
      if (delivery === "missing-final") await expect(collect()).rejects.toThrow("without confirmed final output");
      else {
        await collect();
        expect(text.at(-1)).toBe(delivery === "empty" ? "" : marker);
        expect(text).not.toContain(trace + "\n" + marker);
        if (delivery === "reattach") expect(text).toEqual([marker]);
        if (delivery === "reattach-live") expect(text).toEqual([...freshText, marker]);
      }
      expect(transport.store.job("job")!.state).toBe("terminal");
    } finally {
      await transport.detach();
      sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function fixtureInvocationJobScope(db: DrizzleDB, store: InvocationStore, invocationId: string, root: string) {
  const invocation = store.require(invocationId);
  const builder = new AgentResourceBuilder(db, root, new PluginRegistry());
  const { selection } = new InvocationResources(db, root).pin(invocationId, builder);
  return {
    scope: { agentId: invocation.agentId, shadowId: invocation.shadowId, placementGeneration: 1 },
    resources: selection,
    resourceRevision: selection.digest,
  };
}

function mainSnapshot(db: DrizzleDB) {
  const context = db.select().from(runnerContexts).where(eq(runnerContexts.id, "context")).get()!;
  return decodeInvocation({version: 1, kind: "main", input: {
    runnerContext: {...context, workspacePath: context.runner_root_path, ipcPath: context.runner_root_path},
    turnId: "turn", input: {type: "session_trigger", triggerId: "trigger", instruction: "test",
      requesterUserId: "user:user", context: {sessionId: "session", candidateOpenTasks: []}, artifactRefs: [],
      sourceSessionId: "session", correlationId: "correlation", hops: 0}
  }});
}
