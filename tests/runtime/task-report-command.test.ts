import {fixtureTaskOwnership, fixtureUser } from "../helpers/platform-fixtures";
import {fixtureSessionOwnership} from "../helpers/platform-fixtures";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { registerTestRunnerJob } from "./support/runner-job";
import { InvocationStore } from "../../src/runners/invocation-store";
import { taskResultArtifactRefs } from "../../src/main-runner/task-result-artifacts";
import { runnerArtifactAllowlistFromInput } from "../../src/main-runner/artifact-allowlist";
import { renderMainRunnerPrompt } from "../../src/main-runner/main-runner";
import { createArtifactsRoutes } from "../../src/server/routes/artifacts";
import { createDashboardAuthMiddleware, DashboardAuthService } from "../../src/server/auth";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {Hono} from "hono";
import {DataConnection} from "../../src/data";
import * as schema from "../../src/data/schema";
import {setLunaHome} from "../../src/shared";
import {TaskRunStore} from "../../src/tasks/task-run-store";
import {TaskReportService} from "../../src/tasks/task-report-service";
import {requireTaskReportCompletion} from "../../src/tasks/task-report-store";
import {TaskRunSupervisor} from "../../src/tasks/task-run-supervisor";
import {createTaskReportRoutes} from "../../src/server/routes/task-reports";
import {createRunnerProtocolV2Routes} from "../../src/server/routes/runner-protocol-v2";
import {runTasksCli} from "@luna/cli/commands/tasks";
import {runCommandsCli} from "@luna/cli/commands/commands";
import type {LunaAccessTokenClaims} from "../../src/server/auth/access-token-service";

let home: string;
let connection: DataConnection<typeof schema>;
afterEach(() => {connection?.close(); if(home) rmSync(home,{recursive:true,force:true});});
function fixture() {
  home=mkdtempSync(join(tmpdir(),"luna-report-"));setLunaHome(home);
  connection=new DataConnection(schema);const db=connection.db;
  const sessionOwnership = fixtureSessionOwnership(db, "test", "test");
  fixtureUser(db, sessionOwnership.agent_id, "user");
  db.insert(schema.sessions).values({id:"session",channel_type:"test",channel_id:"test",created_at:1,updated_at:1,...sessionOwnership}).run();
  db.insert(schema.tasks).values({id:"task",type:"task",title:"Report test",summary:"Original",status:"running",context_json:{knownFacts:["fact"]},created_at:1,updated_at:1,last_activity_at:1, ...fixtureTaskOwnership(db,"session")}).run();
  const context = new RunnerContextStore(db).resolveForTask("task", "codex");
  const store=new TaskRunStore(db);
  const run=store.createRun({taskId:"task",reason:"initial",inputSnapshot:{},runnerType:"codex",runnerContextId:context.id});
  db.insert(schema.accessTokens).values({id:"token",agentId:sessionOwnership.agent_id,tokenHash:"hash",userId:"user",source:"runner",name:"task",role:"runner",issuedAt:1,expiresAt:Date.now()+60000,createdAt:1,metadataJson:{invocationId:"invocation"}}).run();
  const controller=new AbortController();
  const claims:LunaAccessTokenClaims={tokenId:"token",actorUserId:"user",source:"runner",role:"runner",runnerKind:"task",agentId:context.agent_id,shadowId:context.shadow_id,taskId:"task",taskRunId:run.id,runnerJobId:context.id,issuedAt:1,expiresAt:Date.now()+60000};
  const finishJob = registerTestRunnerJob(db, "invocation", claims, {
    version: 1, kind: "task", input: { taskId: "task", taskRunId: run.id, runnerContextId: context.id },
  }, run.id);
  controller.signal.addEventListener("abort", () => new InvocationStore(db).revoke("invocation", "test cancelled"));
  let published=0;
  const service=new TaskReportService(db,async () => {published++;});
  return {db,store,run,context,controller,claims,service,finishJob,published:()=>published};
}
test("report commits before process exit; identical retries are idempotent and terminal prose is ignored once submitted",()=>{
  const f=fixture();
  f.db.insert(schema.taskSubscriptions).values({id:"sub",task_id:"task",session_id:"session",channel_type:"test",channel_id:"test",visibility:"full",created_at:1,updated_at:1}).run();
  expect(()=>requireTaskReportCompletion(f.db,f.run.id,"")).toThrow("without submitting");
  expect(()=>requireTaskReportCompletion(f.db,f.run.id,"report prose")).toThrow("without submitting");
  const receipt=f.service.submit(f.claims,"final","2+2=4");
  expect(f.published()).toBe(1);
  expect(f.store.listRunsForTask("task")[0]?.status).toBe("running");
  expect(f.db.select().from(schema.sessionTriggers).all()).toHaveLength(1);
  expect(f.service.submit(f.claims,"final","2+2=4")).toEqual(receipt);
  expect(f.service.get(f.claims,receipt.commandId)).toEqual(receipt);
  expect(f.published()).toBe(1);
  expect(f.db.select().from(schema.taskReportCommands).all()).toHaveLength(1);
  expect(()=>f.service.submit(f.claims,"final","changed")).toThrow("already has");
  expect(()=>f.service.submit(f.claims,"another","2+2=4")).toThrow("already has");
  expect(requireTaskReportCompletion(f.db,f.run.id,"Report submitted.")).toEqual({finalReportArtifactId:receipt.reportArtifactId});
  expect(requireTaskReportCompletion(f.db,f.run.id,"")).toEqual({finalReportArtifactId:receipt.reportArtifactId});
});
test("Task report capability rejects other roles, wrong runs, missing artifacts, revoked tokens and late calls",()=>{
  const f=fixture();
  expect(()=>f.service.submit({...f.claims,runnerKind:"main"},"final","report")).toThrow("Only a Task");
  expect(()=>f.service.submit({...f.claims,taskRunId:"other"},"final","report")).toThrow("does not match");
  expect(()=>f.service.submit(f.claims,"final","artifact:missing")).toThrow("unavailable artifact");
  expect(()=>f.service.submit(f.claims,"final"," ")).toThrow("nonempty");
  f.db.update(schema.accessTokens).set({revokedAt:Date.now()}).where(eq(schema.accessTokens.id,"token")).run();
  expect(()=>f.service.submit(f.claims,"final","report")).toThrow("token is inactive");
  f.db.update(schema.accessTokens).set({revokedAt:null}).where(eq(schema.accessTokens.id,"token")).run();
  f.controller.abort();
  expect(()=>f.service.submit(f.claims,"final","report")).toThrow("no longer active");
});
test("startup completes an accepted report instead of failing the interrupted process",async()=>{
  const f=fixture();
  const receipt=f.service.submit(f.claims,"final","Durable report");
  f.finishJob();
  new InvocationStore(f.db).finish("invocation");
  const results: unknown[]=[];
  const supervisor=new TaskRunSupervisor({db:f.db,runnerType:"mock",onTaskResult:async result=>{results.push(result);}});
  expect(await supervisor.recoverRunningRuns()).toBe(1);
  expect(f.store.listRunsForTask("task")[0]).toMatchObject({status:"completed",finalReportArtifactId:receipt.reportArtifactId});
  expect(results).toHaveLength(1);
  expect(await supervisor.recoverRunningRuns()).toBe(0);
  expect(()=>f.service.submit(f.claims,"final","Durable report")).toThrow("no longer active");
});
test("a submitted report whose Job Service still sees running completes once the Job is drained",async()=>{
  const f=fixture();
  const receipt=f.service.submit(f.claims,"final","Durable report");
  const results: unknown[]=[];
  // Recovery reattaches, but following the Job fails, as when Service lost its event stream.
  const supervisor=new TaskRunSupervisor({db:f.db,runnerType:"mock",onTaskResult:async result=>{results.push(result);},
    executeRun:async()=>{throw new Error("job events unavailable");}});
  expect(await supervisor.recoverRunningRuns()).toBe(0);
  await Bun.sleep(50);
  // Never settled while the Job may still execute; the invocation is revoked so the Job is cancelled.
  expect(f.store.listRunsForTask("task")[0]?.status).toBe("running");
  expect(new InvocationStore(f.db).require("invocation")).toMatchObject({state:"revoked",revokeReason:"task_report_submitted"});
  // The recovery pump drains the Job to terminal and settles; it leaves the reported run to the supervisor.
  f.finishJob();
  const reconciler=new (await import("../../src/runners/job-reconciler")).JobReconciler(f.db,{} as never,new AbortController().signal);
  await reconciler.recover();
  expect(f.store.listRunsForTask("task")[0]?.status).toBe("running");
  await Bun.sleep(1200);
  await supervisor.waitForIdle();
  expect(f.store.listRunsForTask("task")[0]).toMatchObject({status:"completed",finalReportArtifactId:receipt.reportArtifactId});
  expect(results).toHaveLength(1);
});
test("report CLI posts text and reads receipt through authenticated routes",async()=>{
  const f=fixture();
  const app=new Hono<{Variables:{lunaAccessTokenClaims:LunaAccessTokenClaims}}>();
  app.use("*",async(c,next)=>{c.set("lunaAccessTokenClaims",f.claims);await next();});
  app.route("/api/runner/task-reports",createTaskReportRoutes(f.service));
  app.route("/api/runner",createRunnerProtocolV2Routes({db:f.db,channelFor:()=>undefined}));
  const server=Bun.serve({port:0,fetch:req=>app.fetch(req)});
  const env={LUNA_SERVICE_URL:`http://127.0.0.1:${server.port}`,LUNA_ACCESS_TOKEN:"test",LUNA_INVOCATION_ID:"invocation"};
  try {
    const result=await runTasksCli(["report","--text","CLI report"],env);
    expect(result.status).toBe("ok");
    const receipt=JSON.parse(result.output!);
    expect(receipt.status).toBe("accepted");
    const status=await runCommandsCli(["status",receipt.commandId],env);
    expect(JSON.parse(status.output!)).toMatchObject({commandId:receipt.commandId,status:"accepted"});
    expect((await runTasksCli(["report","--request-id","legacy","--text","rejected"],env)).status).toBe("error");
  } finally {server.stop(true);}
});
test("a process failure after acceptance preserves the submitted report",async()=>{
  const f=fixture();
  f.finishJob();
  new InvocationStore(f.db).finish("invocation");
  f.store.markFailed(f.run.id,{error:"previous attempt"});
  const supervisor=new TaskRunSupervisor({db:f.db,runnerType:"mock",executeRun:async input=>{
    const id = "retry-invocation";
    f.db.update(schema.accessTokens).set({ metadataJson: { invocationId: id } }).where(eq(schema.accessTokens.id, f.claims.tokenId)).run();
    const active = { ...f.claims, taskRunId: input.taskRunId, runnerJobId: input.runnerContext!.id };
    const finish = registerTestRunnerJob(f.db, id, active, {
      version: 1, kind: "task",
      input: { taskId: input.taskId, taskRunId: input.taskRunId, runnerContextId: input.runnerContext!.id },
    }, input.taskRunId);
    f.service.submit(active, "final", "Accepted before crash");
    finish();
    throw Error("process disappeared");
  }});
  supervisor.restartTaskRun({taskId:"task",updatedTaskSummary:"Original",updateSummary:"Retry",preserveTaskContext:true,inputSnapshot:{}});
  await supervisor.waitForIdle();
  const latest=f.store.listRunsForTask("task").at(-1)!;
  expect(latest.status).toBe("completed");
  expect(latest.finalReportArtifactId).toBeTruthy();
  expect(f.db.select().from(schema.taskReportCommands).all()).toHaveLength(1);
});
test("a superseded invocation cannot submit a late report",()=>{
  const f=fixture();
  f.store.markCancelled(f.run.id,{cancelReason:"updated"});
  f.store.createRun({taskId:"task",reason:"restart",inputSnapshot:{},runnerType:"codex",runnerContextId:f.context.id});
  expect(()=>f.service.submit(f.claims,"late","old result")).toThrow("no longer current");
  expect(f.db.select().from(schema.taskReportCommands).all()).toHaveLength(0);
});


test("Main downloads the managed report while Task Run retains its timeline artifact ID", async () => {
  const f = fixture();
  const receipt = f.service.submit(f.claims, "report", "verified report body");
  const refs = taskResultArtifactRefs(f.db, "task", [receipt.reportArtifactId, receipt.reportArtifactId]);
  expect(refs).toHaveLength(1);
  const ids = runnerArtifactAllowlistFromInput({ artifactRefs: refs });
  expect(ids[0]).not.toBe(receipt.reportArtifactId);
  expect(f.store.listRunsForTask("task")[0]!.finalReportArtifactId).toBe(receipt.reportArtifactId);
  expect(taskResultArtifactRefs(f.db, "other-task", [receipt.reportArtifactId])).toEqual([]);
  const prompt = renderMainRunnerPrompt({ type: "task_result", sessionId: "session", taskId: "task",
    context: { sessionId: "session", candidateOpenTasks: [] }, result: { taskId: "task", taskRunId: f.run.id, status: "completed", title: "Report", summary: "", userVisibleReport: "verified report body", evidenceSummary: [], nextActions: [], artifactIds: [receipt.reportArtifactId], artifactRefs: refs } });
  expect(prompt).toContain(refs[0]!);
  expect(prompt).not.toContain(receipt.reportArtifactId);
  const previous = process.env.LUNA_ACCESS_TOKEN_SECRET;
  process.env.LUNA_ACCESS_TOKEN_SECRET = "report-test";
  try {
    const issuer = new AccessTokenService({ db: f.db, signingSecret: "report-test" });
    const reportOwnership = fixtureSessionOwnership(f.db,"test","test");
    fixtureUser(f.db, reportOwnership.agent_id, "recipient");
    f.db.insert(schema.sessions).values({ id: "report-session", channel_type: "test", channel_id: "test", created_by_user_id: "recipient", created_at: 1, updated_at: 1 , ...reportOwnership}).run();
    const readerContext = new RunnerContextStore(f.db).resolveForSession("report-session", "codex");
    const tokenInput = { userId: "recipient", name: "main-report", source: "runner" as const, role: "runner" as const, runnerKind: "main" as const, sourceRunnerJobId: readerContext.id, sourceSessionId: "report-session", sourceTaskId: "task", sourceTaskRunId: f.run.id, ttlMs: 60000, now: Date.now() };
    const token = issuer.issueToken({ ...tokenInput, metadata: { invocationId: "report-reader", artifactIds: ids } });
    registerTestRunnerJob(f.db, "report-reader", token.claims, {
      version: 1, kind: "main",
      input: {
        input: { type: "task_result", sessionId: "report-session", taskId: "task", context: { sessionId: "report-session", candidateOpenTasks: [] },
          result: { taskId: "task", taskRunId: f.run.id, status: "completed", title: "Report", summary: "", evidenceSummary: [], userVisibleReport: "verified report body", artifactIds: [], nextActions: [] } },
        runnerContext: readerContext,
      },
    }, "report-reader");
    const app = new Hono();
    app.use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db: f.db }));
    app.route("/api/artifacts", createArtifactsRoutes({ db: f.db }));
    const response = await app.request(`http://service/api/artifacts/${ids[0]}/content`, { headers: { authorization: `Bearer ${token.token}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("verified report body");
    const ungranted = issuer.issueToken({ ...tokenInput, metadata: { invocationId: "report-reader", artifactIds: [] } });
    expect((await app.request(`http://service/api/artifacts/${ids[0]}/content`, { headers: { authorization: `Bearer ${ungranted.token}` } })).status).toBe(403);
    const register = (scopeType: string, scopeId: string) => app.request("http://service/api/artifacts", {
      method: "POST", headers: {authorization: `Bearer ${token.token}`, "content-type": "application/json"},
      body: JSON.stringify({scopeType, scopeId, producer: "runner", kind: "report", name: "derived.md", mimeType: "text/markdown",
        contentBase64: Buffer.from("Derived report").toString("base64")}),
    });
    expect((await register("task", "task")).status).toBe(403);
    expect((await register("session", "report-session")).status).toBe(201);
    f.db.update(schema.artifacts).set({ status: "archived" }).where(eq(schema.artifacts.id, receipt.reportArtifactId)).run();
    expect(taskResultArtifactRefs(f.db, "task", [receipt.reportArtifactId])).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LUNA_ACCESS_TOKEN_SECRET; else process.env.LUNA_ACCESS_TOKEN_SECRET = previous;
  }
});

test("a waiting report marks the Task, tells Main, and the next run clears the mark", async () => {
  const f = fixture();
  const published: unknown[] = [];
  const service = new TaskReportService(f.db, async result => { published.push(result); });
  const blockReason = () => f.db.select().from(schema.tasks).where(eq(schema.tasks.id, "task")).get()!.block_reason;
  const receipt = service.submit(f.claims, "final", "Which version should this target?", true);
  expect(blockReason()).toBe("waiting_user");
  expect(published[0]).toMatchObject({ status: "completed", waitingForInput: true });
  expect(service.submit(f.claims, "final", "Which version should this target?", true)).toEqual(receipt);
  expect(() => service.submit(f.claims, "final", "Which version should this target?")).toThrow("already has");
  const prompt = renderMainRunnerPrompt({ type: "task_result", sessionId: "session", taskId: "task",
    context: { sessionId: "session", candidateOpenTasks: [] }, result: published[0] as never });
  expect(prompt).toMatch(/"waitingForInput":\s*true/);

  f.finishJob();
  new InvocationStore(f.db).finish("invocation");
  const settled: unknown[] = [];
  let seenAtRestart: string | null | undefined;
  const supervisor = new TaskRunSupervisor({ db: f.db, runnerType: "mock", onTaskResult: async result => { settled.push(result); },
    executeRun: async input => {
      seenAtRestart = blockReason();
      const id = "answer-invocation";
      f.db.update(schema.accessTokens).set({ metadataJson: { invocationId: id } }).where(eq(schema.accessTokens.id, f.claims.tokenId)).run();
      const active = { ...f.claims, taskRunId: input.taskRunId, runnerJobId: input.runnerContext!.id };
      const finish = registerTestRunnerJob(f.db, id, active, {
        version: 1, kind: "task",
        input: { taskId: input.taskId, taskRunId: input.taskRunId, runnerContextId: input.runnerContext!.id },
      }, input.taskRunId);
      service.submit(active, "final", "Done with the answer");
      finish();
      throw Error("process disappeared");
    } });
  expect(await supervisor.recoverRunningRuns()).toBe(1);
  expect(settled[0]).toMatchObject({ status: "completed", waitingForInput: true });
  expect(blockReason()).toBe("waiting_user");

  supervisor.restartTaskRun({ taskId: "task", updatedTaskSummary: "Original", updateSummary: "Target 1.2", preserveTaskContext: true, inputSnapshot: {} });
  await supervisor.waitForIdle();
  expect(seenAtRestart).toBeNull();
  expect(blockReason()).toBeNull();
  expect(settled.at(-1)).not.toHaveProperty("waitingForInput");
});

test("report CLI sends --waiting and rejects it on the wire only when malformed", async () => {
  const f = fixture();
  const app = new Hono<{ Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims } }>();
  app.use("*", async (c, next) => { c.set("lunaAccessTokenClaims", f.claims); await next(); });
  app.route("/api/runner/task-reports", createTaskReportRoutes(f.service));
  const server = Bun.serve({ port: 0, fetch: req => app.fetch(req) });
  const env = { LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test", LUNA_INVOCATION_ID: "invocation" };
  try {
    const result = await runTasksCli(["report", "--waiting", "--text", "Confirm the scope"], env);
    expect(result.status).toBe("ok");
    expect(f.db.select().from(schema.tasks).where(eq(schema.tasks.id, "task")).get()!.block_reason).toBe("waiting_user");
    const malformed = await fetch(`${env.LUNA_SERVICE_URL}/api/runner/task-reports`, { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "other" }, body: JSON.stringify({ content: "x", waiting: "yes" }) });
    expect(malformed.status).toBe(400);
  } finally { server.stop(true); }
});
