import {fixtureJobScope} from "../helpers/job-scope";
import {fixtureRunnerContext} from "../helpers/platform-fixtures";
import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import {fixtureSessionOwnership} from "../helpers/platform-fixtures";
import {fixtureScope} from "../helpers/platform-fixtures";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { contentHash, openExecutionDatabase } from "@luna/execution-store";
import { closeExecutionServer, ExecutionClient, TokenAuthority } from "@luna/execution-transport";
import { ActiveAgentConfigService } from "../../src/agent-config/active-agent-config-service";
import { AgentSecretCipher } from "../../src/agent-config/secret-cipher";
import { runnerContextOrigins, runnerContexts, runnerInvocations, sessionInbox, sessions, sessionTriggers, sessionTurns, taskRuns, tasks, users } from "../../src/data/schema";
import { createAgentRunnerForConfig } from "../../src/kernel/agents/factory";
import { MainRunner } from "../../src/main-runner/main-runner";
import { taskResultArtifactRefs } from "../../src/main-runner/task-result-artifacts";
import { TaskResultEventPublisher } from "../../src/main-runner/task-result-events";
import { runnerAnswers } from "../../src/messaging/runner-answer";
import { sessionCommandsFor } from "../../src/messaging/session-command-service";
import { taskResultMessageOrigin } from "../../src/runners/main-invocation-registry";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { RuntimeAgentTransport, RuntimeDetachedError } from "../../src/runners/runtime-agent-transport";
import { defaultLunaHome, loadDefaultLunaEnv } from "@luna/host-runtime/env";
import { RuntimeConfig } from "../../src/runtime/config";
import { RuntimeFiles } from "../../src/runtime/files";
import { Runtime } from "../../src/runtime/runtime";
import { RuntimeScheduler } from "../../src/runtime/scheduler";
import { runtimeServer } from "../../src/runtime/server";
import { signedArtifactContentUrl } from "../../src/server/artifact-content-url";
import { createDashboardAuthMiddleware, DashboardAuthService } from "../../src/server/auth";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { createArtifactsRoutes } from "../../src/server/routes/artifacts";
import { createRunnerMessageRoutes } from "../../src/server/routes/runner-messages";
import { createTaskReportRoutes } from "../../src/server/routes/task-reports";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { SessionQueue } from "../../src/sessions/session-queue";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionTimelineStore } from "../../src/sessions/session-timeline-store";
import { config, DEFAULT_SESSION_CONFIG, setLunaHome } from "../../src/shared";
import { TaskReportService } from "../../src/tasks/task-report-service";
import { taskReportForRun } from "../../src/tasks/task-report-store";
import { TaskRunSupervisor } from "../../src/tasks/task-run-supervisor";
import { TaskSubscriptionStore } from "../../src/tasks/task-subscription-store";
import { SessionTurnProcessor } from "../../src/sessions/inbound/session-inbound-router";
import { WorkRunner } from "../../src/work/work-runner";
import { WorkerConfig } from "@luna/worker/config";
import { DockerEnvironmentDriver } from "@luna/worker/docker-driver";
import { EnvironmentManager } from "@luna/worker/environment-manager";
import { EnvironmentStore } from "@luna/worker/environment-store";
import { workerServer } from "@luna/worker/server";

// Real provider + Docker, with local-only delivery; no external channel is contacted.
test.skipIf(process.env.LUNA_PROVIDER_INTEGRATION !== "1")("Real Service transport recovery and Main/Work/Task business execution in both container modes", async () => {
  loadDefaultLunaEnv();
  const agentId = process.env.LUNA_PROVIDER_AGENT_ID;
  if (!agentId) throw new Error("LUNA_PROVIDER_AGENT_ID is required for scoped provider testing");
  const source = new Database(join(defaultLunaHome(), "data/luna.db"), { readonly: true });
  const profile = new ActiveAgentConfigService(drizzle(source), AgentSecretCipher.tryFromEnvironment()).resolveExecutionSnapshot(agentId); source.close();
  const previousHome = config.paths.home;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-service-transport-")));
  setLunaHome(join(root, "service"));
  mkdirSync(join(config.paths.home, ".runner-skills"), { recursive: true }); mkdirSync(join(config.paths.home, ".runner-bin"));
  writeFileSync(join(config.paths.home, ".runner-bin/luna"), '#!/bin/sh\nexec bun /app/luna-cli/cli.js "$@"\n', { mode: 0o755 });
  const serviceFile = join(root, "service/service.sqlite");
  let serviceDb = new Database(serviceFile); let db = drizzle(serviceDb); migrate(db, { migrationsFolder: "src/data/drizzle" });
  db.insert(sessions).values({ id: "session", channel_type: "test", channel_id: "test", created_at: 0, updated_at: 0 , ...fixtureSessionOwnership(db,"test","test","user")}).run();
  const runtimeDb = openExecutionDatabase(join(root, "runtime/state.sqlite")); const workerDb = openExecutionDatabase(join(root, "worker/state.sqlite"));
  const suffix = contentHash(root).slice(0, 12), workerId = `transport_${suffix}`;
  const image = execFileSync("docker", ["image", "inspect", process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:latest", "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
  const authority = new TokenAuthority(runtimeDb); const serviceToken = authority.issue("service", { role: "service", id: "service" }); const adminToken = authority.issue("admin", { role: "runtime", id: "runtime" });
  const scheduler = new RuntimeScheduler(runtimeDb, RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", dataRoot: join(root, "runtime"), serviceToken, adminToken, homeWorkerId: workerId,  mode: "shared", resources: { memory: "2g", cpus: 2, pidsLimit: 256 } }), authority);
  const runtime = runtimeServer(authority, scheduler);
  await new Promise<void>(resolve => runtime.listen(0, "0.0.0.0", resolve));
  const endpoint = `http://127.0.0.1:${(runtime.address() as { port: number }).port}`;
  const workerAuthority = new TokenAuthority(workerDb); const workerToken = workerAuthority.issue("runtime", { role: "runtime", id: "runtime" });
  const workerConfig = WorkerConfig.parse({ workerId, runtimeId: "runtime", dataRoot: join(root, "worker"), runtimeEndpoint: endpoint.replace("127.0.0.1", "host.docker.internal"), controlToken: workerToken, imageDigest: image, network: `luna-transport-${suffix}`, executorPortStart: 43200, executorPortEnd: 43210 });
  const driver = new DockerEnvironmentDriver(workerDb, workerConfig), environments = new EnvironmentStore(workerDb);
  const worker = workerServer(workerAuthority, new EnvironmentManager(environments, driver));
  let transport = new RuntimeAgentTransport(db, new Runtime(scheduler, new RuntimeFiles(scheduler)));
  let taskKernel: typeof import("../../src/kernel").kernel | undefined;
  let tick: ReturnType<typeof setInterval> | undefined; let inFlight: Promise<void> | undefined;
  try {
    await driver.preflight(); await new Promise<void>(resolve => worker.listen(0, "127.0.0.1", resolve));
    const admin = new ExecutionClient(endpoint, adminToken);
    await admin.call("POST", "/v1/workers", { workerId, endpoint: `http://127.0.0.1:${(worker.address() as { port: number }).port}`, controlToken: workerToken, executorHost: "127.0.0.1", executorPortStart: 43200, executorPortEnd: 43210 });
    await scheduler.workers.poll();
    tick = setInterval(() => { if (!inFlight) inFlight = scheduler.workers.poll().then(() => scheduler.tick()).finally(() => { inFlight = undefined; }); }, 100);
    for (const mode of ["shared", "isolated"] as const) {
      if (scheduler.config.mode !== mode) {
        await admin.call("POST", "/v1/mode/drain");
        const drainDeadline = Date.now() + 15000;
        const unreleased = () => scheduler.jobs.list().filter(job => job.placementState !== "terminal" ||
          (job.assignment && !runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(job.jobId)));
        while (unreleased().length && Date.now() < drainDeadline) await new Promise(resolve => setTimeout(resolve, 100));
        expect(unreleased().map(job => ({ id: job.jobId, state: job.placementState })), "all Main/Work/Task jobs release before changing mode").toEqual([]);
        await admin.call("PUT", "/v1/mode", { mode }); await admin.call("POST", "/v1/mode/resume");
      }
      const contextId = "context", invocationId = `inv-${mode}`;
      const localRoot = join(root, contextId); mkdirSync(localRoot, { recursive: true }); writeFileSync(join(localRoot, "AGENTS.md"), "Transport integration. Follow the user request.\n");
      db.insert(runnerContexts).values(fixtureRunnerContext(db, { id: contextId, owner_type: "session", owner_id: "session", runner_type: profile.agentType, runner_root_path: localRoot, created_at: 0, updated_at: 0 })).onConflictDoNothing().run();
      db.insert(runnerContextOrigins).values({ contextId, runtimeId: "runtime" }).onConflictDoNothing().run();
      transport.store.register({ id: invocationId, runnerKind: "work", actorUserId: "user:user", runnerContextId: contextId, sessionId: "session", taskId: null, taskRunId: null, originId: invocationId, inputSnapshot: { version: 1, input: {} }, contextPackIds: [] });
      const issued = new AccessTokenService({ db, signingSecret: "transport-test-only" }).issueToken({ userId: "user:user", name: "transport", source: "runner", role: "runner", runnerKind: "work", sourceRunnerJobId: contextId, sourceSessionId: "session", metadata: { invocationId }, ttlMs: 86400000, now: Date.now() });
      transport.store.bindToken(invocationId, issued.record.id);
      const marker = `TRANSPORT_${crypto.randomUUID().replaceAll("-", "")}`;
      let text = "", providerSession: string | undefined;
      const stream = () => transport.stream({ id: invocationId, role: "user", session_id: "session", content: [{ type: "text", text: `Run sleep 3 using the shell, then reply only ${marker}. Do not read files or use other tools.` }] }, { cwd: localRoot, runnerContextId: contextId, isNewSession: true, signal: AbortSignal.timeout(120000), env: { ...profile.env, LUNA_INVOCATION_ID: invocationId, LUNA_ACCESS_TOKEN: issued.token } }, profile.agentType, profile.model, { onSessionId: id => { providerSession = id; } });
      const firstAttempt = stream();
      const first = await firstAttempt.next();
      expect(first.done).toBe(false); expect(first.value?.role).toBe("system");
      const originalJob = transport.store.require(invocationId).activeJobId!;
      const originalCursor = transport.store.job(originalJob)!.cursor;
      expect(scheduler.jobs.require(originalJob).placementState).not.toBe("terminal");
      await transport.detach();
      await expect(firstAttempt.next()).rejects.toBeInstanceOf(RuntimeDetachedError);
      expect(scheduler.jobs.require(originalJob).cancelRequested).toBe(false);
      expect(transport.store.require(invocationId).state).toBe("active");
      serviceDb.close(); serviceDb = new Database(serviceFile); db = drizzle(serviceDb);
      if (mode === "isolated") {
        // No Service subscriber: let the real Runner finish and retain its events.
        const offlineDeadline = Date.now() + 90000;
        while (scheduler.jobs.require(originalJob).placementState !== "terminal" && Date.now() < offlineDeadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(scheduler.jobs.require(originalJob).placementState).toBe("terminal");
        expect(scheduler.jobs.require(originalJob).cancelRequested).toBe(false);
      }
      transport = new RuntimeAgentTransport(db, new Runtime(scheduler, new RuntimeFiles(scheduler)));
      expect(transport.store.job(originalJob)!.cursor).toBe(originalCursor);
      expect(transport.store.require(invocationId).activeJobId).toBe(originalJob);
      for await (const message of stream()) {
        if (message.role === "assistant") for (const part of message.content) if (part.type === "text") text += part.text;
      }
      expect(text.includes(marker), `${mode} provider result reaches Service`).toBe(true); expect(providerSession).toBeDefined();
      const invocation = transport.store.require(invocationId), job = transport.store.job(invocation.activeJobId!)!;
      expect(job.id).toBe(originalJob); expect(transport.store.jobsFor(invocationId)).toHaveLength(1);
      expect(job.state).toBe("terminal"); expect(job.cursor).toBeGreaterThan(0);
      expect(scheduler.jobs.require(job.id).workerId).toBe(workerId);
      transport.store.finish(invocationId); expect(transport.store.job(job.id)?.state).toBe("settled");
      const releaseDeadline = Date.now() + 15000;
      while (!runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(job.id) && Date.now() < releaseDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(job.id), `${mode} Worker confirms release`).toBeTruthy();
      const prepared = await transport.client.files<{ content: string }>({ operationId: `read-instructions-${mode}`, contextId, scopeKey: `session:${contextId}`, operation: { kind: "read", path: "AGENTS.md" } });
      expect(Buffer.from(prepared.content, "base64").toString()).toBe("Transport integration. Follow the user request.\n");
      db.insert(sessions).values({ id: "main-session", channel_type: "test", channel_id: "main-test", created_at: 0, updated_at: 0 , ...fixtureSessionOwnership(db,"test","main-test")}).onConflictDoNothing().run();
      const contexts = new RunnerContextStore(db);
      const mainContext = contexts.resolveForSession("main-session", profile.agentType);
      const mainId = `main-${mode}`;
      const main = new MainRunner({ serviceAuthDb: db, accessTokenSigningSecret: "transport-test-only", runnerContextStore: contexts,
        resolveAgentExecution: () => ({ snapshot: profile, runner: createAgentRunnerForConfig(profile, transport) }) });
      const completion = await main.run({ invocationId: mainId, runnerContext: mainContext, signal: AbortSignal.timeout(120000), input: {
        type: "session_trigger", triggerId: mainId, instruction: "This trigger requires no user-visible reply, task, or other action. Do not call any tools. End with only LUNA_NOTHING_TO_SEND.", requesterUserId: "user:user", sourceSessionId: "main-session", correlationId: mainId, hops: 0, artifactRefs: [], context: { sessionId: "main-session", candidateOpenTasks: [] },
      } });
      expect(completion).toEqual({ status: "completed", followupReleased: false });
      const mainInvocation = transport.store.require(mainId);
      expect(mainInvocation.runnerKind).toBe("main");
      const mainJob = transport.store.job(mainInvocation.activeJobId!)!;
      expect(mainJob.state).toBe("terminal"); expect(mainJob.request.runnerKind).toBe("main");
      expect(contexts.resolveForSession("main-session", profile.agentType).runner_session_id).toBeTruthy();
      transport.store.finish(mainId);
      const mainReleaseDeadline = Date.now() + 15000;
      while (!runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(mainJob.id) && Date.now() < mainReleaseDeadline) await new Promise(resolve => setTimeout(resolve, 100));
      expect(runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(mainJob.id)).toBeTruthy();
      const channel = new FakeFeishuChannel("luna-dashboard");
      const channelFor = () => channel;
      const requests: { method: string; path: string; status: number }[] = [];
      const app = new Hono();
      app.use("*", async (c, next) => { await next(); requests.push({ method: c.req.method, path: c.req.path, status: c.res.status }); });
      app.use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db }));
      app.route("/api/runner", createRunnerMessageRoutes({ db, channelFor }));
      app.route("/api/artifacts", createArtifactsRoutes({ db }));
      const publishedReports: string[] = [];
      const pendingPublications: Promise<void>[] = [];
      const publisher = new TaskResultEventPublisher({ db, runnerType: profile.agentType, channelForSubscription: channelFor,
        mainRunner: { run: input => {
          if (input.input.type === "task_result") {
            const refs = input.input.result.artifactRefs ?? [];
            expect(refs).toHaveLength(1);
            expect(refs[0]).not.toBe(`artifact:${input.input.result.artifactIds[0]}`);
          }
          return main.run({ ...input, signal: AbortSignal.timeout(120000) });
        } } });
      app.route("/api/runner/task-reports", createTaskReportRoutes(new TaskReportService(db, async result => { publishedReports.push(result.taskRunId); const pending = publisher.publish(result); pendingPublications.push(pending); await pending; })));
      const service = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: app.fetch });
      const oldSecret = process.env.LUNA_ACCESS_TOKEN_SECRET, oldUrl = process.env.LUNA_SERVICE_URL;
      process.env.LUNA_ACCESS_TOKEN_SECRET = "transport-test-only";
      process.env.LUNA_SERVICE_URL = `http://host.docker.internal:${service.port}`;
      const commands = sessionCommandsFor(db, channelFor);
      commands.start();
      try {
        const sessionStore = new SessionStore(db);
        const created = sessionStore.createLocalSession("user:user",fixtureScope(db,"user"));
        db.update(sessions).set({ kind: "work" }).where(eq(sessions.id, created.id)).run();
        const workSession = sessionStore.getById(created.id)!;
        const answer = `WORK_${crypto.randomUUID().replaceAll("-", "")}`;
        const message = new MessageStore(db).append({ sessionId: workSession.id, senderUserId: "user:user", role: "user",
          content: [{ type: "text", text: `Send exactly ${answer} to this session using luna say --text ${answer} --purpose answer. Use the shell command bun /app/luna-cli/cli.js say if luna is not on PATH. Do not read files or do any other work.` }] });
        const entry = new SessionTimelineStore(db).appendMessage({ sessionId: workSession.id, messageId: message.id });
        const inbox = new SessionInboxStore(db).enqueueOnce({ sessionId: workSession.id, entryId: entry.id, message });
        const work = new WorkRunner({ db, runnerType: profile.agentType, channelForMessage: channelFor, createRunner: () => {
          const runner = createAgentRunnerForConfig(profile, transport);
          return { type: runner.type, stream: (message, options) => runner.stream(message, { ...options, env: { ...profile.env, ...options.env } }) };
        } });
        const processor = new SessionTurnProcessor({ db, runnerType: profile.agentType, channelForMessage: channelFor, workRunner: work, mainRunner: main });
        const queue = new SessionQueue({ db, config: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 1, coalesce_max_wait_ms: 25 }, executeTurn: (input, signal) => processor.execute(input, signal) });
        const workWatchdog = setTimeout(() => queue.abort(workSession.id), 120000);
        try { queue.schedule(workSession.id); await queue.waitForIdle(); } finally { clearTimeout(workWatchdog); await queue.stop(); }
        const turns = db.select().from(sessionTurns).where(eq(sessionTurns.session_id, workSession.id)).all();
        expect(turns).toHaveLength(1);
        const turn = turns[0]!;
        expect(turn.status, turn.error ?? "Work turn completes").toBe("completed");
        expect(db.select().from(sessionInbox).where(eq(sessionInbox.id, inbox.row.id)).get()?.status).toBe("completed");
        const answers = runnerAnswers(db, workSession.id, turn.id);
        expect(answers, JSON.stringify(answers.map(row => ({ id: row.id, dedupeKey: row.dedupeKey, status: row.status, contentHash: contentHash(row.payload.content) })))).toHaveLength(1);
        expect(answers[0]!.payload.content).toBe(answer);
        expect(answers[0]!.status).toBe("sent");
        expect(channel.outbound.at(-1)?.statusCard?.status).toBe("completed");
        const workInvocation = db.select().from(runnerInvocations).where(eq(runnerInvocations.originId, turn.id)).get()!;
        expect(workInvocation).toBeDefined(); expect(workInvocation.state).toBe("settled"); expect(workInvocation.settledAt).not.toBeNull();
        const workJob = transport.store.job(workInvocation.activeJobId!)!;
        expect(workJob.request.runnerKind).toBe("work"); expect(workJob.state).toBe("settled");

        const workDeadline = Date.now() + 15000;
        while (!runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(workJob.id) && Date.now() < workDeadline) await new Promise(resolve => setTimeout(resolve, 100));
        expect(runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(workJob.id)).toBeTruthy();
        const taskId = `task-${mode}`;
        const reportText = `REPORT_${crypto.randomUUID().replaceAll("-", "")}`;
        db.insert(tasks).values({ id: taskId, type: "execution", title: "Runtime report integration", status: "running", creator_user_id: "user:user", primary_session_id: workSession.id,
          context_json: { requestedByIdentity: { provider: "local", externalUserId: "user:user" } }, created_at: 0, updated_at: 0, last_activity_at: 0 , ...fixtureTaskOwnership(db,workSession.id)}).run();
        new TaskSubscriptionStore(db).resolve({ taskId, sessionId: workSession.id, channelType: "dashboard", channelId: "luna-dashboard", visibility: "full" });
        // Bind the production Task entrypoint to this fixture's real execution services.
        taskKernel ??= (await import("../../src/kernel")).kernel;
        const bindings = ["resolveAgentExecutionSnapshot", "runtimeAgentTransport"] as const;
        const descriptors = bindings.map(key => Object.getOwnPropertyDescriptor(taskKernel!, key));
        Object.defineProperties(taskKernel, {
          resolveAgentExecutionSnapshot: { configurable: true, value: () => profile },
          runtimeAgentTransport: { configurable: true, get: () => transport },
        });
        try {
          const supervisor = new TaskRunSupervisor({ db, runnerType: profile.agentType });
          const run = supervisor.startInitialRun({ taskId, inputSnapshot: { pendingText: `Submit exactly ${reportText} using bun /app/luna-cli/cli.js tasks report --request-id report-${mode} --text ${reportText}. Repeat the same command with the same request ID once to verify the receipt. Then end with only LUNA_NOTHING_TO_SEND. Do not read files or perform other work.` } });
          const taskRunId = run.id;
          const watchdog = setTimeout(() => { void supervisor.abortAndWait("Integration timeout"); }, 120000);
          try { await supervisor.waitForIdle(); } finally { clearTimeout(watchdog); }
          await Promise.all(pendingPublications);
          const completedRun = db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).get()!;
          expect(completedRun.status, completedRun.error ?? "Task Run completes").toBe("completed");
          expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe("completed");
          const report = taskReportForRun(db, taskRunId)!;
          expect(report.content).toBe(reportText); expect(completedRun.final_report_artifact_id).toBe(report.reportArtifactId);
          expect(publishedReports).toEqual([taskRunId]);
          const triggers = db.select().from(sessionTriggers).where(eq(sessionTriggers.sessionId, workSession.id)).all();
          expect(triggers.filter(row => row.kind === "task_result")).toHaveLength(1);
          expect(triggers.find(row => row.kind === "task_result")?.status).toBe("completed");
          const reportOrigin = taskResultMessageOrigin(taskRunId, workSession.id);
          const reportAnswers = runnerAnswers(db, workSession.id, reportOrigin);
          expect(reportAnswers).toHaveLength(1); expect(reportAnswers[0]!.status).toBe("sent");
          const reportRefs = taskResultArtifactRefs(db, taskId, [report.reportArtifactId]);
          expect(reportRefs).toHaveLength(1);
          const managedReportId = reportRefs[0]!.slice("artifact:".length);
          const downloaded = await fetch(`http://127.0.0.1:${service.port}${signedArtifactContentUrl({ artifactId: managedReportId, now: Date.now() })}`);
          expect(downloaded.status).toBe(200);
          expect(await downloaded.text()).toBe(reportText);
          const delivered = reportAnswers[0]!.payload.content;
          expect(typeof delivered === "string" && (delivered.includes(reportText) || delivered.includes(reportRefs[0]!)),
            "answer delivers the exact report text or its verified downloadable artifact: " + JSON.stringify(delivered)).toBe(true);
          expect(requests.filter(row => row.path.startsWith("/api/artifacts/") && row.path.endsWith("/content") && row.status !== 200)).toEqual([]);
          const reportInvocation = db.select().from(runnerInvocations).where(eq(runnerInvocations.originId, reportOrigin)).get()!;
          expect(reportInvocation.runnerKind).toBe("main"); expect(reportInvocation.state).toBe("settled");
          expect(triggers.filter(row => row.kind === "user_messages")).toHaveLength(1);
          expect(triggers.find(row => row.kind === "user_messages")?.status).toBe("completed");
          expect(db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).get()?.final_report_artifact_id).toBe(report.reportArtifactId);
          const invocation = db.select().from(runnerInvocations).where(eq(runnerInvocations.taskRunId, taskRunId)).get()!;
          expect(invocation.state).toBe("settled"); expect(invocation.settledAt).not.toBeNull();
          const taskJob = transport.store.job(invocation.activeJobId!)!;
          expect(taskJob.request.runnerKind).toBe("task"); expect(taskJob.state).toBe("settled");

          const deadline = Date.now() + 15000;
          while (!runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(taskJob.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
          expect(runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(taskJob.id)).toBeTruthy();
        } finally {
          bindings.forEach((key, index) => { const descriptor = descriptors[index]; if (descriptor) Object.defineProperty(taskKernel!, key, descriptor); else Reflect.deleteProperty(taskKernel!, key); });
        }

      } finally {
        await Promise.allSettled(pendingPublications); await commands.stop(); service.stop(true);
        console.log(JSON.stringify({ mode, requests,
          commandEvidence: serviceDb.query("SELECT kind,origin_id,dedupe_key,status,json_extract(payload, '$.purpose') AS purpose FROM session_commands").all(),
          invocationEvidence: serviceDb.query("SELECT runner_kind,origin_id,active_job_id,state FROM runner_invocations").all(),
          attemptEvidence: runtimeDb.query("SELECT job_id,json_extract(body,'$.event.data.retry.attempt') AS attempts,json_extract(body,'$.event.data.retry.totalRetries') AS retries FROM runtime_events WHERE json_extract(body,'$.event.kind')='terminal'").all() }));
        if (oldSecret === undefined) delete process.env.LUNA_ACCESS_TOKEN_SECRET; else process.env.LUNA_ACCESS_TOKEN_SECRET = oldSecret;
        if (oldUrl === undefined) delete process.env.LUNA_SERVICE_URL; else process.env.LUNA_SERVICE_URL = oldUrl;
      }

    }
    console.log(JSON.stringify({ provider: profile.agentType, modes: ["shared", "isolated"], serviceTransport: true, reopenedServiceLedger: true, mainRunnerSilentTrigger: true, workRunnerHttpAnswer: true, taskRunnerHttpReport: true, taskSupervisorSettlement: true, workQueueSettlement: true, mainConsumesTaskReport: true, image }));
  } finally {
    clearInterval(tick); await inFlight; await transport.detach(); scheduler.stop(); await closeExecutionServer(runtime); if (worker.listening) await closeExecutionServer(worker);
    for (const environment of environments.list()) { await driver.remove(environment); execFileSync("docker", ["volume", "rm", `luna-${contentHash(workerId).slice(0, 12)}-${environment.id}`], { stdio: "ignore" }); }
    for (const args of [["volume", "rm", `luna-${contentHash(workerId).slice(0, 12)}-contexts`], ["network", "rm", workerConfig.network]]) { try { execFileSync("docker", args, { stdio: "ignore" }); } catch {} }
    taskKernel?.database.close(); runtimeDb.close(); workerDb.close(); serviceDb.close(); setLunaHome(previousHome); rmSync(root, { recursive: true, force: true });
  }
}, 480000);
