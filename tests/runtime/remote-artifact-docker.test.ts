import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { config, setLunaHome } from "../../src/shared";
import { tasks } from "../../src/data/schema";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { TaskRunStore } from "../../src/tasks/task-run-store";
import { fixtureNamedSession } from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";
import { decodeInvocation } from "../../src/runners/invocation-codec";
import { InvocationService } from "../../src/runners/invocation-service";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { createDashboardAuthMiddleware, DashboardAuthService } from "../../src/server/auth";
import { createArtifactsRoutes } from "../../src/server/routes/artifacts";
import { ArtifactRegistry } from "../../src/artifacts/artifact-registry";

const script = String.raw`
const input = await Bun.stdin.json();
const fs = require('node:fs'); const crypto = require('node:crypto');
const path = '/tmp/remote-artifact-' + input.nonce;
fs.writeFileSync(path, Buffer.alloc(input.size, 97));
const env = { ...process.env, ...input.env, LUNA_HOME: '/tmp/cli-home' };
async function cli(args) {
 const child = Bun.spawn(['bun','/app/luna-cli/cli.js','artifacts',...args],{env,stdout:'pipe',stderr:'pipe'});
 const [code,output] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 return {code,output};
}
const registered = await cli(['register',path,'--json']);
if (registered.code !== 0) throw Error(registered.output);
const artifact = JSON.parse(registered.output);
const downloaded = await cli(['download',artifact.ref,'--output','/tmp/remote-download']);
if (downloaded.code !== 0) throw Error(downloaded.output);
const wrong = await cli(['register',path,'--scope-type',input.scopeType,'--scope-id','different-scope','--json']);
console.log(JSON.stringify({artifactId:artifact.artifactId,sha256:crypto.createHash('sha256').update(fs.readFileSync('/tmp/remote-download')).digest('hex'),wrongScopeDenied:wrong.code!==0 && wrong.output.includes('HTTP 403')}));
`;

test.skipIf(process.env.LUNA_DOCKER_INTEGRATION !== "1")("Runner CLI artifacts cross HTTP without a shared filesystem for Main, Work and Task identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-remote-artifact-")); const oldHome = config.paths.home;
  const descriptor = Object.getOwnPropertyDescriptor(config, "sandbox")!; const sandbox = config.sandbox;
  const secret = process.env.LUNA_ACCESS_TOKEN_SECRET; process.env.LUNA_ACCESS_TOKEN_SECRET = "artifact-integration-secret";
  Object.defineProperty(config, "sandbox", { configurable: true, get: () => ({ ...sandbox, runtimeConfigFile: "/test/runtime.json" }) });
  setLunaHome(root);
  const sqlite = new Database(":memory:"); const db = drizzle(sqlite); migrate(db, { migrationsFolder: "src/data/drizzle" });
  const tokens = new AccessTokenService({ db, signingSecret: "artifact-integration-secret" });
  const app = new Hono(); app.use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db })); app.route("/api/artifacts", createArtifactsRoutes({ db }));
  const service = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: app.fetch });
  const names: string[] = [];
  try {
    for (const kind of ["main", "task"] as const) {
      const user = `user-${kind}`, session = `session-${kind}`, invocation = `inv-${kind}`;
      const scope = fixtureNamedSession(db, session, user);
      const contexts = new RunnerContextStore(db);
      if (kind === "task") {
        db.insert(tasks).values({
          id: "task", type: "execution", title: "Artifact test", status: "running", creator_user_id: user,
          agent_id: scope.agentId, shadow_id: scope.shadowId, created_at: 0, updated_at: 0, last_activity_at: 0,
        }).run();
      }
      const runnerContext = kind === "task" ? contexts.resolveForTask("task", "codex") : contexts.resolveForSession(session, "codex");
      const run = kind === "task" ? new TaskRunStore(db).createRun({
        taskId: "task", reason: "initial", inputSnapshot: {}, runnerType: "codex", runnerContextId: runnerContext.id,
      }) : undefined;
      const snapshot = decodeInvocation({ version: 1, kind, input: kind === "task" ? { taskId: "task", taskRunId: run!.id, runnerContextId: runnerContext.id }
        : { input: { type: "session_trigger", triggerId: "trigger", instruction: "Artifact test", requesterUserId: user, context: { sessionId: session, candidateOpenTasks: [] }, artifactRefs: [], sourceSessionId: session, correlationId: "correlation", hops: 0 },
          runnerContext } });
      const issued = tokens.issueToken({ userId: user, name: "artifact test", source: "runner", role: "runner", runnerKind: kind, sourceRunnerJobId: runnerContext.id,
        ...(run ? { sourceTaskId: "task", sourceTaskRunId: run.id } : { sourceSessionId: session }),
        ttlMs: 60_000, now: Date.now(), metadata: { invocationId: invocation, artifactIds: [] },
      });
      registerTestRunnerJob(db, invocation, issued.claims, snapshot, invocation);
      new InvocationService(db).requireActive(issued.claims, kind);
      const nonce = crypto.randomUUID(); const name = `luna-artifact-${nonce}`; names.push(name);
      const size = kind === "main" ? 6 * 1024 * 1024 : 4096;
      expect(existsSync(`/tmp/remote-artifact-${nonce}`)).toBe(false);
      const child = Bun.spawn(["docker", "run", "--rm", "-i", "--name", name, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--add-host", "host.docker.internal:host-gateway", "--entrypoint", "bun", process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:latest", "-e", script], { stdin: new TextEncoder().encode(JSON.stringify({ nonce, size, scopeType: kind === "task" ? "task" : "session", env: { LUNA_SERVICE_URL: `http://host.docker.internal:${service.port}`, LUNA_ACCESS_TOKEN: issued.token, ...(kind === "task" ? { LUNA_TASK_ID: "task" } : { LUNA_SESSION_ID: session }) } })), stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 60000);
      const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer));
      expect(exit, error.replaceAll(issued.token, "[REDACTED]")).toBe(0);
      const result = JSON.parse(output);
      expect(result.sha256).toBe(createHash("sha256").update(Buffer.alloc(size, 97)).digest("hex"));
      expect(result.wrongScopeDenied).toBe(true);
      expect(existsSync(`/tmp/remote-artifact-${nonce}`)).toBe(false);
      expect(new ArtifactRegistry(db).getActive(result.artifactId)).toMatchObject({ scope_type: kind === "task" ? "task" : "session", scope_id: kind === "task" ? "task" : session, related_user_id: user, size_bytes: size });
      new InvocationService(db).revoke(invocation, "test_cancel");
      const denied = await fetch(`http://127.0.0.1:${service.port}/api/artifacts/${result.artifactId}/content`, { headers: { Authorization: `Bearer ${issued.token}` } });
      expect(denied.status).toBe(401);
    }
  } finally {
    service.stop(true);
    for (const name of names) { const cleanup = Bun.spawn(["docker", "rm", "--force", name], { stdout: "ignore", stderr: "ignore" }); await cleanup.exited; }
    sqlite.close(); Object.defineProperty(config, "sandbox", descriptor); setLunaHome(oldHome);
    if (secret === undefined) delete process.env.LUNA_ACCESS_TOKEN_SECRET; else process.env.LUNA_ACCESS_TOKEN_SECRET = secret;
    rmSync(root, { recursive: true, force: true });
  }
}, 240000);
