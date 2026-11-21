import { fixtureNamedSession, fixtureRunnerContext } from "../helpers/platform-fixtures";
import { InvocationResources } from "@/runners/invocation-resources";
import { AgentResourceBuilder } from "@/runners/agent-resource-builder";
import { PluginRegistry } from "@/plugins/registry";
import { executionReference } from "@/agent-config/execution-reference";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { closeExecutionServer, TokenAuthority } from "@luna/execution-transport";
import { openPlatformExecutionDatabase, writePrivateJson, contentHash } from "@luna/execution-store";
import { runnerContexts, runnerContextOrigins,  sessionTurns, tasks, taskRuns, timelineEvents } from "../../src/data/schema";
import { ActiveAgentConfigService } from "../../src/agent-config/active-agent-config-service";
import { AgentProfileStore } from "../../src/agent-config/agent-profile-store";
import { AgentSecretCipher } from "../../src/agent-config/secret-cipher";
import { ExecutorStore } from "@luna/executor/executor/store";
import { Credentials, type JobRequest } from "@luna/runner-protocol";
import { TaskRunStore } from "../../src/tasks/task-run-store";
import { taskReportForRun } from "../../src/tasks/task-report-store";
import { encodeInvocation } from "../../src/runners/invocation-codec";
import { InvocationService } from "../../src/runners/invocation-service";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { RuntimeConfig } from "../../src/runtime/config";
import { RuntimeScheduler } from "../../src/runtime/scheduler";
import { runtimeServer } from "../../src/runtime/server";

test("Service process restart settles a cancelled intent and reattaches an active Task", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-service-recovery-"));
  const connection = join(root, "runtime.json");
  const runtimeDb = openPlatformExecutionDatabase(join(root, "runtime.sqlite"));
  const authority = new TokenAuthority(runtimeDb);
  const serviceToken = authority.issue("service", { role: "service", id: "service" });
  const adminToken = authority.issue("deployment-admin", { role: "runtime", id: "runtime" });
  const scheduler = new RuntimeScheduler(runtimeDb, RuntimeConfig.parse({
    runtimeId: "runtime", serviceId: "service", dataRoot: root, serviceToken, adminToken,
    homeWorkerId: "worker",
  }), authority);
  const runtime = runtimeServer(authority, scheduler);
  await new Promise<void>(resolve => runtime.listen(0, "127.0.0.1", resolve));
  writePrivateJson(connection, { ...scheduler.config, port: (runtime.address() as { port: number }).port });
  await closeExecutionServer(runtime);
  writeFileSync(join(root, "config.yaml"), [
    "sandbox:", "  runtimeConfigFile: " + JSON.stringify(connection),
    "paths:", "  sharedWorkspaceDir: " + JSON.stringify(join(root, "absent-project")), "",
  ].join("\n"));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const url = "http://127.0.0.1:" + port;
  const signingSecret = "service-recovery-test-secret";
  const masterKey = Buffer.alloc(32, 1).toString("base64");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let sqlite: Database | undefined;
  const stop = async () => {
    if (!child) return;
    child.kill("SIGKILL");
    await child.exited;
    child = undefined;
  };
  const start = async () => {
    // Use the real boot entrypoint with a private home, empty channel config and a separate port.
    const entry = process.env.LUNA_TEST_BUILT_ENTRYPOINTS === "1"
      ? "../../dist/luna-service.js" : "../../src/cli/server-main.ts";
    child = Bun.spawn([process.execPath, join(import.meta.dir, entry),
      "start", "--foreground", "--home", root, "--runtime-dir", join(root, "run"),
      "--host", "127.0.0.1", "--port", String(port)],
    { env: { PATH: process.env.PATH, HOME: root, LUNA_HOME: root, LUNA_ACCESS_TOKEN_SECRET: signingSecret, LUNA_AGENT_CONFIG_MASTER_KEY: masterKey },
      stdout: Bun.file(join(root, "stdout.log")), stderr: Bun.file(join(root, "stderr.log")) });
    const startupLog = Bun.file(join(root, "stdout.log"));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && child.exitCode === null) {
      const response = await fetch(url + "/api/health", { signal: AbortSignal.timeout(500) }).catch(() => undefined);
      if (response?.ok && (await startupLog.text()).includes('"service":"luna-agent-runtime"')) return child.pid;
      await delay(100);
    }
    throw new Error("Service failed to listen. " + await Bun.file(join(root, "stderr.log")).text());
  };
  try {
    const firstPid = await start();
    sqlite = new Database(join(root, "data/luna.db"));
    const db = drizzle(sqlite);
    sqlite.exec("PRAGMA foreign_keys=ON");
    const scope = fixtureNamedSession(db, "session", "actor");
    db.insert(runnerContexts).values(fixtureRunnerContext(db, {
      id: "context", owner_type: "session", owner_id: "session", runner_type: "codex",
      runner_root_path: join(root, "runners", "session"), created_at: 1, updated_at: 1,
    })).run();
    const skills = join(root, "fixture-skills"), prompts = join(root, "fixture-prompts");
    mkdirSync(skills);
    mkdirSync(prompts);
    writeFileSync(join(prompts, "MAIN.md"), "Fixture instructions");
    const builder = new AgentResourceBuilder(db, root, new PluginRegistry(), {
      bundledSkillsDirectory: skills, promptAssetsDirectory: prompts, repoRoot: root,
    });
    const resources = new InvocationResources(db, root);
    const jobScope = (id: string) => {
      const {selection} = resources.pin(id, builder);
      return {scope: {agentId: scope.agentId, shadowId: scope.shadowId, placementGeneration: 1}, resources: selection, resourceRevision: selection.digest};
    };
    db.insert(sessionTurns).values({ id: "turn", session_id: "session", turn_kind: "execution", status: "running", runner_invoked: true, reason: "addressed", started_at: 0, created_at: 0, updated_at: 0 }).run();
    const invocations = new InvocationService(db);
    invocations.store.register({ id: "inv", runnerKind: "work", actorUserId: scope.ownerUserId, runnerContextId: "context",
      sessionId: "session", taskId: null, taskRunId: null, originId: "turn", contextPackIds: [],
      inputSnapshot: encodeInvocation("work", { sessionId: "session", runnerContextId: "context", turnId: "turn" }) });
    invocations.store.createJob("runtime", { version: 2, ...jobScope("inv"), jobId: "job", invocationId: "inv",
      environmentId: "luna", runnerContextId: "context", scopeKey: "session:context", runnerKind: "work",
      sessionId: "session", input: { runnerType: "codex", prompt: "Unsubmitted intent" }, credentialsRevision: 1, timeoutMs: 30000 });
    const tokens = new AccessTokenService({ db, signingSecret });
    const issued = tokens.issueToken({ userId: scope.ownerUserId, name: "Work test", source: "runner", role: "runner",
      runnerKind: "work", sourceRunnerJobId: "context", sourceSessionId: "session", metadata: { invocationId: "inv" }, ttlMs: 60000, now: Date.now() });
    invocations.store.bindToken("inv", issued.record.id);
    const commandRequest = () => fetch(url + "/api/runner/commands/absent", {
      headers: { Authorization: "Bearer " + issued.token },
      signal: AbortSignal.timeout(5000),
    });
    expect((await commandRequest()).status).toBe(404);
    // Simulate the crash window between durable local revocation and remote submission/cancellation.
    scheduler.mode.drain();
    invocations.revoke("inv", "user_cancelled");
    expect(scheduler.jobs.list()).toHaveLength(0);
    await stop();
    expect(await start()).not.toBe(firstPid);
    const deadline = Date.now() + 15000;
    while (invocations.store.job("job")?.state !== "settled" && Date.now() < deadline) await delay(100);
    expect(invocations.store.job("job")).toMatchObject({ state: "settled" });
    expect(invocations.store.require("inv").state).toBe("revoked");
    expect(db.select().from(sessionTurns).where(eq(sessionTurns.id, "turn")).get()).toMatchObject({ status: "failed", error: "user_cancelled" });
    expect(scheduler.jobs.list()).toHaveLength(1);
    expect(scheduler.jobs.require("job")).toMatchObject({ placementState: "terminal", workerId: null, cancelRequested: true });
    expect((await commandRequest()).status).toBe(401);
    expect(() => tokens.verifyBearer(issued.token, { now: Date.now() })).toThrow("revoked_access_token");
    const seq = scheduler.events.lastSequence("job");
    await stop();
    await start();
    expect(scheduler.events.lastSequence("job")).toBe(seq);
    expect(invocations.store.job("job")?.state).toBe("settled");

    // Seed a second invocation at the crash boundary after dispatch. The actual
    // Service process must discover it from its ledger and attach through the embedded interface.
    scheduler.mode.resume();
    const cipher = AgentSecretCipher.fromEnvironment({ LUNA_AGENT_CONFIG_MASTER_KEY: masterKey });
    const profiles = new AgentProfileStore(db, cipher, scope.agentId);
    const profile = profiles.createProfile({
      name: "Recovery fixture", agentType: "codex", model: "gpt-5",
      env: { OPENAI_BASE_URL: "http://127.0.0.1:9" }, secrets: { OPENAI_API_KEY: { set: "unused-fixture-key" } },
    });
    profiles.recordValidation(profile.latestRevision.id, { success: true, message: "fixture" });
    const configs = new ActiveAgentConfigService(db, cipher);
    configs.activate(scope.agentId, profile.latestRevision.id, "actor");
    const agentConfig = executionReference(configs.resolveExecutionSnapshot(scope.agentId));
    const taskId = "active-task", taskRunId = "active-run", contextId = "task-context";
    db.insert(tasks).values({
      id: taskId, type: "execution", title: "Recovery test", status: "running",
      context_json: { requestedByIdentity: { provider: "local", externalUserId: scope.ownerUserId } },
      created_at: 1, updated_at: 1, last_activity_at: 1, agent_id: scope.agentId, shadow_id: scope.shadowId}).run();
    db.insert(runnerContexts).values(fixtureRunnerContext(db, {
      id: contextId, owner_type: "task", owner_id: taskId, runner_type: "codex",
      runner_root_path: join(root, "runners", "task-context"), created_at: 1, updated_at: 1,
    })).run();
    db.insert(runnerContextOrigins).values({ contextId, runtimeId: "runtime" }).run();
    new TaskRunStore(db).createRun({ id: taskRunId, taskId, reason: "initial", inputSnapshot: {}, runnerType: "codex", runnerContextId: contextId });
    db.update(taskRuns).set({ materialized_prompt: "Original Task prompt" }).where(eq(taskRuns.id, taskRunId)).run();
    const invocationId = "task-invocation";
    invocations.store.register({
      id: invocationId, runnerKind: "task", actorUserId: scope.ownerUserId, runnerContextId: contextId,
      sessionId: null, taskId, taskRunId, originId: taskRunId, contextPackIds: [], agentConfig,
      inputSnapshot: encodeInvocation("task", { taskId, taskRunId, runnerContextId: contextId }),
    });
    const expired = tokens.issueToken({
      userId: scope.ownerUserId, name: "Old Task token", source: "runner", role: "runner", runnerKind: "task",
      sourceRunnerJobId: contextId, sourceTaskId: taskId, sourceTaskRunId: taskRunId,
      metadata: { invocationId }, ttlMs: 60000, now: Date.now() - 120000,
    });
    invocations.store.bindToken(invocationId, expired.record.id);
    const taskJob: JobRequest = {
      version: 2, ...jobScope(invocationId), jobId: "task-job", invocationId, environmentId: "luna", runnerContextId: contextId,
      scopeKey: "task:" + taskId + ":codex", runnerKind: "task", taskId, taskRunId,
      input: { runnerType: "codex", prompt: "Original Task prompt" }, credentialsRevision: 1, timeoutMs: 60000,
    };
    invocations.store.createJob("runtime", taskJob);
    scheduler.submit(taskJob);
    const reserved = scheduler.jobs.reserve(taskJob.jobId, "worker");
    const assignment = {
      scope:taskJob.scope,
      jobId: taskJob.jobId, assignmentId: reserved.assignmentId!, workerId: "worker", instanceId: "executor",
      executionEnvironmentId: "environment", reservationId: "reservation", contextId,
      scopeKey: taskJob.scopeKey, requestHash: reserved.requestHash,
    };
    scheduler.jobs.bind(taskJob.jobId, assignment);
    const executor = new ExecutorStore(runtimeDb, assignment.instanceId);
    executor.register(assignment);
    executor.submit({ job: taskJob, assignment });
    executor.transition(taskJob.jobId, "starting");
    executor.transition(taskJob.jobId, "running");
    executor.output(taskJob.jobId, { status: "init", sessionId: "provider-session" });
    const savedProgress = "Checked the build; waiting for the next result.";
    executor.output(taskJob.jobId, { status: "stream", text: savedProgress });
    const publish = () => scheduler.events.ingest(taskJob.jobId, assignment.instanceId, {
      version: 1, assignmentId: assignment.assignmentId, instanceId: assignment.instanceId,
      streamId: executor.snapshot(taskJob.jobId).streamId, events: executor.takeLiveEvents().get(taskJob.jobId),
    });
    publish();
    for (const event of scheduler.events.list(taskJob.jobId)) invocations.store.consume(event, () => {});
    db.insert(timelineEvents).values({id: "saved-progress", task_id: taskId, type: "runner.step",
      summary: savedProgress, data: {taskRunId, publicProgress: true}, visibility: "full", created_at: Date.now()}).run();
    const priorCursor = invocations.store.job(taskJob.jobId)!.cursor;
    let reissuedToken: string | undefined;
    await stop();
    await start();
    const reattachDeadline = Date.now() + 15000;
    while (!reissuedToken && Date.now() < reattachDeadline) {
      const credentialFile = join(root, "credentials", `job_${contentHash("task-job")}.json`);
      // Credentials are persisted by the embedded scheduler in the child process.
      try { reissuedToken = Credentials.parse(JSON.parse(await Bun.file(credentialFile).text())).env.LUNA_ACCESS_TOKEN; } catch {}
      if (db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).get()?.status !== "running") break;
      await delay(100);
    }
    const resumed = db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).get()!;
    expect(resumed.status, resumed.error ?? "Task remains active").toBe("running");
    expect(Boolean(reissuedToken && reissuedToken !== expired.token)).toBe(true);
    expect(tokens.verifyBearer(reissuedToken!, { now: Date.now() }).claims).toMatchObject({
      actorUserId: scope.ownerUserId, runnerKind: "task", taskId, taskRunId, runnerJobId: contextId,
    });
    expect(invocations.store.job(taskJob.jobId)!.cursor).toBeGreaterThanOrEqual(priorCursor);
    const report = () => fetch(url + "/api/runner/task-reports", {
      method: "POST",
      headers: { Authorization: "Bearer " + reissuedToken, "Content-Type": "application/json", "Idempotency-Key": "final" },
      body: JSON.stringify({ content: "Recovered Task report" }),
    });
    const firstReport = await report();
    expect(firstReport.status).toBe(200);
    expect(await (await report()).json()).toEqual(await firstReport.json());
    executor.output(taskJob.jobId, { status: "success", result: "LUNA_NOTHING_TO_SEND" });
    executor.transition(taskJob.jobId, "succeeded");
    scheduler.events.observe(taskJob.jobId, executor.snapshot(taskJob.jobId));
    const completionDeadline = Date.now() + 15000;
    while (invocations.store.job(taskJob.jobId)?.state !== "settled" && Date.now() < completionDeadline) await delay(100);
    const persistedReport = taskReportForRun(db, taskRunId);
    expect(persistedReport?.content).toBe("Recovered Task report");
    expect(db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).get()).toMatchObject({
      status: "completed", final_report_artifact_id: persistedReport?.reportArtifactId,
    });
    expect(invocations.store.jobsFor(invocationId)).toHaveLength(1);
    expect(invocations.store.job(taskJob.jobId)).toMatchObject({ state: "settled" });
    expect(scheduler.jobs.require(taskJob.jobId).assignmentId).toBe(assignment.assignmentId);
    expect(db.select().from(timelineEvents).where(eq(timelineEvents.summary, savedProgress)).all()).toHaveLength(1);

  } finally {
    await stop();
    sqlite?.close();
    scheduler.stop();
    runtimeDb.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
