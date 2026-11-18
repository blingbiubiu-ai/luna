import {fixtureSessionOwnership, fixtureUser } from "../helpers/platform-fixtures";
import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";
import { encodeInvocation } from "../../src/runners/invocation-codec";
import { InvocationStore } from "../../src/runners/invocation-store";
import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "../../src/data";
import * as schema from "../../src/data/schema";
import {setLunaHome} from "../../src/shared";
import {SessionStore} from "../../src/sessions/session-store";
import {MessageStore} from "../../src/sessions/message-store";
import {ContextPackStore} from "../../src/context";
import {taskCommandPresentation} from "../../src/dashboard-api/sessions";
import {RunnerContextStore} from "../../src/runners/runner-context-store";
import {runnerMessageEnvelopeFromRow} from "../../src/runners/message-envelope";
import {RunnerOperationService} from "../../src/runners/operation-service";
import {TaskRunSupervisor} from "../../src/tasks/task-run-supervisor";
import {TaskRunNotificationService} from "../../src/tasks/task-run-notification-service";
import {SessionReplyDispatcher} from "../../src/messaging/session-reply-dispatcher";
import {FakeFeishuChannel} from "../../extensions/channels/fake/fake-feishu-channel";
import {Hono} from "hono";
import {createRunnerOperationRoutes} from "../../src/server/routes/runner-operations";
import {runRunnerOperationsCli} from "@luna/cli/commands/runner-operations";
import type {LunaAccessTokenClaims} from "../../src/server/auth/access-token-service";
import type {NormalizedInboundMessage} from "../../src/channels";

let home:string;
let connection:DataConnection<typeof schema>;
afterEach(()=>{connection?.close();if(home)rmSync(home,{recursive:true,force:true});});
function fixture(hold?: Promise<void>) {
  home=mkdtempSync(join(tmpdir(),"luna-thread-command-"));setLunaHome(home);
  connection=new DataConnection(schema);const db=connection.db;
  const ownership=fixtureSessionOwnership(db,"feishu","test");
  fixtureUser(db,ownership.agent_id,"user");
  const sessions=new SessionStore(db);
  const session=sessions.resolveByChannelSurface({channelType:"feishu",channelId:"test",groupId:"chat"});
  const inbound:NormalizedInboundMessage={id:"om_anchor",channel:{id:"test",type:"feishu"},surface:{externalId:"chat",kind:"group"},sender:{externalId:"user",kind:"user",requesterIdentity:{provider:"local",externalUserId:"user",canonicalUserId:"user"}},text:"Investigate",mentions:[],addressing:{addressedToBot:true,reason:"p2p"}};
  const messages=new MessageStore(db);
  const history=messages.appendOnce({sessionId:session.id,channelMessageKey:"om_history",role:"user",senderUserId:"user",channel:inbound.channel,content:[{type:"text",text:"Historical fact"}]}).row;
  const anchor=messages.appendOnce({sessionId:session.id,channelMessageKey:inbound.id,role:"user",senderUserId:"user",inbound,channel:inbound.channel,content:[{type:"text",text:inbound.text}]}).row;
  const context=new RunnerContextStore(db).resolveForSession(session.id,"codex");
  const input: Parameters<typeof encodeInvocation>[1] = {invocationId:"invocation",turnId:"turn",runnerContext:context,input:{type:"user_messages",messages:[{...runnerMessageEnvelopeFromRow({row:anchor,rawMessage:inbound}),rawMessage:inbound}],latestMessage:inbound,context:{sessionId:session.id,candidateOpenTasks:[]}}};
  const claims:LunaAccessTokenClaims={agentId:session.agent_id,shadowId:session.shadow_id,tokenId:"token",actorUserId:"user",source:"runner",role:"runner",runnerKind:"main",sessionId:session.id,runnerJobId:context.id,issuedAt:1,expiresAt:Date.now()+60000};
  db.insert(schema.accessTokens).values({id:"token",agentId:claims.agentId,tokenHash:"hash",userId:"user",source:"runner",name:"main",role:"runner",issuedAt:1,expiresAt:Date.now()+60000,createdAt:1,metadataJson:{invocationId:"invocation"}}).run();
  registerTestRunnerJob(db, "invocation", claims, encodeInvocation("main", input), "turn");
  const channel=new FakeFeishuChannel("test");
  const dispatcher=new SessionReplyDispatcher(db,()=>channel);
  const reports:unknown[]=[];
  const supervisor=new TaskRunSupervisor({db,runnerType:"mock",executeRun:async()=>{await hold;return {finalReportArtifactId:"report"};},onTaskResult:result=>{reports.push(result);},runNotifications:new TaskRunNotificationService({db,channelForNotification:()=>dispatcher.channel("test")})});
  const cards=new TaskRunNotificationService({db,channelForNotification:()=>dispatcher.channel("test")});
  const service=new RunnerOperationService(db,supervisor,cards);
  return {db,sessions,session,inbound,anchor,history,claims,channel,supervisor,service,reports,cards};
}
test("explicit thread command references anchor/history once; task binds it and optional cards target the real anchor",async()=>{
  const f=fixture();
  const payload={anchorMessageId:f.anchor.id,contextMessageIds:[f.history.id,f.anchor.id]};
  const thread=await f.service.execute(f.claims,"session.create_thread","thread",payload);
  expect(thread.targetSessionId).not.toBe(f.session.id);
  expect(f.sessions.getById(thread.targetSessionId!)).toMatchObject({thread_key:"om_anchor",root_message_key:"om_anchor"});
  expect(f.channel.outbound).toHaveLength(0);
  expect(await f.service.execute(f.claims,"session.create_thread","thread",payload)).toEqual(thread);
  const packs=new ContextPackStore(f.db);
  const pack=packs.listPacksForOwner("session",thread.targetSessionId!).find(p=>p.kind==="thread_launch")!;
  expect(packs.listItemsForPack(pack.id).map(i=>i.sourceMessageId)).toEqual([f.history.id,f.anchor.id]);
  expect(f.db.select().from(schema.messages).all()).toHaveLength(2);
  const created=await f.service.execute(f.claims,"task.create","task",{title:"Bound task",summary:"Execute",facts:[],sessionId:thread.targetSessionId,sendStatusCard:true});
  await f.supervisor.waitForIdle();
  expect(created.taskSessionId).toBe(thread.targetSessionId);
  expect(f.db.select().from(schema.tasks).all()[0]?.primary_session_id).toBe(thread.targetSessionId);
  const cards=f.channel.outbound.filter(o=>o.statusCard && o.replyMode!=="update_status_card");
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({replyMode:"reply_in_thread",targetMessageId:"om_anchor",sessionId:thread.targetSessionId});
  expect(f.db.select().from(schema.taskRunNotifications).all()[0]?.status_message_id).toBeTruthy();
  expect(packs.listTaskSourceItems().filter(item=>item.taskId===created.taskIds[0]).map(i=>i.sourceMessageId)).toContain(f.history.id);
  const restarted=await f.service.execute(f.claims,"task.restart","retry",{taskId:created.taskIds[0]});
  await f.supervisor.waitForIdle();
  expect(restarted.taskSessionId).toBe(thread.targetSessionId);
  expect(f.db.select().from(schema.taskSubscriptions).all()).toHaveLength(1);
  expect(f.reports).toHaveLength(2);
});
test("task creation can explicitly disable cards while still reporting to Main",async()=>{
  const f=fixture();
  const result=await f.service.execute(f.claims,"task.create","silent",{title:"No cards",summary:"Execute",facts:[],sendStatusCard:false});
  await f.supervisor.waitForIdle();
  expect(result.taskSessionId).toBe(f.session.id);
  expect(f.db.select().from(schema.taskSubscriptions).all()[0]?.status_card_style).toBe("native");
  expect(f.db.select().from(schema.sessions).all()).toHaveLength(1);
  expect(f.db.select().from(schema.taskRunNotifications).all()).toHaveLength(0);
  expect(f.db.select().from(schema.taskSubscriptions).all()[0]?.notification_level).toBe("none");
  expect(f.channel.outbound).toHaveLength(0);
  expect(f.reports).toHaveLength(1);
});
test("opted-in cards in a root session stay in that session instead of creating a thread",async()=>{
  const f=fixture();
  await f.service.execute(f.claims,"task.create","root-card",{title:"Root card",summary:"Execute",facts:[],sendStatusCard:true});
  await f.supervisor.waitForIdle();
  expect(f.channel.outbound[0]?.replyMode).toBe("channel_message");
  expect(f.db.select().from(schema.sessions).all()).toHaveLength(1);
});
test("thread selection rejects missing or unrelated history and internal anchors atomically",async()=>{
  const f=fixture();
  await expect(f.service.execute(f.claims,"session.create_thread","bad",{anchorMessageId:f.anchor.id,contextMessageIds:["foreign"]})).rejects.toThrow("visible messages");
  expect(f.db.select().from(schema.sessions).all()).toHaveLength(1);
  const internal=new MessageStore(f.db).appendOnce({sessionId:f.session.id,channelMessageKey:"runner-operation:internal",role:"user",senderUserId:"user",channel:f.inbound.channel,content:[{type:"text",text:"internal"}]}).row;
  await expect(f.service.execute(f.claims,"session.create_thread","bad-anchor",{anchorMessageId:internal.id})).rejects.toThrow("real Feishu");
  f.db.update(schema.messages).set({deletedAt:Date.now()}).where(eq(schema.messages.id,f.history.id)).run();
  await expect(f.service.execute(f.claims,"session.create_thread","deleted",{anchorMessageId:f.anchor.id,contextMessageIds:[f.history.id]})).rejects.toThrow("visible messages");
});
test("thread CLI returns a session receipt and task CLI accepts binding and card preference",async()=>{
  const f=fixture();
  const app=new Hono<{Variables:{lunaAccessTokenClaims:LunaAccessTokenClaims}}>();
  app.use("*",async(c,next)=>{c.set("lunaAccessTokenClaims",f.claims);await next();});
  app.route("/api/runner",createRunnerOperationRoutes(f.service));
  const server=Bun.serve({port:0,fetch:req=>app.fetch(req)});
  const env={LUNA_SERVICE_URL:`http://127.0.0.1:${server.port}`,LUNA_ACCESS_TOKEN:"test"};
  try{
    const thread=await runRunnerOperationsCli("session",["create-thread","--json",JSON.stringify({contextMessageIds:[f.history.id]})],env);
    expect(thread.status).toBe("ok");
    const receipt=JSON.parse(thread.output!);
    const task=await runRunnerOperationsCli("task",["create","--request-id","cli-task","--json",JSON.stringify({title:"CLI task",summary:"Execute",facts:[],sessionId:receipt.targetSessionId,sendStatusCard:false})],env);
    expect(task.status).toBe("ok");
    await f.supervisor.waitForIdle();
    expect(f.channel.outbound).toHaveLength(0);
  }finally{server.stop(true);}
});
test("failed historical card recovery does not abort service startup",async()=>{
  const f=fixture();
  f.channel.send=async()=>{throw Error("provider unavailable");};
  await f.service.execute(f.claims,"task.create","failed-card",{title:"Card failure",summary:"Execute",facts:[],sendStatusCard:true});
  await f.supervisor.waitForIdle();
  const {TaskRunNotificationRecovery}=await import("../../src/tasks/task-run-notification-recovery");
  const recovery=new TaskRunNotificationRecovery({db:f.db,channelForNotification:()=>f.channel});
  expect(await recovery.recoverPending()).toBe(0);
  expect(f.db.select().from(schema.taskRunNotifications).all()[0]?.status_message_id).toBeNull();
});
test("status-card fills a missing terminal card, refreshes it, and resends idempotently without another run",async()=>{
  const f=fixture();
  const task=await f.service.execute(f.claims,"task.create","create",{title:"Completed",summary:"Done",facts:[],sendStatusCard:false});
  await f.supervisor.waitForIdle();
  const taskId=task.taskIds[0]!;
  const first=await f.service.execute(f.claims,"task.status_card","show",{taskId});
  expect(first.statusMessageId).toBeTruthy();
  expect(f.channel.outbound[0]).toMatchObject({statusCardState:"terminal",statusCard:{status:"completed"}});
  expect(await f.service.execute(f.claims,"task.status_card","show",{taskId})).toEqual(first);
  expect(f.channel.outbound).toHaveLength(1);
  const refresh=await f.service.execute(f.claims,"task.status_card","refresh",{taskId});
  expect(refresh.statusMessageId).toBe(first.statusMessageId);
  expect(f.channel.outbound.at(-1)?.replyMode).toBe("update_status_card");
  const resend=await f.service.execute(f.claims,"task.status_card","resend",{taskId,resend:true});
  expect(resend.statusMessageId).not.toBe(first.statusMessageId);
  const count=f.channel.outbound.length;
  expect(await f.service.execute(f.claims,"task.status_card","resend",{taskId,resend:true})).toEqual(resend);
  expect(f.channel.outbound).toHaveLength(count);
  expect(f.db.select().from(schema.taskRuns).all()).toHaveLength(1);
  expect(f.db.select().from(schema.taskRunNotifications).all()[0]).toMatchObject({status_message_id:resend.statusMessageId,state:"terminal"});
  expect(f.db.select().from(schema.taskSubscriptions).all()[0]?.notification_level).toBe("major_updates");
  await expect(f.service.execute(f.claims,"task.status_card","resend",{taskId,resend:false})).rejects.toThrow("different operation");
});
test("running-task progress and completion follow the replacement card",async()=>{
  let finish!:()=>void;
  const hold=new Promise<void>(resolve=>{finish=resolve;});
  const f=fixture(hold);
  const task=await f.service.execute(f.claims,"task.create","create",{title:"Running",summary:"Execute",facts:[],sendStatusCard:false});
  const taskId=task.taskIds[0]!;
  try {
    await f.service.execute(f.claims,"task.status_card","show",{taskId});
    const replacement=await f.service.execute(f.claims,"task.status_card","resend",{taskId,resend:true});
    const {TimelineStore}=await import("../../src/timeline/timeline-store");
    new TimelineStore(f.db).append({taskId,type:"runner.step",summary:"Progress after replacement",data:{taskRunId:task.runId}});
    await f.cards.onRunProgress({taskRunId:task.runId!});
    expect(f.channel.outbound.at(-1)?.replyMode).toBe("update_status_card");
    const before=f.channel.outbound.length;
    finish();await f.supervisor.waitForIdle();
    expect(f.channel.outbound.length).toBeGreaterThan(before);
    expect(f.db.select().from(schema.taskRunNotifications).all()[0]).toMatchObject({status_message_id:replacement.statusMessageId,state:"terminal"});
    // Session dispatcher translates logical card IDs to the newest provider card.
    const creations=f.channel.outbound.filter(o=>o.replyMode!=="update_status_card");
    expect(creations).toHaveLength(2);
    expect(f.channel.outbound.at(-1)?.targetMessageId).toBe(creations[1]!.id);
    expect(f.db.select().from(schema.taskRuns).all()).toHaveLength(1);
  } finally {finish();await f.supervisor.waitForIdle();}
});
test("ambiguous card delivery replays its frozen payload and catches up progress",async()=>{
  let finish!:()=>void;
  const f=fixture(new Promise<void>(resolve=>{finish=resolve;}));
  const task=await f.service.execute(f.claims,"task.create","create",{title:"Retry",summary:"Execute",facts:[],sendStatusCard:false});
  const original=f.channel.send.bind(f.channel);
  let fail=true;
  f.channel.send=async(inbound,operation)=>{
    const receipt=await original(inbound,operation);
    if(fail){fail=false;throw Error("receipt lost");}
    return receipt;
  };
  try {
    await expect(f.service.execute(f.claims,"task.status_card","retry",{taskId:task.taskIds[0]})).rejects.toThrow("receipt lost");
    const {TimelineStore}=await import("../../src/timeline/timeline-store");
    new TimelineStore(f.db).append({taskId:task.taskIds[0]!,type:"runner.step",summary:"More progress",data:{taskRunId:task.runId}});
    const receipt=await f.service.execute(f.claims,"task.status_card","retry",{taskId:task.taskIds[0]});
    expect(receipt.status).toBe("applied");
    expect(f.channel.outbound.filter(o=>o.replyMode!=="update_status_card")).toHaveLength(1);
    expect(f.channel.outbound.at(-1)?.statusCardSteps?.some(step=>JSON.stringify(step).includes("More progress"))).toBe(true);
  } finally {finish();await f.supervisor.waitForIdle();}
});
test("status-card CLI supports task-id and resend flags",async()=>{
  const f=fixture();
  const task=await f.service.execute(f.claims,"task.create","create",{title:"CLI card",summary:"Done",facts:[],sendStatusCard:false});
  await f.supervisor.waitForIdle();
  const app=new Hono<{Variables:{lunaAccessTokenClaims:LunaAccessTokenClaims}}>();
  app.use("*",async(c,next)=>{c.set("lunaAccessTokenClaims",f.claims);await next();});
  app.route("/api/runner",createRunnerOperationRoutes(f.service));
  const server=Bun.serve({port:0,fetch:req=>app.fetch(req)});
  try {
    const response=await runRunnerOperationsCli("task",["status-card","--task-id",task.taskIds[0]!,"--resend","--request-id","cli-resend","--style","native"],{LUNA_SERVICE_URL:`http://127.0.0.1:${server.port}`,LUNA_ACCESS_TOKEN:"test"});
    expect(response.status).toBe("ok");
    expect(JSON.parse(response.output!)).toMatchObject({status:"applied",statusMessageId:expect.any(String)});
    expect(f.channel.outbound.at(-1)?.statusCardStyle).toBe("native");
  }finally{server.stop(true);}
});
test("terminal transition during card delivery is reflected before the command completes",async()=>{
  let finish!:()=>void;
  const f=fixture(new Promise<void>(resolve=>{finish=resolve;}));
  const task=await f.service.execute(f.claims,"task.create","create",{title:"Race",summary:"Execute",facts:[],sendStatusCard:false});
  let deliver!:()=>void;
  let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{deliver=resolve;});
  const original=f.channel.send.bind(f.channel);
  let first=true;
  f.channel.send=async(inbound,operation)=>{
    if(first){first=false;entered();await gate;}
    return original(inbound,operation);
  };
  const command=f.service.execute(f.claims,"task.status_card","race",{taskId:task.taskIds[0]});
  await started;
  finish();
  // Allow execution to settle while the card network call remains in flight.
  for(let i=0;i<20 && f.db.select().from(schema.taskRuns).all()[0]?.status==="running";i++) await Bun.sleep(1);
  deliver();
  const receipt=await command;
  await f.supervisor.waitForIdle();
  expect(receipt.status).toBe("applied");
  expect(f.channel.outbound.at(-1)?.statusCardState).toBe("terminal");
  expect(f.channel.outbound.at(-1)?.statusCard?.status).toBe("completed");
  expect(f.db.select().from(schema.taskRuns).all()).toHaveLength(1);
});
test("pending card commands recover without a live Main and unrelated task requests are rejected",async()=>{
  const f=fixture();
  const task=await f.service.execute(f.claims,"task.create","create",{title:"Recovery",summary:"Done",facts:[],sendStatusCard:false});
  await f.supervisor.waitForIdle();
  const other=f.sessions.resolveByChannelSurface({channelType:"feishu",channelId:"test",groupId:"other"});
  f.db.insert(schema.tasks).values({id:"unrelated",type:"task",title:"Other",status:"completed",primary_session_id:other.id,created_at:1,updated_at:1,last_activity_at:1, ...fixtureTaskOwnership(f.db,other.id)}).run();
  await expect(f.service.execute(f.claims,"task.status_card","denied",{taskId:"unrelated"})).rejects.toThrow("does not belong");
  const original=f.channel.send.bind(f.channel);
  f.channel.send=async()=>{throw Error("offline");};
  await expect(f.service.execute(f.claims,"task.status_card","recover",{taskId:task.taskIds[0]})).rejects.toThrow("offline");
  f.channel.send=original;
  new InvocationStore(f.db).revoke("invocation", "test exit");
  expect(await f.service.recoverPending()).toBe(1);
  expect(f.db.select().from(schema.runnerOperations).all().find(row=>row.requestId==="recover")?.status).toBe("applied");
  expect(f.db.select().from(schema.taskRuns).all()).toHaveLength(1);
});

test("native preference survives runs; switching requires replacement and closes the prior native bubble",async()=>{
  let finish!:()=>void;
  const f=fixture(new Promise<void>(resolve=>{finish=resolve;}));
  try {
    const task=await f.service.execute(f.claims,"task.create","native-create",{title:"Native task",summary:"Work",facts:[],sendStatusCard:true,statusCardStyle:"native"});
    expect(f.channel.outbound[0]?.statusCardStyle).toBe("native");
    expect(f.db.select().from(schema.taskSubscriptions).all()[0]?.status_card_style).toBe("native");
    await expect(f.service.execute(f.claims,"task.status_card","switch-bad",{taskId:task.taskIds[0],style:"card"})).rejects.toThrow("requires --resend");
    const switched=await f.service.execute(f.claims,"task.status_card","switch",{taskId:task.taskIds[0],style:"card",resend:true});
    expect(switched.status).toBe("applied");
    expect(f.channel.outbound.at(-2)).toMatchObject({statusCardStyle:"native",statusCardState:"terminal"});
    expect(f.channel.outbound.at(-1)).toMatchObject({statusCardStyle:"card",statusCardState:"active"});
    expect(f.db.select().from(schema.taskSubscriptions).all()[0]?.status_card_style).toBe("card");
  }finally{finish();await f.supervisor.waitForIdle();}
});
test("silent native preference can be enabled later and retained on restart",async()=>{
  const f=fixture();
  const task=await f.service.execute(f.claims,"task.create","silent-native",{title:"Native task",summary:"Work",facts:[],sendStatusCard:false,statusCardStyle:"native"});
  await f.supervisor.waitForIdle();
  expect(f.channel.outbound).toHaveLength(0);
  await f.service.execute(f.claims,"task.status_card","enable",{taskId:task.taskIds[0]});
  expect(f.channel.outbound.at(-1)?.statusCardStyle).toBe("native");
  await f.service.execute(f.claims,"task.restart","restart-native",{taskId:task.taskIds[0]});
  await f.supervisor.waitForIdle();
  expect(f.channel.outbound.every(o=>o.statusCardStyle==="native")).toBe(true);
  expect(f.db.select().from(schema.taskRunNotifications).all().every(n=>n.status_card_style==="native")).toBe(true);
});

test("new tasks default to sending native progress and explicit card style is retained",async()=>{
  const f=fixture();
  await f.service.execute(f.claims,"task.create","default-native",{title:"Default progress",summary:"Execute",facts:[]});
  await f.supervisor.waitForIdle();
  expect(f.channel.outbound[0]).toMatchObject({statusCardStyle:"native",statusCardState:"active"});
  expect(f.db.select().from(schema.taskSubscriptions).all()[0]).toMatchObject({status_card_style:"native",notification_level:"major_updates"});
  const offset=f.channel.outbound.length;
  await f.service.execute(f.claims,"task.create","explicit-card",{title:"Custom card",summary:"Execute",facts:[],statusCardStyle:"card"});
  await f.supervisor.waitForIdle();
  expect(f.channel.outbound[offset]?.statusCardStyle).toBe("card");
});

test("cancel CLI stops one run, closes its card, and replay cannot cancel a later explicit restart", async () => {
  let release!: () => void;
  const f = fixture(new Promise<void>(resolve => { release = resolve; }));
  const app = new Hono<{Variables: {lunaAccessTokenClaims: LunaAccessTokenClaims}}>();
  app.use("*", async (c, next) => { c.set("lunaAccessTokenClaims", f.claims); await next(); });
  app.route("/api/runner", createRunnerOperationRoutes(f.service));
  const server = Bun.serve({port: 0, fetch: req => app.fetch(req)});
  try {
    const created = await f.service.execute(f.claims, "task.create", "create-cancel", {title: "Cancellable", summary: "Wait", facts: [], statusCardStyle: "card"});
    const taskId = created.taskIds[0]!;
    const body = {taskId, reason: "用户取消天气查询"};
    const result = await runRunnerOperationsCli("task", ["cancel", "--request-id", "cancel-one", "--json", JSON.stringify(body)],
      {LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test"});
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.output!)).toMatchObject({operation: "task.cancel", status: "applied", cancelled: true, runId: created.runId});
    expect(f.db.select().from(schema.tasks).get()?.status).toBe("cancelled");
    expect(f.db.select().from(schema.taskRuns).all()).toMatchObject([{status: "cancelled", run_index: 1}]);
    const next = await f.service.execute(f.claims, "task.restart", "explicit-restart", {taskId});
    expect(next.runId).not.toBe(created.runId);
    expect(await f.service.execute(f.claims, "task.cancel", "cancel-one", body)).toMatchObject({cancelled: true, runId: created.runId});
    expect(f.db.select().from(schema.taskRuns).where(eq(schema.taskRuns.id, next.runId!)).get()?.status).toBe("running");
    f.supervisor.cancelTaskRun({taskId, runId: next.runId!, reason: "test cleanup"});
    release(); await f.supervisor.waitForIdle();
    expect(f.reports).toHaveLength(0);
    expect(f.channel.outbound.some(op => op.statusCard?.status === "cancelled" && op.content.includes("用户取消天气查询"))).toBe(true);
    expect(f.channel.outbound.filter(op => op.statusCard?.status === "completed")).toHaveLength(0);
  } finally { release(); await f.supervisor.waitForIdle(); server.stop(true); }
});

test("cancel preparation snapshots the run and completed/foreign tasks are not changed", async () => {
  let release!: () => void;
  const f = fixture(new Promise<void>(resolve => { release = resolve; }));
  const {TaskCommandService} = await import("../../src/tasks/task-command-service");
  try {
    const created = await f.service.execute(f.claims, "task.create", "cancel-race", {title: "Finishing", summary: "Finish", facts: []});
    const request = {kind: "task.cancel" as const, payload: {taskId: created.taskIds[0]!, reason: "Stop"}};
    const context = {sessionId: f.session.id, originId: "origin", actorUserId: "user", inbound: f.inbound, sourceMessageIds: []};
    const domain = new TaskCommandService(f.db, f.supervisor);
    const prepared = domain.prepare("cancel-operation", request, context);
    release(); await f.supervisor.waitForIdle();
    expect(domain.dispatch(request, context, prepared)).toMatchObject({cancelled: false});
    expect(f.db.select().from(schema.tasks).get()?.status).toBe("completed");
    fixtureSessionOwnership(f.db,"test","other");
    const foreign = f.sessions.resolveByChannelSurface({channelType: "test", channelId: "other", groupId: "other"});
    expect(() => domain.prepare("foreign", request, {...context, sessionId: foreign.id})).toThrow("task_scope_mismatch");
    expect(f.db.select().from(schema.taskRuns).all()).toHaveLength(1);
  } finally { release(); await f.supervisor.waitForIdle(); }
});

test.each(["topic", "group"] as const)("%s handoff invokes target Main; its opening precedes its task and progress card", async destination => {
  const f = fixture();
  const {SessionCommandService, registerSessionCommands} = await import("../../src/messaging/session-command-service");
  const {createSessionTriggerExecutor} = await import("../../src/sessions/trigger-executor");
  let targetId = "";
  if (destination === "topic") {
    const thread = await f.service.execute(f.claims, "session.create_thread", "delegated-topic", {
      anchorMessageId: f.anchor.id, contextMessageIds: [f.history.id],
    });
    targetId = thread.targetSessionId!;
  }
  const channel = Object.assign(f.channel, {createGroup: async () => ({externalId: "oc_handoff", kind: "group" as const})});
  let invoked = 0;
  let createdTaskId: string | undefined;
  const commandService = new SessionCommandService({db: f.db, channelFor: () => channel,
    executeTrigger: createSessionTriggerExecutor(f.db, () => ({
      run: async (input: Parameters<import("../../src/main-runner/main-runner").MainRunner["run"]>[0]) => {
        invoked++;
        expect(input.input.type).toBe("session_trigger");
        expect(input.input.context.sessionId).toBe(targetId);
        if (input.input.type !== "session_trigger") throw new Error("Expected handoff");
        expect(input.input.sourceSessionId).toBe(f.session.id);
        expect(input.input.instruction).toContain("Investigate");
        expect(JSON.stringify(input.input.context)).toContain(f.history.id);
        expect(f.db.select().from(schema.tasks).all()).toHaveLength(0);
        const claims = {...f.claims, tokenId: "target-token", sessionId: targetId, runnerJobId: input.runnerContext.id};
        f.db.insert(schema.accessTokens).values({id: claims.tokenId, agentId: claims.agentId, tokenHash: "target-hash", userId: "user", source: "runner", name: "main", role: "runner", issuedAt: 1, expiresAt: Date.now()+60000, createdAt: 1, metadataJson: {invocationId: "target-invocation"}}).run();
        const finishJob = registerTestRunnerJob(f.db, "target-invocation", claims, encodeInvocation("main", input), input.turnId!);
        const {RunnerMessageService} = await import("../../src/messaging/runner-message-service");
        const messaging = new RunnerMessageService(f.db, () => f.channel);
        expect(messaging.actor(claims)).toMatchObject({sourceSessionId: targetId, currentSessionId: targetId,
          correlationId: input.input.correlationId, hops: input.input.hops});
        const opening = await messaging.send(claims, "topic-opening", "我会在这个话题里调查，接下来创建任务。", "answer");
        for (let i = 0; i < 100 && commandService.get(opening.id)?.status !== "sent"; i++) {
          await commandService.tick();
          await Bun.sleep(2);
        }
        expect(messaging.get(claims, opening.id)).toMatchObject({status: "sent", sourceSessionId: targetId, sessionId: targetId});
        expect(f.channel.outbound).toHaveLength(1);
        const created = await f.service.execute(claims, "task.create", "target-task", {
          title: "Topic-owned task", summary: "Investigate", facts: [], sendStatusCard: true,
        });
        createdTaskId = created.taskIds[0];
        finishJob();
        return {status: "success", result: "LUNA_NOTHING_TO_SEND"};
      },
    } as unknown as import("../../src/main-runner/main-runner").MainRunner), () => "mock"),
  });
  registerSessionCommands(f.db, commandService);
  const actor = {userId: "user", sourceSessionId: f.session.id, originId: "source-turn"};
  if (destination === "group") {
    const group = commandService.accept(actor, f.session.id, "group.create", "group-create", {
      content: "New group", group: {channelId: "test", name: "New group", idType: "open_id", memberIds: ["ou_member"]},
    });
    await commandService.waitForIdle();
    expect(commandService.get(group.id)?.status).toBe("completed");
    expect(invoked).toBe(0);
    targetId = (commandService.get(group.id)!.payload.result as {sessionId: string}).sessionId;
  }

  expect(targetId).not.toBe("");
  const handoff = commandService.accept(actor, targetId, "session.invoke", "topic-handoff", {content: "Investigate; send the opening first, then create the Task here."});
  expect(f.channel.outbound).toHaveLength(0);
  expect(f.db.select().from(schema.tasks).all()).toHaveLength(0);
  await commandService.waitForIdle();
  await f.supervisor.waitForIdle();
  expect(commandService.get(handoff.id)?.status).toBe("completed");
  expect(invoked).toBe(1);
  expect(f.channel.outbound[0]).toMatchObject({content: "我会在这个话题里调查，接下来创建任务。", replyMode: destination === "topic" ? "reply_in_thread" : "channel_message", ...(destination === "topic" ? {targetMessageId: "om_anchor"} : {})});
  expect(f.channel.outbound.slice(1).some(item => item.statusCard)).toBe(true);
  expect(f.db.select().from(schema.tasks).all()).toMatchObject([{id: createdTaskId, primary_session_id: targetId}]);
  const taskOps = f.db.select().from(schema.runnerOperations).all().filter(row => row.request.kind === "task.create");
  expect(taskOps).toHaveLength(1);
  expect(new ContextPackStore(f.db).listTaskSourceItems().filter(item => item.taskId === createdTaskId).map(item => item.sourceMessageId)).toContain(f.history.id);
  expect(taskOps[0]).toMatchObject({sessionId: targetId, originId: handoff.id});
  expect(commandService.accept(actor, targetId, "session.invoke", "topic-handoff", {content: "Investigate; send the opening first, then create the Task here."}).id).toBe(handoff.id);
  await commandService.waitForIdle();
  expect(invoked).toBe(1);
  expect(f.db.select().from(schema.tasks).all()).toHaveLength(1);
});

test("topic creation restores the automatic five-message window and explicit supplements", async () => {
  const f = fixture(), store = new MessageStore(f.db);
  const rows = Array.from({length: 7}, (_, i) => store.append({sessionId: f.session.id, channelMessageKey: `om_window_${i}`, role: "user", senderUserId: "user", channel: f.inbound.channel, content: [{type: "text", text: `Window ${i}`}]}));
  const payload = {anchorMessageId: rows[6]!.id, contextMessageIds: [f.history.id, rows[5]!.id]};
  const receipt = await f.service.execute(f.claims, "session.create_thread", "window-topic", payload);
  const packs = new ContextPackStore(f.db);
  const pack = packs.listPacksForOwner("session", receipt.targetSessionId!).find(pack => pack.kind === "thread_launch")!;
  expect(packs.listItemsForPack(pack.id).map(item => item.sourceMessageId)).toEqual([...rows.slice(2).map(row => row.id), f.history.id]);
  expect(pack.triggerMessageId).toBe(rows[6]!.id);
  store.append({sessionId: f.session.id, channelMessageKey: "om_late", role: "user", senderUserId: "user", channel: f.inbound.channel, content: [{type: "text", text: "Later"}]});
  expect(await f.service.execute(f.claims, "session.create_thread", "window-topic", payload)).toEqual(receipt);
  expect(packs.listPacksForOwner("session", receipt.targetSessionId!)).toHaveLength(1);
});

test("the Dashboard shows the record of a Task command as that Task's command, not as a user message",async()=>{
  const f=fixture();
  const created=await f.service.execute(f.claims,"task.create","dashboard-line",{title:"Line task",summary:"Look into playback",facts:[],sendStatusCard:false});
  const taskId=created.taskIds[0]!;
  const record=f.db.select().from(schema.messages).all().find(row=>(row.rawPayloadJson as {origin?:string}|null)?.origin==="runner_operation")!;
  const taskRows=f.db.select().from(schema.tasks).all();
  const sourceContextItems=new ContextPackStore(f.db).listTaskSourceItems();
  expect(taskCommandPresentation(record,{taskRows,sourceContextItems})).toEqual({kind:"task_command",action:"create",task:{id:taskId,title:"Line task"}});
  expect(taskCommandPresentation(f.anchor as never,{taskRows,sourceContextItems})).toBeUndefined();
});
