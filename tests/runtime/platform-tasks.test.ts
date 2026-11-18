import {TaskCommandService} from "@/tasks/task-command-service";
import type {OperationContext} from "@/runners/operation-contract";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {SessionStore} from "@/sessions/session-store";
import {MessageStore} from "@/sessions/message-store";
import {TaskResolver} from "@/tasks/task-resolver";
import {TaskSubscriptionStore} from "@/tasks/task-subscription-store";
import {ContextPackStore} from "@/context/context-pack-store";
import {fixtureScope,fixtureOwnerUserId} from "../helpers/platform-fixtures";
let home:string,connection:DataConnection<typeof schema>,scope:ReturnType<typeof fixtureScope>;
let first:string,second:string,resolver:TaskResolver;
const owner="task-owner",ownerUser=fixtureOwnerUserId(owner);
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-platform-tasks-"));setLunaHome(home);connection=new DataConnection(schema);
 scope=fixtureScope(connection.db,owner);const agents=new AgentStore(connection.db);
 const shadow=agents.createShadow(owner,scope.agentId,{name:"Other"},"other");
 const sessions=new SessionStore(connection.db);first=sessions.createLocalSession(ownerUser,scope).id;
 second=sessions.createLocalSession(ownerUser,{...scope,shadowId:shadow.id}).id;resolver=new TaskResolver(connection.db);
});
afterEach(()=>{connection.close();rmSync(home,{recursive:true,force:true});});
function source(sessionId:string){
 const message=new MessageStore(connection.db).append({sessionId,senderUserId:ownerUser,role:"user",content:{text:"task source"}});
 return {sessionId,messageId:message.id};
}
const base={text:"Do work",title:"Work",workflow:"task" as const,creatorUserId:ownerUser};
test("task creation requires scope and inherits its source session",()=>{
 expect(()=>resolver.resolvePersistentTask(base)).toThrow("task_scope_required");
 const input={...base,source:source(first)};
 const created=resolver.resolvePersistentTask(input);
 expect(created.persistentTask.agent_id).toBe(scope.agentId);expect(created.persistentTask.shadow_id).toBe(scope.shadowId);
 expect(resolver.resolvePersistentTask(input).persistentTask.id).toBe(created.persistentTask.id);
 expect(resolver.resolvePersistentTask({...base,scope}).persistentTask.primary_session_id).toBeNull();
});
test("explicit IDs cannot reuse foreign tasks; mentions only search within the Shadow",()=>{
 const task=resolver.resolvePersistentTask({...base,source:source(first)}).persistentTask;
 expect(()=>resolver.resolvePersistentTask({...base,taskId:task.id,source:source(second)})).toThrow("task_scope_mismatch");
 expect(()=>resolver.resolvePersistentTask({...base,sourceTaskId:task.id,source:source(second)})).toThrow("task_scope_mismatch");
 const other=resolver.resolvePersistentTask({...base,text:`related to ${task.id}`,source:source(second)}).persistentTask;
 expect(other.id).not.toBe(task.id);expect(other.shadow_id).not.toBe(task.shadow_id);
});
test("primary session, context provenance and subscriptions cannot cross Shadows",()=>{
 const task=resolver.resolvePersistentTask({...base,source:source(first)}).persistentTask;
 expect(()=>resolver.resolvePersistentTask({...base,source:{...source(first),primarySessionId:second}})).toThrow("task_scope_mismatch");
 const other=source(second);
 expect(()=>new ContextPackStore(connection.db).appendTaskSourceItem({taskId:task.id,...other})).toThrow("task_scope_mismatch");
 expect(()=>new ContextPackStore(connection.db).appendTaskSourceItem({taskId:task.id,sessionId:first,messageId:other.messageId})).toThrow("task_scope_mismatch");
 const subscriptions=new TaskSubscriptionStore(connection.db);
 expect(()=>subscriptions.resolve({taskId:task.id,sessionId:second,channelType:"dashboard",channelId:"luna-dashboard",visibility:"full"})).toThrow("task_scope_mismatch");
 expect(subscriptions.resolve({taskId:task.id,sessionId:first,channelType:"dashboard",channelId:"luna-dashboard",visibility:"full"}).task_id).toBe(task.id);
});
test("task ownership is immutable and paused Agent rejects task creation",()=>{
 const task=resolver.resolvePersistentTask({...base,scope}).persistentTask;
 expect(()=>connection.db.update(schema.tasks).set({primary_session_id:second}).where(eq(schema.tasks.id,task.id)).run()).toThrow("task_session_scope_mismatch");
 const foreign=fixtureScope(connection.db,"foreign-owner");
 expect(()=>connection.db.update(schema.tasks).set({agent_id:foreign.agentId,shadow_id:foreign.shadowId,creator_user_id:foreign.ownerUserId}).where(eq(schema.tasks.id,task.id)).run()).toThrow("task_scope_immutable");
 connection.db.update(schema.lunaAgents).set({status:"disabled"}).where(eq(schema.lunaAgents.id,scope.agentId)).run();
 expect(()=>resolver.resolvePersistentTask({...base,scope})).toThrow("shadow_disabled");
});

test("task commands cannot redirect work or late dispatch to another Shadow",()=>{
 const fail=()=>{throw new Error("must not dispatch");};
 const commands=new TaskCommandService(connection.db,{startInitialRun:fail,restartTaskRun:fail,cancelTaskRun:fail});
 const context:OperationContext={sessionId:first,actorUserId:ownerUser,originId:"turn",sourceMessageIds:[],inbound:{
  id:"request",channel:{type:"dashboard",id:"luna-dashboard"},surface:{externalId:first,kind:"p2p"},sender:{externalId:owner,kind:"user"},text:"Work",mentions:[],addressing:{addressedToBot:true,reason:"p2p"}}};
 const request={kind:"task.create" as const,payload:{title:"Work",summary:"Work",facts:[],taskType:"task" as const,sessionId:second}};
 expect(()=>commands.prepare("cross",request,context)).toThrow("task_scope_mismatch");
 expect(connection.db.select().from(schema.tasks).all()).toHaveLength(0);
 const task=resolver.resolvePersistentTask({...base,source:source(second)}).persistentTask;
 expect(()=>commands.dispatch({kind:"task.restart",payload:{taskId:task.id}},context,{taskId:task.id,taskSessionId:second})).toThrow("task_scope_mismatch");
});
