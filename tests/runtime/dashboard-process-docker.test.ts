import { AgentWorkerAccessStore } from "@/agents/agent-worker-access-store";
import { fixtureNamedSession, fixtureRunnerContext, fixtureScope } from "../helpers/platform-fixtures";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { contentHash, writePrivateJson } from "@luna/execution-store";
import { ExecutionClient } from "@luna/execution-transport";
import { AgentStore } from "../../src/agents/agent-store";
import { runnerContexts, sessionSchedules } from "../../src/data/schema";
import { AgentProfileStore } from "../../src/agent-config/agent-profile-store";
import { AgentSecretCipher } from "../../src/agent-config/secret-cipher";
import { ActiveAgentConfigService } from "../../src/agent-config/active-agent-config-service";
import { RuntimeConfig } from "../../src/runtime/config";
import { WorkerBindingConfig, WorkerLocalConfig } from "@luna/worker/config";
import type { ScheduledJob } from "../../src/runtime/scheduler-store";

const docker = (...args: string[]) => execFileSync("docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

test.skipIf(process.env.LUNA_DASHBOARD_DOCKER !== "1")("Built local Service reattaches Dashboard Jobs in separate Shadow containers", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-dashboard-docker-")));
  const suffix = contentHash(root).slice(0, 12);
  const workerId = "dashboard_" + suffix;
  const network = "luna-dashboard-" + suffix;
  const imageTag = "luna-dashboard-fixture:" + suffix;
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const workerLabel = "label=luna.worker=" + workerId;
  const token = () => randomBytes(32).toString("base64url");
  const serviceToken = token(), adminToken = token(), workerToken = token(), dashboardToken = token();
  const accessSecret = token(), dashboardSessionSecret = token();
  const masterKey = randomBytes(32).toString("base64");
  const runtimePort = await unusedPort(), workerPort = await unusedPort(), servicePort = await unusedPort();
  const runtimeUrl = "http://127.0.0.1:" + runtimePort;
  const workerUrl = "http://127.0.0.1:" + workerPort;
  const dashboard = "http://127.0.0.1:" + servicePort;
  const runtimeFile = join(root, "runtime.json"), workerFile = join(root, "worker.json");
  // Service runs from a private copy of the build so the test can change a platform asset while Jobs run:
  // rewriting this bundled skill is what gives later invocations a different resource snapshot.
  const repoRoot = join(import.meta.dir, "../.."), appRoot = join(root, "app");
  const stampFile = join(appRoot, "skills", "snapshot-stamp", "SKILL.md");
  const stampPath = (resources: string) => join(resources, "skills", "skills", "snapshot-stamp", "SKILL.md");
  mkdirSync(join(appRoot, "dist"), {recursive: true});
  cpSync(join(repoRoot, "dist", "luna-service.js"), join(appRoot, "dist", "luna-service.js"));
  cpSync(join(repoRoot, "skills"), join(appRoot, "skills"), {recursive: true});
  for (const entry of ["src", "apps", "packages", "extensions", "node_modules", "package.json"]) symlinkSync(join(repoRoot, entry), join(appRoot, entry));
  mkdirSync(join(appRoot, "skills", "snapshot-stamp"));
  writeFileSync(stampFile, "Initial platform skill.");
  let runtimeDb: Database | undefined;
  const queryJob = (id: string): ScheduledJob | undefined => {
    const row = runtimeDb!.query("SELECT record_json FROM scheduled_jobs WHERE job_id=?").get(id) as { record_json: string } | null;
    // Service persists the invocation before Runtime has accepted its Job.
    return row ? JSON.parse(row.record_json) : undefined;
  };
  const admin = new ExecutionClient(runtimeUrl, adminToken);
  const worker = new ExecutionClient(workerUrl, workerToken);
  const start = async (kind: "service" | "worker", args: string[], ready: () => Promise<unknown>) => {
    const log = join(root, kind + ".log");
    const child = Bun.spawn([process.execPath, kind === "service" ? join(appRoot, "dist", "luna-service.js") : join(import.meta.dir, "../../dist/luna-worker.js"), "start", ...args], {
      env: { PATH: process.env.PATH, LUNA_HOME: root, LUNA_DASHBOARD_TOKEN: dashboardToken,
        LUNA_ACCESS_TOKEN_SECRET: accessSecret, LUNA_DASHBOARD_SESSION_SECRET: dashboardSessionSecret, LUNA_AGENT_CONFIG_MASTER_KEY: masterKey,
        LUNA_SERVICE_URL: "http://host.docker.internal:" + servicePort },
      stdout: Bun.file(log), stderr: Bun.file(join(root, kind + "-error.log")),
    });
    children.push(child);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { await ready(); return child; } catch { await delay(100); }
    }
    throw new Error(kind + " did not start: " + await Bun.file(join(root, kind + "-error.log")).text());
  };
  let sqlite: Database | undefined;
  let fixtureBuilt = false;
  const startService = () => start("service", ["--foreground", "--home", root, "--runtime-dir", join(root, "run"), "--host", "0.0.0.0", "--port", String(servicePort)], async () => {
    const health = await fetch(dashboard + "/api/health", { signal: AbortSignal.timeout(500) });
    if (!health.ok || !(await Bun.file(join(root, "service.log")).text()).includes('"service":"luna-agent-runtime"')) throw Error("Booting");
  });
  try {
    writeFileSync(join(root, "Dockerfile"), "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY job-main.js /app/agent-runner/dist/job-main.js\n");
    writeFileSync(join(root, "job-main.js"), String.raw`
const input = JSON.parse(await Bun.stdin.text());
const emit = value => console.log('---LUNA_OUTPUT_START---\n'+JSON.stringify(value)+'\n---LUNA_OUTPUT_END---');
emit({status:'init',sessionId:'dashboard-test-provider'});
const fs = require('node:fs');
const env = {...process.env,...input.env};
if (env.LUNA_RUNNER_KIND === 'task') {
  if (env.OPENAI_API_KEY !== 'independent-fixture-key') throw Error('Task received the wrong Agent credential');
  fs.writeFileSync('sdd-task-context', process.cwd());
  const report = Bun.spawn(['bun','/app/luna-cli/cli.js','task','report','--request-id','fixture-report','--text','Docker Shadow task report'], {env, stdout:'ignore', stderr:'ignore'});
  if (await report.exited !== 0) throw Error('Fixture Task report failed');
  emit({status:'success',result:'LUNA_NOTHING_TO_SEND'});
  process.exit(0);
}
if (input.prompt.includes('Docker Shadow task report')) {
  emit({status:'success',result:'LUNA_NOTHING_TO_SEND'});
  process.exit(0);
}
const marker = input.prompt.match(/DASHBOARD_REFRESH_[a-f0-9]+/)?.[0] ?? input.prompt.match(/DASHBOARD_[a-f0-9]+/)?.[0];
if (!marker) throw Error('Missing dashboard message');
const expectedCredential = input.prompt.includes('SDD_INDEPENDENT_AGENT') ? 'independent-fixture-key' : 'fixture-key';
if (env.OPENAI_API_KEY !== expectedCredential) throw Error('Main received the wrong Agent credential');
fs.writeFileSync(marker + '.pid', String(process.pid));
while (!fs.existsSync(marker + '.release')) await Bun.sleep(50);
if (input.prompt.includes('SDD_CREATE_TASK')) {
  const payload = {title:'SDD Shadow task', summary:'Verify Task shares the Shadow container', facts:['Docker fixture']};
  const created = Bun.spawn(['bun','/app/luna-cli/cli.js','task','create','--json',JSON.stringify(payload),'--request-id',marker], {env, stdout:'ignore', stderr:'ignore'});
  if (await created.exited !== 0) throw Error('Fixture Task creation failed');
}
for (let attempt = 0; attempt < 2; attempt++) {
  const child = Bun.spawn(['bun','/app/luna-cli/cli.js','messages','send','--text',marker,'--request-id',marker,'--purpose','answer'], {
    env: {...process.env,...input.env}, stdout:'pipe', stderr:'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) {
    const token = input.env?.LUNA_ACCESS_TOKEN;
    const detail = token ? (stdout + stderr).replaceAll(token, '[REDACTED]') : stdout + stderr;
    emit({status:'error',error:'Dashboard reply command failed at ' + new URL(input.env.LUNA_SERVICE_URL).origin + ': ' + detail.slice(0, 800)});
    process.exit(1);
  }
}
emit({status:'success',result:'LUNA_NOTHING_TO_SEND'});
`);
    docker("build", "--platform", "linux/amd64", "--build-arg", "BASE_IMAGE=" + (process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:latest"), "-t", imageTag, root);
    fixtureBuilt = true;
    const imageDigest = docker("image", "inspect", imageTag, "--format", "{{.Id}}");
    writePrivateJson(runtimeFile, RuntimeConfig.parse({
      runtimeId: "runtime", serviceId: "service", dataRoot: join(root, "runtime"),
      listenHost: "0.0.0.0", port: runtimePort, homeWorkerId: workerId,
      serviceToken, adminToken, mode: "shared", maxConcurrentJobs: 1, resources: { memory: "1g", cpus: 1, pidsLimit: 128 },
    }));
    writePrivateJson(workerFile, WorkerLocalConfig.parse({
      dataRoot: join(root, "worker"), port: workerPort, network, imageDigest, executorPortStart: 43700, executorPortEnd: 43709,
    }));
    // Connection identity lives next to the local configuration.
    writePrivateJson(join(root, "binding.json"), WorkerBindingConfig.parse({
      workerId, runtimeId: "runtime", serviceUrl: dashboard, controlToken: workerToken,
    }));
    writeFileSync(join(root, "config.yaml"), [
      "sandbox:", "  runtimeConfigFile: " + JSON.stringify(runtimeFile),
      "paths:", "  sharedWorkspaceDir: " + JSON.stringify(join(root, "absent-project")), "",
    ].join("\n"));
    let serviceProcess = await startService();
    runtimeDb = new Database(join(root, "runtime/runtime.sqlite"), {readonly:true});
    await admin.call("POST", "/v1/workers", {
      workerId, endpoint: "http://127.0.0.1:1", controlToken: workerToken, reverse: true,
      executorHost: "127.0.0.1", executorPortStart: 43700, executorPortEnd: 43709,
    });
    const startWorker = () => start("worker", ["--config", workerFile], () => worker.call("GET", "/v1/health", undefined, AbortSignal.timeout(500)));
    const workerProcess = await startWorker();
    const waitForWorker = async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const rows = await admin.call<{workerId: string; lastSeen: number; health?: {ready?: boolean}}[]>("GET", "/v1/workers");
        if (rows.some(row => row.workerId === workerId && row.lastSeen > Date.now() - 30000 && row.health?.ready)) return;
        await delay(100);
      }
      throw new Error("Scoped Worker did not reconnect");
    };
    await waitForWorker();
    sqlite = new Database(join(root, "data/luna.db"));
    const db = drizzle(sqlite);
    const ownerId = "local-dashboard-user";
    const scope = fixtureScope(db, ownerId);
    fixtureNamedSession(db, "previous-session", ownerId);
    const sibling = new AgentStore(db).createShadow(ownerId, scope.agentId, {name: "Dashboard Shadow"}, "sibling");
    const historicalPath = join(root, "old-runner-base", "missing-context");
    db.insert(runnerContexts).values(fixtureRunnerContext(db, { id: "historical", owner_type: "session", owner_id: "previous-session",
      runner_type: "codex", runner_session_id: "previous-provider-session", runner_root_path: historicalPath,
      created_at: 1, updated_at: 1 })).run();
    serviceProcess.kill("SIGKILL");
    await serviceProcess.exited;
    serviceProcess = await startService();
    await waitForWorker();
    expect(existsSync(historicalPath)).toBe(false);
    const cipher = AgentSecretCipher.fromEnvironment({ LUNA_AGENT_CONFIG_MASTER_KEY: masterKey });
    const profiles = new AgentProfileStore(db, cipher, scope.agentId);
    const profile = profiles.createProfile({
      name: "Dashboard fixture", agentType: "codex", model: "gpt-5",
      env: { OPENAI_BASE_URL: "http://127.0.0.1:9" }, secrets: { OPENAI_API_KEY: { set: "fixture-key" } },
    });
    profiles.recordValidation(profile.latestRevision.id, { success: true, message: "fixture" });
    new ActiveAgentConfigService(db, cipher).activate(profiles.agentId, profile.latestRevision.id, ownerId);
    const login = await fetch(dashboard + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: dashboardToken }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const workerAccess = new AgentWorkerAccessStore(db);
    // This fixture uses a locally provisioned Worker with seeded assignments.
    workerAccess.setOwned(ownerId, scope.agentId, workerId, "active");
    const adminCommand = [process.execPath, join(import.meta.dir, "../../dist/luna-service.js"),
      "admin", "grant", "--home", root, "--user-id"];
    const missingUser = Bun.spawnSync([...adminCommand, "missing-user"], {stdout: "pipe", stderr: "pipe"});
    expect(missingUser.exitCode).toBe(1);
    const grant = Bun.spawnSync([...adminCommand, ownerId], {stdout: "pipe", stderr: "pipe"});
    expect(grant.exitCode, grant.stdout.toString()).toBe(0);
    const repeated = Bun.spawnSync([...adminCommand, ownerId], {stdout: "pipe", stderr: "pipe"});
    expect(repeated.stdout.toString()).toBe(grant.stdout.toString());
    const foreignAgent = new AgentStore(db).create(ownerId, {name: "Independent Agent"}, "independent-agent");
    workerAccess.setOwned(ownerId, foreignAgent.id, workerId, "active");
    const foreignProfiles = new AgentProfileStore(db, cipher, foreignAgent.id);
    const foreignProfile = foreignProfiles.createProfile({
      name: "Independent fixture", agentType: "codex", model: "gpt-5",
      env: {OPENAI_BASE_URL: "http://127.0.0.1:9"}, secrets: {OPENAI_API_KEY: {set: "independent-fixture-key"}},
    });
    foreignProfiles.recordValidation(foreignProfile.latestRevision.id, {success: true, message: "fixture"});
    new ActiveAgentConfigService(db, cipher).activate(foreignAgent.id, foreignProfile.latestRevision.id, ownerId);
    const savedMemory = await fetch(`${dashboard}/api/agents/${scope.agentId}/memories`, {
      method: "POST", headers: {cookie, "content-type": "application/json"},
      body: JSON.stringify({type: "feedback", title: "Fixture memory", description: "Shared memory for the Dashboard fixture.", body: "Agent memory lives in Service."}),
    });
    expect(savedMemory.status).toBe(201);
    const homes = new Map<string, string>();
    let selected: {sessionId: string; marker: string; contextId: string} | undefined;
    let queuedOld: {sessionId: string; marker: string; messageId: string; stamp: string} | undefined;
    let waiting: {sessionId: string; marker: string; messageId: string} | undefined;
    let cleanup: {jobId: string; invocationId: string} | undefined;
    const newStamp = "Refreshed platform skill.";
    for (const [variant, shadowId] of [["default", scope.shadowId], ["selected", sibling.id], ["queued-old", sibling.id], ["waiting", sibling.id], ["updated", sibling.id], ["independent", foreignAgent.defaultShadowId], ["cancelled", scope.shadowId], ["agent-stopped", foreignAgent.defaultShadowId]] as const) {
      const agentId = variant === "independent" || variant === "agent-stopped" ? foreignAgent.id : scope.agentId;
      const shadowHome = join(root, "worker", "agents", agentId, "shadows", shadowId);
      let sessionId: string;
      if (variant === "updated") {
        sessionId = selected!.sessionId;
        expect(sqlite.query("SELECT runner_session_id FROM runner_contexts WHERE id=?").get(selected!.contextId))
          .toEqual({runner_session_id: "dashboard-test-provider"});
      } else if (variant === "waiting" || variant === "queued-old") {
        sessionId = (variant === "waiting" ? waiting : queuedOld)!.sessionId;
      } else {
        const created = await fetch(dashboard + "/api/sessions/dashboard", {
          method: "POST", headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({agentId, ...(variant === "selected" ? {shadowId} : {})}),
        });
        expect(created.status).toBe(201);
        ({sessionId} = await created.json() as {sessionId: string});
      }
      const marker = variant === "queued-old" ? queuedOld!.marker : variant === "waiting" ? waiting!.marker
        : (variant === "updated" ? "DASHBOARD_REFRESH_" : "DASHBOARD_") + randomBytes(10).toString("hex");
      const path = dashboard + "/api/sessions/" + sessionId + "/messages";
      const send = () => fetch(path, {
        method: "POST", headers: { cookie, "Content-Type": "application/json", "Idempotency-Key": marker },
        body: JSON.stringify({text: [
          ...(agentId === foreignAgent.id ? ["SDD_INDEPENDENT_AGENT"] : []),
          ...(variant === "independent" ? ["SDD_CREATE_TASK"] : []),
          "Reply with", marker,
        ].join(" ")}),
      });
      let messageId: string;
      if (variant === "waiting" || variant === "queued-old") {
        messageId = (variant === "waiting" ? waiting : queuedOld)!.messageId;
      } else {
        const accepted = await send();
        expect(accepted.status).toBe(202);
        ({messageId} = await accepted.json() as {messageId: string});
      }
      expect(Boolean(messageId)).toBe(true);
      expect(await (await send()).json()).toEqual({ messageId });
      const runnerDeadline = Date.now() + 30000;
      let active: ScheduledJob | undefined;
      let observed: ScheduledJob | undefined;
      let container: string | undefined;
      let runnerPid: string | undefined;
      let releaseFile: string | undefined;
      while (Date.now() < runnerDeadline) {
        if (sqlite.query("SELECT 1 FROM session_inbox WHERE session_id=? AND status='failed'").get(sessionId)) break;
        const pending = sqlite.query("SELECT active_job_id FROM runner_invocations WHERE session_id=? AND state='active' AND active_job_id IS NOT NULL").get(sessionId) as { active_job_id: string | null } | null;
        if (pending?.active_job_id) {
          const job = queryJob(pending.active_job_id);
          observed = job;
          if (job?.execution?.state === "running" && job.assignment) {
            const candidate = docker("ps", "-q", "--filter", "label=luna.instance=" + job.assignment.instanceId);
            const cwd = join(shadowHome, "runners", job.job.runnerContextId);
            if (candidate) {
              try { runnerPid = docker("exec", candidate, "cat", join(cwd, marker + ".pid")); } catch {}
              if (runnerPid) {
                active = job; container = candidate; releaseFile = join(cwd, marker + ".release");
                break;
              }
            }
          }
        }
        await delay(100);
      }
      if (!active || !container || !runnerPid || !releaseFile) {
        const inbox = sqlite.query("SELECT status,error FROM session_inbox WHERE session_id=?").all(sessionId);
        const invocations = sqlite.query("SELECT state,active_job_id FROM runner_invocations WHERE session_id=?").all(sessionId);
        const preparations = runtimeDb.query("SELECT state,error FROM runtime_preparation_intents WHERE json_extract(input_json,'$.scope.shadowId')=?").all(shadowId);
        throw Error(variant + " Runner did not reach the restart gate: " + JSON.stringify({
          state: observed?.execution?.state, placement: observed?.placementState, lastError: observed?.lastError,
          inbox, invocations, preparations,
        }));
      }
      expect(active.job.scope).toMatchObject({agentId, shadowId});
      const resources = join(shadowHome, ".luna-resources");
      // Agent memory is served by Service; no memory file is published into any container.
      expect(docker("exec", container, "sh", "-c", 'test -z "$(find "$1" -type f 2>/dev/null)" && echo empty', "sh", join(resources, "memory"))).toBe("empty");
      if (agentId === foreignAgent.id && variant === "independent") expect(docker("ps", "-q", "--filter", workerLabel).split("\n").filter(Boolean)).toHaveLength(3);
      const privateConfig = join(shadowHome, ".config");
      docker("exec", container, "mkdir", "-p", privateConfig);
      const sentinel = join(privateConfig, "sdd-private-sentinel");
      const workspaceSentinel = join(shadowHome, "runners", active.job.runnerContextId, "sdd-workspace-sentinel");
      docker("exec", container, "sh", "-c", 'printf "%s" "$2" > "$1"', "sh", sentinel, shadowId);
      docker("exec", container, "touch", workspaceSentinel);
      expect(docker("exec", container, "cat", sentinel)).toBe(shadowId);
      const mounts = JSON.parse(docker("inspect", "--format", "{{json .Mounts}}", container)) as {Source: string; Destination: string; RW: boolean}[];
      expect(mounts.some(mount => mount.Destination === shadowHome)).toBe(true);
      expect(mounts.filter(mount => mount.Destination.startsWith(shadowHome + "/")).map(mount => [mount.Destination, mount.RW])).toEqual([[resources, false]]);
      expect(mounts.some(mount => shadowHome.startsWith(mount.Destination + "/") || mount.Destination === "/")).toBe(false);
      expect(docker("ps", "-q", "--filter", workerLabel, "--filter", "label=luna.shadow=" + shadowId)).toBe(container);
      for (const [otherContainer, otherHome] of homes) {
        if (otherHome === shadowHome) continue;
        expect(container).not.toBe(otherContainer);
        expect(docker("exec", container, "sh", "-c", 'test ! -e "$1" && echo isolated', "sh", otherHome)).toBe("isolated");
        expect(docker("exec", otherContainer, "sh", "-c", 'test ! -e "$1" && test ! -e "$2" && echo isolated', "sh", sentinel, workspaceSentinel)).toBe("isolated");
      }
      if (variant === "agent-stopped") {
        const agentPath = `${dashboard}/api/agents/${agentId}`;
        const changeStatus = (url: string, status: string) => fetch(url + "/status", {
          method: "PUT", headers: {cookie, "content-type": "application/json", "Idempotency-Key": crypto.randomUUID()},
          body: JSON.stringify({status}),
        });
        const awaitTransition = async (response: Response) => {
          expect(response.status).toBe(202);
          const {job} = await response.json() as {job: {id: string}};
          const deadline = Date.now() + 30000;
          let state: string | undefined;
          while (Date.now() < deadline) {
            const status = await fetch(agentPath + "/lifecycle/" + job.id, {headers: {cookie}});
            state = (await status.json() as {job: {status: string}}).job.status;
            if (state === "completed") break;
            await delay(100);
          }
          expect(state).toBe("completed");
        };
        const bodyDeletion = await changeStatus(agentPath + "/shadows/" + shadowId, "deleted");
        expect(bodyDeletion.status).toBe(409);
        expect(await bodyDeletion.json()).toMatchObject({code: "default_shadow_delete_forbidden"});
        expect(queryJob(active.jobId)?.execution?.state).toBe("running");
        await awaitTransition(await changeStatus(agentPath, "disabled"));
        expect(queryJob(active.jobId)?.execution?.state).toBe("cancelled");
        expect((await send()).ok).toBe(false);
        await awaitTransition(await changeStatus(agentPath, "deleted"));
        const history = await fetch(path, {headers: {cookie}});
        expect(history.status).toBe(200);
        expect(await history.text()).toContain(marker);
        expect(docker("ps", "-q", "--filter", workerLabel, "--filter", "label=luna.shadow=" + shadowId)).toBe("");
        expect(docker("ps", "-q", "--filter", workerLabel, "--filter", "label=luna.shadow=" + sibling.id)).not.toBe("");
        console.log(JSON.stringify({variant, execution: "cancelled", agent: "deleted", ownerHistory: true, siblingAgentUnaffected: true}));
        continue;
      }
      if (variant === "cancelled") {
        const queued = await fetch(path, {
          method: "POST", headers: {cookie, "content-type": "application/json", "Idempotency-Key": crypto.randomUUID()},
          body: JSON.stringify({text: "Queued before disabling the Shadow"}),
        });
        expect(queued.status).toBe(202);
        const {messageId: queuedId} = await queued.json() as {messageId: string};
        const queuedState = () => sqlite!.query("SELECT status FROM session_inbox WHERE message_id=?").get(queuedId);
        expect(queuedState()).toEqual({status: "pending"});

        const scheduleId = crypto.randomUUID();
        const now = Date.now(), dueAt = now + 5000;
        sqlite.transaction(() => {
          db.insert(sessionSchedules).values({
            id: scheduleId, actorUserId: ownerId, sourceSessionId: sessionId, targetSessionId: sessionId,
            action: {kind: "message.send", content: "Must not be sent after restore"},
            timezone: "UTC", nextAt: dueAt, enabled: true, revision: 1, overlap: "skip", misfire: "latest",
            expiresAfterMs: 60000, createdAt: now,
          }).run();
        })();
        const scheduleState = () => sqlite!.query("SELECT enabled, paused, revision FROM session_schedules WHERE id=?").get(scheduleId);
        expect(scheduleState()).toEqual({enabled: 1, paused: 0, revision: 1});
        const statusPath = `${dashboard}/api/agents/${scope.agentId}/shadows/${shadowId}/status`;
        const changeStatus = (status: string) => fetch(statusPath, {
          method: "PUT", headers: {cookie, "content-type": "application/json", "Idempotency-Key": crypto.randomUUID()},
          body: JSON.stringify({status}),
        });
        const stopped = await changeStatus("disabled");
        expect(stopped.status).toBe(202);
        const {job: transition} = await stopped.json() as {job: {id: string}};
        const lifecyclePath = `${dashboard}/api/agents/${scope.agentId}/lifecycle/${transition.id}`;
        const cancelDeadline = Date.now() + 30000;
        let status: string | undefined;
        while (Date.now() < cancelDeadline) {
          const response = await fetch(lifecyclePath, {headers: {cookie}});
          status = (await response.json() as {job: {status: string}}).job.status;
          if (status === "completed") break;
          await delay(100);
        }
        expect(status).toBe("completed");
        expect(queryJob(active.jobId)?.execution?.state).toBe("cancelled");
        expect(queuedState()).toEqual({status: "cancelled"});
        expect(scheduleState()).toEqual({enabled: 0, paused: 1, revision: 2});
        expect(docker("ps", "-q", "--filter", workerLabel, "--filter", "label=luna.shadow=" + shadowId)).toBe("");
        for (const [id, home] of homes) {
          if (home === shadowHome) homes.delete(id);
        }
        expect((await send()).ok).toBe(false);
        expect((await changeStatus("active")).status).toBe(200);
        await delay(Math.max(0, dueAt - Date.now()) + 1500);
        expect(scheduleState()).toEqual({enabled: 0, paused: 1, revision: 2});
        expect(queuedState()).toEqual({status: "cancelled"});
        expect(sqlite.query("SELECT count(*) AS count FROM schedule_occurrences WHERE schedule_id=?").get(scheduleId))
          .toEqual({count: 0});
        expect(sqlite.query("SELECT count(*) AS count FROM session_commands WHERE session_id=? AND kind='message.send'").get(sessionId))
          .toEqual({count: 0});
        console.log(JSON.stringify({variant, lifecycle: status, execution: "cancelled", queuedMessage: "cancelled", schedule: "paused", occurrences: 0, replies: 0}));
        continue;
      }
      if (variant === "queued-old") {
        expect(docker("exec", container, "cat", stampPath(resources))).toBe(queuedOld!.stamp);
        expect(homes.get(container)).toBe(shadowHome);
      }
      if (variant === "waiting" || variant === "updated") {
        homes.delete([...homes].find(([, home]) => home === shadowHome)?.[0] ?? "");
        homes.set(container, shadowHome);
        expect(docker("exec", container, "cat", stampPath(resources))).toBe(newStamp);
      }
      if (variant === "updated") {
        expect(active.job.runnerContextId).toBe(selected!.contextId);
        expect(active.job.input.sessionId).toBeUndefined();
        expect(active.job.input.prompt).toContain(selected!.marker);
        expect(docker("exec", container, "cat", stampPath(resources))).toBe(newStamp);
      } else if (variant !== "waiting" && variant !== "queued-old") {
        homes.set(container, shadowHome);
        if (variant === "selected") selected = {sessionId, marker, contextId: active.job.runnerContextId};
        expect(runnerPid).toMatch(/^\d+$/);
        const previousServicePid = serviceProcess.pid;
        serviceProcess.kill("SIGKILL");
        await serviceProcess.exited;
        expect(docker("exec", container, "cat", "/proc/" + runnerPid + "/comm")).toContain("bun");
        serviceProcess = await startService();
        expect(serviceProcess.pid).not.toBe(previousServicePid);
        await waitForWorker();
        const containerHealth = docker("exec", container, "bun", "-e",
          "try { console.log((await fetch(process.argv[1], { signal: AbortSignal.timeout(2000) })).status) } catch (error) { console.log(String(error)) }",
          `http://host.docker.internal:${servicePort}/api/health`);
        expect(containerHealth).toBe("200");
      }
      if (variant === "selected") {
        const oldStamp = docker("exec", container, "cat", stampPath(resources));
        const queueSession = async () => {
          const created = await fetch(dashboard + "/api/sessions/dashboard", {
            method: "POST", headers: {cookie, "content-type": "application/json"},
            body: JSON.stringify({agentId, shadowId}),
          });
          expect(created.status).toBe(201);
          const {sessionId: nextSessionId} = await created.json() as {sessionId: string};
          const nextMarker = "DASHBOARD_" + randomBytes(10).toString("hex");
          const submitted = await fetch(dashboard + "/api/sessions/" + nextSessionId + "/messages", {
            method: "POST", headers: {cookie, "content-type": "application/json", "Idempotency-Key": nextMarker},
            body: JSON.stringify({text: "Reply with " + nextMarker}),
          });
          expect(submitted.status).toBe(202);
          const {messageId: nextMessageId} = await submitted.json() as {messageId: string};
          return {sessionId: nextSessionId, marker: nextMarker, messageId: nextMessageId};
        };
        const oldSession = await queueSession();
        queuedOld = {...oldSession, stamp: oldStamp};
        const jobForSession = sqlite.query<{active_job_id: string | null}, [string]>(
          "SELECT active_job_id FROM runner_invocations WHERE session_id=?");
        const queueDeadline = Date.now() + 15000;
        let oldJob: ScheduledJob | undefined;
        while (Date.now() < queueDeadline) {
          const id = jobForSession.get(oldSession.sessionId)?.active_job_id;
          if (id) oldJob = queryJob(id);
          if (oldJob?.lastError?.code === "capacity_exhausted") break;
          await delay(100);
        }
        expect(oldJob?.lastError?.code).toBe("capacity_exhausted");
        expect(oldJob?.job.resources).toEqual(active.job.resources);
        expect(oldJob?.workerId).toBeFalsy();
        writeFileSync(stampFile, newStamp);
        expect(queryJob(active.jobId)?.execution?.state).toBe("running");
        expect(docker("exec", container, "cat", stampPath(resources))).toBe(oldStamp);
        expect(oldStamp).not.toBe(newStamp);
        waiting = await queueSession();
        const nextSessionId = waiting.sessionId;
        const revisionQuery = sqlite.query<{digest: string}, [string]>(
          "SELECT r.digest FROM invocation_resource_snapshots r JOIN runner_invocations i ON r.invocation_id=i.invocation_id WHERE i.session_id=?");
        const preparedDeadline = Date.now() + 12000;
        while (!revisionQuery.get(nextSessionId) && Date.now() < preparedDeadline) await delay(100);
        expect(revisionQuery.get(nextSessionId)?.digest).toBeTruthy();
        expect(revisionQuery.get(nextSessionId)?.digest).not.toBe(revisionQuery.get(sessionId)?.digest);
        expect(queryJob(active.jobId)?.execution?.state).toBe("running");
        expect(docker("ps", "-q", "--filter", workerLabel, "--filter", "label=luna.shadow=" + shadowId)).toBe(container);
        expect(docker("exec", container, "cat", stampPath(resources))).toBe(oldStamp);
        console.log(JSON.stringify({variant: "resource-wait", accepted: true, pinnedDifferentRevision: true, activeContainerUnchanged: true}));
      }
      docker("exec", container, "touch", releaseFile);
      const deadline = Date.now() + 45000;
      let result: { status: string; error: string | null } | undefined;
      while (Date.now() < deadline) {
        result = await (await fetch(path + "/" + messageId + "/status", { headers: { cookie } })).json() as typeof result;
        if (result?.status === "completed" || result?.status === "failed") break;
        await delay(100);
      }
      expect(result, variant + " dashboard status").toEqual({ status: "completed", error: null });
      const invocation = sqlite.query("SELECT actor_user_id, active_job_id, state FROM runner_invocations WHERE session_id=? AND active_job_id=?").all(sessionId, active.jobId) as { actor_user_id: string; active_job_id: string; state: string }[];
      expect(invocation).toHaveLength(1);
      expect(invocation[0]!.state).toBe("settled");
      const session = sqlite.query("SELECT created_by_user_id FROM sessions WHERE id=?").get(sessionId) as { created_by_user_id: string };
      expect(invocation[0]!.actor_user_id).toBe(session.created_by_user_id);
      const job = queryJob(invocation[0]!.active_job_id);
      if (!job) throw new Error("Settled invocation is missing its Runtime Job");
      expect(job).toMatchObject({ workerId, execution: { state: "succeeded" } });
      expect(job.jobId).toBe(active.jobId);
      expect(job.assignment).toEqual(active.assignment);
      expect(job.execution?.bootId).toBe(active.execution?.bootId);
      expect(job.job.runnerKind).toBe("main");
      if (variant === "independent") {
        const findTaskJob = sqlite.query<{active_job_id: string; runner_context_id: string}, [string]>(
          "SELECT i.active_job_id, i.runner_context_id FROM runner_invocations i JOIN tasks t ON t.id=i.task_id WHERE i.runner_kind='task' AND t.primary_session_id=?");
        const taskDeadline = Date.now() + 45000;
        let taskInvocation = findTaskJob.get(sessionId);
        while (Date.now() < taskDeadline) {
          taskInvocation = findTaskJob.get(sessionId);
          if (taskInvocation?.active_job_id && queryJob(taskInvocation.active_job_id)?.placementState === "terminal") break;
          await delay(100);
        }
        const taskJob = taskInvocation?.active_job_id ? queryJob(taskInvocation.active_job_id) : undefined;
        expect(taskJob).toMatchObject({workerId, execution: {state: "succeeded"}, job: {runnerKind: "task", scope: {agentId, shadowId}}});
        expect(taskJob!.assignment?.instanceId).toBe(job.assignment!.instanceId);
        expect(taskInvocation!.runner_context_id).not.toBe(active.job.runnerContextId);
        const taskCwd = join(shadowHome, "runners", taskInvocation!.runner_context_id);
        expect(docker("exec", container, "cat", join(taskCwd, "sdd-task-context"))).toBe(taskCwd);
        expect(docker("exec", container, "sh", "-c", 'test ! -e "$1" && echo distinct', "sh",
          join(shadowHome, "runners", active.job.runnerContextId, "sdd-task-context"))).toBe("distinct");
        console.log(JSON.stringify({variant: "main-task", sameContainer: true, distinctContexts: true, taskState: "succeeded"}));
      }
      if (variant === "updated") cleanup = {jobId: job.jobId, invocationId: job.job.invocationId};
      const replies = sqlite.query("SELECT status FROM session_commands WHERE session_id=? AND kind='message.send'").all(sessionId);
      expect(replies).toEqual(Array.from({length: variant === "updated" ? 2 : 1}, () => ({status: "sent"})));
      console.log(JSON.stringify({ variant, serviceRestarted: variant !== "updated" && variant !== "waiting" && variant !== "queued-old", sameJobAndAssignment: true, replies: replies.length }));

    }
    expect(docker("ps", "-q", "--filter", workerLabel).split("\n").filter(Boolean)).toHaveLength(1);
    if (!cleanup || !selected) throw new Error("Missing completed session for deletion");
    const preparationState = () => runtimeDb!.query("SELECT state FROM runtime_preparation_intents WHERE invocation_id=?")
      .get(cleanup!.invocationId) as {state: string} | null;
    const releaseDeadline = Date.now() + 10000;
    while (preparationState()?.state !== "released" && Date.now() < releaseDeadline) await delay(100);
    expect(preparationState()).toEqual({state: "released"});
    workerProcess.kill("SIGTERM");
    await workerProcess.exited;
    // Simulate losing the Runtime acknowledgement after the Worker already released.
    const writableRuntime = new Database(join(root, "runtime/runtime.sqlite"));
    try {
      writableRuntime.run("UPDATE runtime_preparation_intents SET state='active' WHERE invocation_id=?", [cleanup.invocationId]);
    } finally { writableRuntime.close(); }
    const removed = await fetch(`${dashboard}/api/sessions/${selected.sessionId}`, {method: "DELETE", headers: {cookie}});
    expect(removed.status).toBe(200);
    expect(preparationState()).toEqual({state: "active"});
    await startWorker();
    await waitForWorker();
    const cleanupDeadline = Date.now() + 12000;
    while ((queryJob(cleanup.jobId) || preparationState()?.state !== "released") && Date.now() < cleanupDeadline) await delay(100);
    expect(queryJob(cleanup.jobId)).toBeUndefined();
    expect(preparationState()).toEqual({state: "released"});
    expect(sqlite.query("SELECT pending_execution FROM session_deletions WHERE session_id=?").get(selected.sessionId))
      .toEqual({pending_execution: "[]"});
    expect(docker("ps", "-q", "--filter", workerLabel).split("\n").filter(Boolean)).toHaveLength(1);

    expect(sqlite.query("SELECT runner_session_id, runner_root_path FROM runner_contexts WHERE id='historical'").get())
      .toEqual({ runner_session_id: "previous-provider-session", runner_root_path: historicalPath });
    expect(existsSync(historicalPath)).toBe(false);
  } finally {
    for (const child of children.reverse()) {
      child.kill("SIGKILL");
      await child.exited;
    }
    sqlite?.close();
    runtimeDb?.close();
    try {
      const containers = docker("ps", "-aq", "--filter", workerLabel).split("\n").filter(Boolean);
      if (containers.length) docker("rm", "--force", ...containers);
      const volumes = docker("volume", "ls", "-q", "--filter", workerLabel).split("\n").filter(Boolean);
      if (volumes.length) docker("volume", "rm", ...volumes);
      try { docker("network", "rm", network); } catch {}
      if (fixtureBuilt) docker("image", "rm", imageTag);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 180000);
