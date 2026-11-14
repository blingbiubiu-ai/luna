import {fixtureJobScope} from "../helpers/job-scope";
import {fixtureExecutionReference} from "../helpers/platform-fixtures";
import {fixtureRunnerContext, fixtureNamedSession} from "../helpers/platform-fixtures";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionError } from "@luna/execution-store";
import { runnerContextOrigins, runnerContexts } from "../../src/data/schema";
import { PluginRegistry } from "../../src/plugins/registry";
import { AgentResourceBuilder } from "../../src/runners/agent-resource-builder";
import { InvocationResources } from "../../src/runners/invocation-resources";
import { decodeInvocation } from "../../src/runners/invocation-codec";
import { InvocationStore } from "../../src/runners/invocation-store";
import { RunnerFileStore } from "../../src/runners/runner-file-store";
import { RuntimeAgentTransport, RuntimeDetachedError } from "../../src/runners/runtime-agent-transport";
import { config, setLunaHome } from "../../src/shared";
import { runtimeStub } from "../fixtures/runtime-stub";

async function fixture(waitCode = "runtime_draining", project = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-preparation-drain-"))); const previousHome = config.paths.home; setLunaHome(root);
  mkdirSync(join(root, ".runner-skills")); mkdirSync(join(root, ".runner-bin")); writeFileSync(join(root, "AGENTS.md"), "test instructions");
  const sqlite = new Database(":memory:"); const db = drizzle(sqlite); migrate(db, { migrationsFolder: "src/data/drizzle" });
  fixtureNamedSession(db, "session");
  let seen!: () => void; const paused = new Promise<void>(resolve => { seen = resolve; });
  const requests: { operationId: string; operation: { kind: string }; projectId?: string }[] = [];
  const submitted: { projectId?: string }[] = [];
  const verified: unknown[] = [];
  if (project) { mkdirSync(config.paths.sharedWorkspace, { recursive: true }); writeFileSync(join(config.paths.sharedWorkspace, "source"), "original"); }
  const control: { paused: boolean; deny: boolean; blockProvision: boolean; healthGate?: Promise<void> } = { paused: true, deny: false, blockProvision: true };
  const scoped=fixtureJobScope();
  const client = runtimeStub({
    preparedContext:()=>({protocolVersion:2,scope:scoped.scope,resources:scoped.resources,resourceRevision:scoped.resources.digest,workerId:"worker",home:root,cwd:root,env:{},local:true,instructionFingerprint:"fixture"}),
    sharedProject: project ? { projectId: "shared-project" } : undefined,
    async verify() { if (control.healthGate) { seen(); await control.healthGate; throw new ExecutionError(503, "health_unavailable"); } },
    async submit(job) { submitted.push(job.projectId ? { projectId: job.projectId } : {}); throw new ExecutionError(422, "test_submission_boundary"); },
    async files<T>(input: Parameters<import("../../src/runtime/execution-runtime").ExecutionRuntime["files"]>[0]): Promise<T> {
      const body = input as typeof requests[number]; requests.push(body);
      if (control.deny) throw new ExecutionError(403, "file_denied");
      if (control.paused && (control.blockProvision || body.operation.kind !== "provision")) { seen(); throw new ExecutionError(503, waitCode); }
      return (body.operation.kind === "provision" ? { home: root, cwd: root } : {}) as T;
    },
  });
  return { root, client, db, requests, submitted, verified, control, paused, async close() { sqlite.close(); setLunaHome(previousHome); rmSync(root, { recursive: true, force: true }); } };
}

for (const waitCode of ["runtime_draining", "environment_mount_pending", "no_worker_available"]) test(`setup waits through ${waitCode} with the same operation ID and does not replay completed operations`, async () => {
  const f = await fixture(waitCode);
  try {
    let finished = false;
    const prepared = new RunnerFileStore(f.client).prepare({ contextId: "context", scopeKey: "session:context", invocationId: "inv", localRoot: f.root }).then(home => { finished = true; return home; });
    await f.paused; expect(finished).toBe(false); f.control.paused = false;
    expect(await prepared).toBe(f.root);
    expect(f.requests.map(request => request.operation.kind)).toEqual(["provision", "provision"]);
    expect(f.requests[0]!.operationId).toBe(f.requests[1]!.operationId);
    f.control.deny = true;
    await expect(new RunnerFileStore(f.client).prepare({ contextId: "context", scopeKey: "session:context", invocationId: "denied", localRoot: f.root })).rejects.toMatchObject({ code: "file_denied" });
    expect(f.requests).toHaveLength(3);
  } finally { await f.close(); }
});

for (const action of ["cancel", "detach"] as const) test(`pre-Job drain wait distinguishes ${action} and creates no execution`, async () => {
  const f = await fixture(); f.control.blockProvision = true;
  f.db.insert(runnerContexts).values(fixtureRunnerContext(f.db, { id: "context", owner_type: "session", owner_id: "session", runner_type: "codex", runner_root_path: f.root, created_at: 0, updated_at: 0 })).run();
  f.db.insert(runnerContextOrigins).values({ contextId: "context", runtimeId: "runtime" }).run();
  const store = new InvocationStore(f.db);
  store.register({ agentConfig:fixtureExecutionReference(f.db), id: "inv", runnerKind: "work", actorUserId: "user", runnerContextId: "context", sessionId: "session", taskId: null, taskRunId: null, originId: "turn", inputSnapshot: decodeInvocation({ version: 1, kind: "work", input: {sessionId: "session", runnerContextId: "context", turnId: "turn"} }), contextPackIds: [] });
  const transport = new RuntimeAgentTransport(f.db, f.client); const cancellation = new AbortController();
  try {
    const iterator = transport.stream({ id: "message", role: "user", session_id: "session", content: [{ type: "text", text: "work" }] }, { cwd: f.root, runnerContextId: "context", isNewSession: true, signal: cancellation.signal, env: { LUNA_INVOCATION_ID: "inv" } }, "codex", undefined, {});
    const outcome = iterator.next().then(() => null, error => error);
    await Promise.race([f.paused, outcome.then(error => { throw error ?? new Error("Unexpected completion"); })]);
    const reason = new Error("User cancelled preparation");
    if (action === "detach") await transport.detach(); else cancellation.abort(reason);
    const error = await outcome;
    if (action === "detach") expect(error).toBeInstanceOf(RuntimeDetachedError); else expect(error).toBe(reason);
    expect(store.require("inv").state).toBe(action === "detach" ? "active" : "revoked");
    expect(store.require("inv").activeJobId).toBeNull();
    expect(f.requests).toHaveLength(1);
  } finally { await transport.detach(); await f.close(); }
});


test("Service transport binds a configured project without a legacy verification round trip", async () => {
  const f = await fixture("runtime_draining", true); f.control.paused = false;
  f.db.insert(runnerContexts).values(fixtureRunnerContext(f.db, { id: "context", owner_type: "session", owner_id: "session", runner_type: "codex", runner_root_path: f.root, created_at: 0, updated_at: 0 })).run();
  f.db.insert(runnerContextOrigins).values({ contextId: "context", runtimeId: "runtime" }).run();
  const store = new InvocationStore(f.db);
  store.register({ agentConfig:fixtureExecutionReference(f.db), id: "inv", runnerKind: "work", actorUserId: "user", runnerContextId: "context", sessionId: "session", taskId: null, taskRunId: null, originId: "turn", inputSnapshot: decodeInvocation({ version: 1, kind: "work", input: { sessionId: "session", runnerContextId: "context", turnId: "turn" } }), contextPackIds: [] });
  const invocation = store.require("inv");
  const builder = new AgentResourceBuilder(f.db, f.root, new PluginRegistry());
  const { selection } = new InvocationResources(f.db, f.root).pin(invocation.id, builder);
  const prepared = f.client.preparedContext!("context")!;
  f.client.preparedContext = () => ({
    ...prepared,
    scope: { ...prepared.scope, agentId: invocation.agentId, shadowId: invocation.shadowId },
    resources: selection,
    resourceRevision: selection.digest,
  });
  const transport = new RuntimeAgentTransport(f.db, f.client);
  try {
    const iterator = transport.stream({ id: "message", role: "user", session_id: "session", content: [{ type: "text", text: "work" }] }, { cwd: f.root, runnerContextId: "context", isNewSession: true, env: { LUNA_INVOCATION_ID: "inv" } }, "codex", undefined, {});
    await expect(iterator.next()).rejects.toMatchObject({ code: "test_submission_boundary" });
    expect(f.verified).toEqual([]);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.every(request => request.projectId === "shared-project")).toBe(true);
    expect(f.submitted).toEqual([expect.objectContaining({ projectId: "shared-project" })]);
    expect(store.job(store.require("inv").activeJobId!)?.request.projectId).toBe("shared-project");
  } finally { await transport.detach(); await f.close(); }
});

for (const action of ["cancel", "detach"] as const) test(`pre-Job health failure distinguishes ${action} and creates no execution`, async () => {
  const f = await fixture();
  let release!: () => void; f.control.healthGate = new Promise<void>(resolve => { release = resolve; });
  f.db.insert(runnerContexts).values(fixtureRunnerContext(f.db, { id: "context", owner_type: "session", owner_id: "session", runner_type: "codex", runner_root_path: f.root, created_at: 0, updated_at: 0 })).run();
  f.db.insert(runnerContextOrigins).values({ contextId: "context", runtimeId: "runtime" }).run();
  const store = new InvocationStore(f.db);
  store.register({ agentConfig:fixtureExecutionReference(f.db), id: "inv", runnerKind: "work", actorUserId: "user", runnerContextId: "context", sessionId: "session", taskId: null, taskRunId: null, originId: "turn", inputSnapshot: decodeInvocation({ version: 1, kind: "work", input: {sessionId: "session", runnerContextId: "context", turnId: "turn"} }), contextPackIds: [] });
  const transport = new RuntimeAgentTransport(f.db, f.client); const cancellation = new AbortController();
  try {
    const iterator = transport.stream({ id: "message", role: "user", session_id: "session", content: [{ type: "text", text: "work" }] }, { cwd: f.root, runnerContextId: "context", isNewSession: true, signal: cancellation.signal, env: { LUNA_INVOCATION_ID: "inv" } }, "codex", undefined, {});
    const outcome = iterator.next().then(() => null, error => error);
    await Promise.race([f.paused, outcome.then(error => { throw error ?? new Error("Unexpected completion"); })]);
    const reason = new Error("User cancelled preparation");
    if (action === "detach") await transport.detach(); else cancellation.abort(reason);
    release();
    const error = await outcome;
    if (action === "detach") expect(error).toBeInstanceOf(RuntimeDetachedError); else expect(error).toBe(reason);
    expect(store.require("inv").state).toBe(action === "detach" ? "active" : "revoked");
    expect(store.require("inv").activeJobId).toBeNull();
    expect(f.requests).toHaveLength(0);
  } finally { release(); await transport.detach(); await f.close(); }
});

test("file preparation requires a Worker-resolved context and never falls back to Service paths",async()=>{
 const client=runtimeStub();
 await expect(new RunnerFileStore(client).prepare({contextId:"context",scopeKey:"session:context",invocationId:"inv",localRoot:"/service/path"})).rejects.toMatchObject({code:"context_preparation_required"});
});
