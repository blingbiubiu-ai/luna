import {fixtureArtifact} from "../helpers/platform-fixtures";
import {fixtureRunnerContext} from "../helpers/platform-fixtures";
import {SessionCommandService} from "@/messaging/session-command-service";
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
import {fixtureScope} from "../helpers/platform-fixtures";
let home:string,connection:DataConnection<typeof schema>,scope:ReturnType<typeof fixtureScope>;
let first:string,second:string,resolver:TaskResolver;
const owner="task-owner";
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-platform-context-"));setLunaHome(home);connection=new DataConnection(schema);
 scope=fixtureScope(connection.db,owner);const agents=new AgentStore(connection.db);
 const shadow=agents.createShadow(owner,scope.agentId,{name:"Other"},"other");
 const sessions=new SessionStore(connection.db);first=sessions.createLocalSession(owner,scope).id;
 second=sessions.createLocalSession(owner,{...scope,shadowId:shadow.id}).id;resolver=new TaskResolver(connection.db);
});
afterEach(()=>{connection.close();rmSync(home,{recursive:true,force:true});});
function source(sessionId:string){
 const message=new MessageStore(connection.db).append({sessionId,senderUserId:owner,role:"user",content:{text:"task source"}});
 return {sessionId,messageId:message.id};
}

function pack(ownerId=first){return new ContextPackStore(connection.db).createPack({ownerType:"session",ownerId,kind:"session_launch",selectionStrategy:"test"});}
function item(messageId:string){return {itemKind:"message",itemId:messageId,role:"context",reason:"test"};}

test("context creation rejects missing owners and foreign trigger provenance",()=>{
 const foreign=source(second);
 expect(()=>pack("missing-session")).toThrow("session_not_found");
 expect(()=>new ContextPackStore(connection.db).createPack({ownerType:"session",ownerId:first,kind:"session_launch",selectionStrategy:"test",triggerMessageId:foreign.messageId})).toThrow("task_scope_mismatch");
 expect(connection.db.select().from(schema.contextPacks).all()).toHaveLength(0);
});
test("generic item insertion checks actual message owner and rolls back the batch",()=>{
 const local=source(first),foreign=source(second),target=pack(),packs=new ContextPackStore(connection.db);
 expect(()=>packs.addItems(target.id,[item(local.messageId),{...item(foreign.messageId),sourceSessionId:first}])).toThrow("task_scope_mismatch");
 expect(packs.listItemsForPack(target.id)).toHaveLength(0);
 packs.addItems(target.id,[item(local.messageId)]);
 expect(packs.listItemsForPack(target.id)).toHaveLength(1);
});
test("timeline IDs and source message IDs must describe the same stored fact",()=>{
 const one=source(first),two=source(first),packs=new ContextPackStore(connection.db),target=pack();
 const entry=connection.db.select().from(schema.sessionTimelineEntries).where(eq(schema.sessionTimelineEntries.messageId,one.messageId)).get()!;
 const otherEntry=connection.db.select().from(schema.sessionTimelineEntries).where(eq(schema.sessionTimelineEntries.messageId,two.messageId)).get()!;
 expect(()=>packs.addItems(target.id,[{itemKind:"timeline_entry",itemId:entry.id,sourceMessageId:two.messageId,role:"context",reason:"forged"}])).toThrow("context_provenance_mismatch");
 expect(()=>packs.addItems(target.id,[{itemKind:"timeline_entry",itemId:entry.id,sourceEntryId:otherEntry.id,role:"context",reason:"forged"}])).toThrow("context_provenance_mismatch");
 expect(()=>packs.addItems(target.id,[{...item(one.messageId),sourceEntryId:"nonexistent"}])).toThrow("context_entry_unavailable");
});
test("artifact context resolves stored ownership instead of trusting supplied source session",()=>{
 connection.db.insert(schema.managedArtifacts).values(fixtureArtifact(connection.db, {id:"foreign-artifact",scope_type:"session",scope_id:second,producer:"test",kind:"file",name:"private.txt",storage_key:"private",created_at:Date.now()})).run();
 const packs=new ContextPackStore(connection.db),target=pack();
 expect(()=>packs.addItems(target.id,[{itemKind:"artifact",itemId:"foreign-artifact",sourceSessionId:first,role:"context",reason:"forged"}])).toThrow("task_scope_mismatch");
 expect(()=>packs.moveOwnerPacksToCanonicalSession(first,second)).toThrow("task_scope_mismatch");
 expect(()=>packs.moveSourceSessionReferences(first,second)).toThrow("task_scope_mismatch");
});
test("runner seed cannot borrow another owner's context or a different pack's items",()=>{
 const packs=new ContextPackStore(connection.db),target=pack(),other=pack();
 const message=source(first);const [stored]=packs.addItems(other.id,[item(message.messageId)]);
 connection.db.insert(schema.runnerContexts).values(fixtureRunnerContext(connection.db, {id:"runner",owner_type:"session",owner_id:first,runner_type:"mock",runner_root_path:"/tmp/test",created_at:1,updated_at:1})).run();
 const seed={runnerContextId:"runner",ownerType:"session" as const,ownerId:first,seedContextPackId:target.id,seedHash:"hash",seedEntryIdsJson:[],seedContextItemIdsJson:[]};
 expect(()=>packs.recordSeed({...seed,ownerId:second})).toThrow("context_seed_owner_mismatch");
 expect(()=>packs.recordSeed({...seed,seedContextItemIdsJson:[stored!.id]})).toThrow("context_seed_item_mismatch");
 expect(packs.recordSeed(seed).ownerId).toBe(first);
});

test("durable session commands reject cross Shadow sends and invokes before acceptance",()=>{
 const service=new SessionCommandService({db:connection.db,channelFor:()=>undefined});
 const actor={userId:owner,sourceSessionId:first,originId:"turn"};
 expect(()=>service.accept(actor,second,"message.send","send",{content:"private"})).toThrow("task_scope_mismatch");
 expect(()=>service.accept(actor,second,"session.invoke","invoke",{content:"execute"})).toThrow("task_scope_mismatch");
 expect(connection.db.select().from(schema.sessionCommands).all()).toHaveLength(0);
});

test("queued commands recheck actor status before any delivery",async()=>{
 fixtureScope(connection.db,"member");
 const service=new SessionCommandService({db:connection.db,channelFor:()=>{throw new Error("must not reach delivery");}});
 const command=service.accept({userId:"member",sourceSessionId:first,originId:"turn"},first,"message.send","queued",{content:"queued reply"});
 connection.db.update(schema.users).set({status:"disabled"}).where(eq(schema.users.id,"member")).run();
 await service.waitForIdle();
 expect(service.get(command.id)?.status).toBe("failed");
 expect(service.get(command.id)?.error).toContain("active_user_required");
});
