import { IdentityDirectory } from "../../../src/identity/identity-directory";
/** Integration fixtures execute commands during run(), exactly as a real Main does.
 * Declarative plans belong to tests and are never parsed by the service. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { LunaMessageIngress as Ingress, type LunaMessageIngressOptions } from "../../../src/messaging/gateway/luna-message-ingress";
import { SessionInboundRouter as Router, type SessionInboundRouterOptions } from "../../../src/work/session-inbound-router";
export { SessionTurnProcessor } from "../../../src/work/session-inbound-router";
import type { MainRunner, MainRunnerRunInput } from "../../../src/main-runner/main-runner";
import type { MainRunnerCompletion } from "../../../src/main-runner/types";
import type { DrizzleDB } from "../../../src/data";
import { sessions, tasks, users } from "../../../src/data/schema";
import { TaskCommandService } from "../../../src/tasks/task-command-service";
import { TaskRunSupervisor } from "../../../src/tasks/task-run-supervisor";
import { SessionStateStore } from "../../../src/main-runner/session-state-store";
import { sessionCommandsFor } from "../../../src/messaging/session-command-service";
import { mainMessageOrigin } from "../../../src/runners/main-invocation-registry";
import type { WorkReplyChannel } from "../../../src/work/types";
import type { ChannelAdapter } from "../../../src/channels";
import type { OperationRequest, OperationContext } from "../../../src/runners/operation-contract";
import type { TestMainPlan } from "./main-command-plan";

type TestOptions = {runTask?: (input: {taskId: string; reason: string; pendingInputs: readonly {text: string}[]}) => void | Promise<void>};
const runtimes = new WeakMap<DrizzleDB,{channels: Map<string, WorkReplyChannel>; supervisor: TaskRunSupervisor}>();
function runtime(db: DrizzleDB, supervisor?: unknown) {
 let value=runtimes.get(db);
 if(!value){value={channels:new Map(),supervisor: new TaskRunSupervisor({db,runnerType:"mock"})};runtimes.set(db,value);}
 if(supervisor instanceof TaskRunSupervisor)value.supervisor=supervisor;
 return value;
}
export function commandRunner(main: MainRunner | undefined, db: DrizzleDB): MainRunner | undefined {
 if(!main)return undefined;
 return {run: async (input: MainRunnerRunInput) => {
  const result=await main.run(input) as unknown as TestMainPlan | MainRunnerCompletion;
  if (input.signal?.aborted) throw new Error("Invocation cancelled");
  if('status' in result)return result;
  return executePlan(db,input,result);
 }} as MainRunner;
}
async function executePlan(db: DrizzleDB, input: MainRunnerRunInput, plan: TestMainPlan): Promise<MainRunnerCompletion> {
 const state=runtime(db), sessionId=input.input.context.sessionId;
 const session=db.select().from(sessions).where(eq(sessions.id,sessionId)).get()!;
 let userId=(input.input.type === "user_messages" ? input.input.requesterUserId ?? input.input.messages.at(-1)?.senderUserId : undefined) ?? (input.input.type === "task_result" ? db.select().from(tasks).where(eq(tasks.id,input.input.taskId)).get()?.creator_user_id : undefined) ?? session.created_by_user_id!;
 if (!db.select().from(users).where(eq(users.id,userId)).get()) {
   userId = new IdentityDirectory(db).materializeIdentityClaims({agentId: session.agent_id, kind: "human", displayName: userId ?? "Test requester",
     claims: [{namespace: "local", kind: "local_id", value: userId ?? "test-requester", scope: "", confidence: "manual"}]}).id;
 }
 const originId=mainMessageOrigin(input);
 const commands=sessionCommandsFor(db,id=>state.channels.get(id));
 let reply: string | undefined;
 if(plan.operation==='completion')return {status:'completed',followupReleased:plan.followupReleased === true};
 if(plan.operation==='commands.batch'){
  for(const child of plan.taskActions)await executePlan(db,input,child);
  reply=plan.reply.content;
 }else if(plan.operation==='session.clarify'){
  new SessionStateStore(db).saveClarification(sessionId,{pendingIntent:plan.pendingIntent,missingFields:plan.missingFields,collectedFacts:plan.collectedFacts,lastReply:plan.reply,reason:plan.reason});
  reply=plan.reply;
 }else if(plan.operation==='task.create'||plan.operation==='task.update'||plan.operation==='task.restart'){
  if(input.input.type!=='user_messages')throw new Error('Task fixture needs user input');
  let request: OperationRequest;
  if(plan.operation==='task.create')request={kind:'task.create',payload:{title:plan.title,summary:plan.summary,facts:[...plan.facts],taskType:plan.taskType,...(plan.assumptions?{assumptions:[...plan.assumptions]}:{})}};
  else if(plan.operation==='task.update')request={kind:'task.update',payload:{taskId:plan.taskId,updateSummary:plan.updateSummary,...(plan.updatedTaskTitle?{updatedTaskTitle:plan.updatedTaskTitle}:{}),...(plan.updatedTaskSummary?{updatedTaskSummary:plan.updatedTaskSummary}:{})}};
  else request={kind:'task.restart',payload:{taskId:plan.taskId}};
  const context: OperationContext={sessionId,actorUserId:userId,originId,sourceMessageIds:input.input.messages.map(m=>m.messageId),inbound:input.input.latestMessage};
  const service=new TaskCommandService(db,state.supervisor);
  const result=db.transaction(()=>service.prepare(randomUUID(),request,context));
  service.dispatch(request,context,result);
  reply=plan.dispatchReply;
 }else reply=plan.reply;
 if(reply){const accepted=commands.accept({userId,sourceSessionId:sessionId,originId},sessionId,'message.send',randomUUID(),{content:reply,purpose:'answer'});await commands.waitForIdle();const settled=commands.get(accepted.id);if(settled && ['failed','unknown','cancelled'].includes(settled.status))throw new Error(settled.error ?? 'Message command failed');}
 return {status:'completed',followupReleased:false};
}
export class LunaMessageIngress extends Ingress {
 private readonly testDb: DrizzleDB;
 constructor(options: LunaMessageIngressOptions & TestOptions){
  runtime(options.db,options.taskRunSupervisor);
  const main=commandRunner(options.mainRunner,options.db);
  super({...options,taskRunSupervisor:runtime(options.db).supervisor,...(main?{mainRunner:main}:{})});this.testDb=options.db;
 }
 override async registerChannel(channel: ChannelAdapter){runtime(this.testDb).channels.set(channel.id,channel);return super.registerChannel(channel);}
 override async handleInboundMessageForTest(channel: ChannelAdapter,message: Parameters<Ingress['handleInboundMessageForTest']>[1]) {runtime(this.testDb).channels.set(channel.id,channel);return super.handleInboundMessageForTest(channel,message);}
}
export class SessionInboundRouter extends Router {
 constructor(options: SessionInboundRouterOptions & TestOptions){
  runtime(options.db,options.taskRunSupervisor).channels.set((options.channel as {id?: string}).id ?? "feishu-main",options.channel);
  const main=commandRunner(options.mainRunner,options.db);
  super({...options,taskRunSupervisor:runtime(options.db).supervisor,...(main?{mainRunner:main}:{})});
 }
}
