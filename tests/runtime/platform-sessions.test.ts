import {SessionAccessPolicy} from "@/agents/session-access";
import {SessionTimelineStore} from "@/sessions/session-timeline-store";
import {MessageStore} from "@/sessions/message-store";
import {LaunchContextBuilder} from "@/context/launch-context-builder";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {BotBindingStore} from "@/agents/bot-binding-store";
import {SessionStore} from "@/sessions/session-store";
import {ChannelConfigStore} from "@/channels/config-store";
import {AgentSecretCipher} from "@/agent-config";
import {fixtureScope,fixtureUser,fixtureOwnerUserId} from "../helpers/platform-fixtures";
let home:string,connection:DataConnection<typeof schema>,store:SessionStore;
let scope:ReturnType<typeof fixtureScope>;
const owner="session-owner",ownerUser=fixtureOwnerUserId(owner);
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-platform-sessions-"));setLunaHome(home);
 connection=new DataConnection(schema);scope=fixtureScope(connection.db,owner);store=new SessionStore(connection.db);
});
afterEach(()=>{connection.close();rmSync(home,{recursive:true,force:true});});
async function bot(channelId:string,shadowId?:string){
 const shadow=shadowId?new AgentStore(connection.db).shadow(shadowId):new AgentStore(connection.db).createShadow(owner,scope.agentId,{name:channelId},channelId);
 const configs=new ChannelConfigStore(connection.db,AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:Buffer.alloc(32,3).toString("base64")}),async(appId)=>({externalId:`bot-${appId}`,kind:"bot",providerIds:{open_id:`bot-${appId}`}}));
 await configs.save({id:channelId,name:channelId,appId:`app-${channelId}`,appSecret:"test-secret",agentId:scope.agentId,shadowId:shadow.id},owner);
 return shadow;
}
test("Dashboard scope is explicit and reply identity belongs to the selected Shadow",()=>{
 const local=store.createLocalSession(ownerUser,scope);
 expect(local.agent_id).toBe(scope.agentId);expect(local.shadow_id).toBe(scope.shadowId);expect(local.binding_id).toBeNull();
 expect(store.requireReplyUserId(local.id)).toBe(new AgentStore(connection.db).shadow(scope.shadowId).replyUserId);
 expect(()=>store.resolveByChannelSurface({channelType:"dashboard",channelId:"luna-dashboard"})).toThrow("explicit_dashboard_scope_required");
 const foreign=fixtureScope(connection.db,"foreign-owner");
 expect(()=>store.createLocalSession(foreign.ownerUserId,foreign)).not.toThrow();
 expect(()=>store.createLocalSession(ownerUser,{...scope,shadowId:foreign.shadowId})).toThrow("scope_mismatch");
});
test("two bots in one group keep sessions and replies isolated",async()=>{
 const a=await bot("bot-a"),b=await bot("bot-b");
 const one=store.resolveByChannelSurface({channelType:"feishu",channelId:"bot-a",groupId:"same-group"});
 const two=store.resolveByChannelSurface({channelType:"feishu",channelId:"bot-b",groupId:"same-group"});
 expect(one.id).not.toBe(two.id);expect(one.shadow_id).toBe(a.id);expect(two.shadow_id).toBe(b.id);
 expect(store.requireReplyUserId(one.id)).toBe(a.replyUserId);expect(store.requireReplyUserId(two.id)).toBe(b.replyUserId);
 expect(()=>store.bindChannelSurface(one.id,{channelType:"feishu",channelId:"bot-b",groupId:"same-group"})).toThrow("session_binding_mismatch");
});
test("rebinding creates a new surface and cannot repurpose historical conversations",async()=>{
 await bot("bot-a");const input={channelType:"feishu",channelId:"bot-a",groupId:"same-group",threadId:"same-thread"};
 const old=store.resolveByChannelSurface(input),bindings=new BotBindingStore(connection.db);
 bindings.retire(owner,old.binding_id!);
 const replacement=new AgentStore(connection.db).createShadow(owner,scope.agentId,{name:"Replacement"},"replacement");
 await bot("bot-a",replacement.id);
 const current=store.resolveByChannelSurface(input);
 expect(current.id).not.toBe(old.id);expect(current.shadow_id).toBe(replacement.id);
 expect(store.getById(old.id)?.bot_user_id).toBe(old.bot_user_id);
 expect(()=>store.requireReplyUserId(old.id)).toThrow("session_binding_mismatch");
 expect(store.channelBindings(old.id)).toHaveLength(1);
});
test("database rejects ownership mutation and forged reply authors",()=>{
 const local=store.createLocalSession(ownerUser,scope),foreign=fixtureScope(connection.db,"foreign-owner");
 expect(()=>connection.db.update(schema.sessions).set({shadow_id:foreign.shadowId}).where(eq(schema.sessions.id,local.id)).run()).toThrow("session_scope_immutable");
 expect(()=>connection.db.insert(schema.sessions).values({...local,id:"forged",bot_user_id:ownerUser}).run()).toThrow("session_scope_mismatch");
 expect(()=>store.bindBotUser(local.id,ownerUser)).toThrow("session_reply_identity_mismatch");
});

test("execution visibility respects participation and an active actor",()=>{
 const policy=new SessionAccessPolicy(connection.db);
 fixtureScope(connection.db,"member");fixtureScope(connection.db,"another-member");
 fixtureUser(connection.db,scope.agentId,"member");fixtureUser(connection.db,scope.agentId,"another-member");
 const local=store.createLocalSession("member",scope);
 expect(policy.requireAccess(ownerUser,local.id).id).toBe(local.id);
 expect(policy.requireAccess("member",local.id).id).toBe(local.id);
 expect(()=>policy.requireAccess("another-member",local.id)).toThrow("session_access_denied");
 connection.db.update(schema.users).set({status:"blocked"}).where(eq(schema.users.id,"member")).run();
 expect(()=>policy.requireAccess("member",local.id)).toThrow("active_user_required");
});
test("timeline and thread context reject cross Shadow message references",async()=>{
 const a=await bot("bot-a"),b=await bot("bot-b");
 const one=store.createLocalSession(ownerUser,{agentId:scope.agentId,shadowId:a.id});
 const two=store.createLocalSession(ownerUser,{agentId:scope.agentId,shadowId:b.id});
 const message=new MessageStore(connection.db).append({sessionId:one.id,channelMessageKey:"private-message",senderUserId:ownerUser,role:"user",content:{text:"private"}});
 expect(()=>new SessionTimelineStore(connection.db).appendReference({sessionId:two.id,messageId:message.id})).toThrow("message_reference_scope_mismatch");
 expect(()=>new LaunchContextBuilder(connection.db).buildForThreadSession({threadSessionId:two.id,rootSessionId:one.id,anchorExternalMessageId:"private-message",maxMessages:10,maxChars:1000})).toThrow("thread_context_scope_mismatch");
});

test("provider message IDs and thread anchors are isolated across binding retirement",async()=>{
 await bot("bot-a");const input={channelType:"feishu",channelId:"bot-a",groupId:"same-group"};
 const old=store.resolveByChannelSurface(input),messages=new MessageStore(connection.db);
 const historical=messages.appendOnce({sessionId:old.id,channelMessageKey:"provider-message",senderUserId:ownerUser,role:"user",content:{text:"Old private content"}}).row;
 new BotBindingStore(connection.db).retire(owner,old.binding_id!);
 const replacement=new AgentStore(connection.db).createShadow(owner,scope.agentId,{name:"Replacement"},"replacement");
 await bot("bot-a",replacement.id);
 const thread=store.resolveByChannelSurface({...input,threadId:"new-thread",rootMessageId:"provider-message"});
 expect(connection.db.select().from(schema.sessionTimelineEntries).where(eq(schema.sessionTimelineEntries.sessionId,thread.id)).all()).toHaveLength(0);
 expect(messages.findByExternalMessageId({sessionId:thread.id,...input,externalMessageId:"provider-message"})).toBeUndefined();
 const current=messages.appendOnce({sessionId:thread.id,channelMessageKey:"provider-message",senderUserId:ownerUser,role:"user",content:{text:"New content"}});
 expect(current.created).toBe(true);expect(current.row.id).not.toBe(historical.id);
 expect(messages.findByExternalMessageId({sessionId:old.id,...input,externalMessageId:"provider-message"})?.id).toBe(historical.id);
 expect(()=>messages.updateContentAndPresentation(historical.id,{sessionId:thread.id,role:"user",content:{text:"overwrite"}})).toThrow("message_scope_mismatch");
 expect(()=>connection.db.insert(schema.sessionTimelineEntries).values({id:"forged-reference",sessionId:thread.id,messageId:historical.id,entryKind:"reference",createdAt:Date.now()}).run()).toThrow("message_reference_scope_mismatch");
});
