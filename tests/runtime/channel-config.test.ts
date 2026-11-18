import { beforeEach,afterEach,test,expect } from "bun:test";
import { mkdtempSync,rmSync } from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Hono} from "hono";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentSecretCipher} from "@/agent-config";
import {ChannelConfigStore} from "@/channels/config-store";
import {createChannelConfigRoutes} from "@/server/routes/channel-config";
import {AgentStore} from "@/agents/agent-store";
import {AgentLifecycleStore} from "@/agents/agent-lifecycle-store";
import {BotBindingStore} from "@/agents/bot-binding-store";
import {SessionStore} from "@/sessions/session-store";
import {fixtureAgent} from "../helpers/platform-fixtures";
let agentId:string,shadowId:string;
const actor="config-owner";
const scoped=()=>({...input,agentId,shadowId});
let home:string,db:DataConnection<typeof schema>,store:ChannelConfigStore,verified:string[];
const input={id:"feishu-test",name:"Team bot",appId:"cli_test",appSecret:"private-test-secret",enabled:true};
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),"luna-config-"));setLunaHome(home);db=new DataConnection(schema);verified=[];agentId=fixtureAgent(db.db,actor).id;shadowId=new AgentStore(db.db).createShadow(actor,agentId,{name:"Bot Shadow"},"bot-shadow").id;store=new ChannelConfigStore(db.db,AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:Buffer.alloc(32,7).toString("base64")}),async(appId,secret)=>{verified.push(secret);if(secret==="invalid")throw new Error("invalid credentials");return {externalId:`bot-${appId}`,kind:"bot",displayName:"Feishu Name",providerIds:{open_id:`bot-${appId}`}};});});
afterEach(()=>{db.close();rmSync(home,{recursive:true,force:true});});
test("verified bots use distinct Shadow identities and keep credentials encrypted",async()=>{
 const one=await store.save(scoped(),actor);
 const second=new AgentStore(db.db).createShadow(actor,agentId,{name:"Second"},"second");
 const two=await store.save({...scoped(),shadowId:second.id,id:"second",appId:"cli_second"},actor);
 expect(one.botUserId).toBe(new AgentStore(db.db).shadow(shadowId).replyUserId);
 // The Shadow takes its verified bot's name until the owner renames it.
 expect(one.shadow).toEqual({id:shadowId,name:"Feishu Name",status:"active"});
 expect(two.botUserId).toBe(second.replyUserId);
 expect(two.botUserId).not.toBe(one.botUserId);
 const mergedBots = db.db.select().from(schema.users).where(eq(schema.users.kind, "bot")).all();
 expect(mergedBots.map(user => user.mergedIntoUserId).sort()).toEqual([one.botUserId, two.botUserId].sort());
 expect(mergedBots.every(user => user.status === "merged")).toBe(true);
 expect(db.db.select().from(schema.users).where(eq(schema.users.id,"luna:bot")).get()).toBeUndefined();
 expect(JSON.stringify(store.list())).not.toContain(input.appSecret);
 expect(JSON.stringify(db.db.select().from(schema.channelConfigs).all())).not.toContain(input.appSecret);
 expect(store.runtimeConfigs()[0]?.params.app_secret).toBe(input.appSecret);
});
test("blank secret preserves credentials, invalid changes are not persisted, offline disable works",async()=>{
 await store.save(scoped(),actor);await store.save({...scoped(),appSecret:"",name:"Renamed"},actor);expect(verified.at(-1)).toBe(input.appSecret);
 // A verified bot names its channel; a name typed in the form does not stick.
 await expect(store.save({...scoped(),appSecret:"invalid"},actor)).rejects.toThrow();expect(store.list()[0]?.name).toBe("Feishu Name");
 const count=verified.length;await store.save({...scoped(),appSecret:"",enabled:false},actor);expect(verified.length).toBe(count);expect(store.runtimeConfigs()).toHaveLength(0);
});
test("binding retirement preserves history and stops runtime loading until explicitly rebound",async()=>{
 const saved=await store.save(scoped(),actor);
 const bindings=new BotBindingStore(db.db),old=bindings.requireActive(input.id);
 bindings.retire(actor,old.id);
 expect(store.runtimeConfigs()).toHaveLength(0);
 expect(store.list()[0]?.shadow).toBeNull();
 const next=new AgentStore(db.db).createShadow(actor,agentId,{name:"Replacement"},"replacement");
 await store.save({...scoped(),shadowId:next.id},actor);
 const current=bindings.requireActive(input.id);
 expect(current.id).not.toBe(old.id);expect(current.revision).toBe(2);
 expect(db.db.select().from(schema.shadowBotBindings).where(eq(schema.shadowBotBindings.id,old.id)).get()?.shadowId).toBe(shadowId);
 expect(db.db.select().from(schema.users).where(eq(schema.users.id,saved.botUserId!)).get()?.mergedIntoUserId).toBeNull();
 expect(store.list()[0]?.botUserId).toBe(next.replyUserId);
});
test("replacing a Shadow's Feishu application preserves history and rejects old reply addresses", async () => {
 const first = await store.save(scoped(), actor);
 const agents = new AgentStore(db.db);
 const otherShadow = agents.createShadow(actor, agentId, {name:"Other Shadow"}, "other-shadow");
 const second = { ...scoped(), id:"second-bot", appId:"cli_second_bot", shadowId:otherShadow.id };
 const secondBinding = await store.save(second, actor);
 const sessions = new SessionStore(db.db);
 const oldSession = sessions.resolveByChannelSurface({channelType:"feishu",channelId:first.id,groupId:"shared-group"});
 const otherSession = sessions.resolveByChannelSurface({channelType:"feishu",channelId:second.id,groupId:"shared-group"});
 await expect(store.save({...second, shadowId}, actor)).rejects.toThrow("bot_already_bound");

 store.retire(actor, agentId, first.id, first.bindingId!);
 store.retire(actor, agentId, second.id, secondBinding.bindingId!);
 const replacement = await store.save({...second, shadowId}, actor);
 const newSession = sessions.resolveByChannelSurface({channelType:"feishu",channelId:second.id,groupId:"shared-group"});

 expect(replacement.bindingId).not.toBe(secondBinding.bindingId);
 expect(newSession).toMatchObject({shadow_id:shadowId, binding_id:replacement.bindingId, channel_id:second.id});
 expect(new Set([oldSession.id, otherSession.id, newSession.id]).size).toBe(3);
 expect(sessions.getById(oldSession.id)).toMatchObject({shadow_id:shadowId, binding_id:first.bindingId, channel_id:first.id});
 expect(sessions.getById(otherSession.id)).toMatchObject({shadow_id:otherShadow.id, binding_id:secondBinding.bindingId, channel_id:second.id});
 expect(() => sessions.requireReplyUserId(oldSession.id)).toThrow("bot_binding_required");
 expect(() => sessions.requireReplyUserId(otherSession.id)).toThrow("session_binding_mismatch");
 expect(sessions.requireReplyUserId(newSession.id)).toBe(agents.shadow(shadowId).replyUserId);
});
test("owner, default Shadow and active binding constraints are transactional",async()=>{
 const other=fixtureAgent(db.db,"other-owner");
 await expect(store.save(scoped(),"other-owner")).rejects.toThrow("agent_access_denied");
 await expect(store.save({...scoped(),shadowId:other.defaultShadowId},actor)).rejects.toThrow("scope_mismatch");
 await expect(store.save({...scoped(),shadowId:new AgentStore(db.db).get(agentId).defaultShadowId},actor)).rejects.toThrow("default_shadow_dashboard_only");
 expect(store.list()).toHaveLength(0);
 await store.save(scoped(),actor);
 await expect(store.save({...scoped(),id:"duplicate",appId:"cli_duplicate"},actor)).rejects.toThrow("shadow_already_bound");
 expect(store.list()).toHaveLength(1);
});
test("configuration endpoints require Agent owner and apply saved configuration",async()=>{
 let reloaded="";const routes=createChannelConfigRoutes({db:db.db,store,reload:async id=>{reloaded=id;}});
 expect((await routes.request("/")).status).toBe(401);
 const app=new Hono().use("*",async(c,next)=>{c.set("dashboardAuthSession" as never,{authenticated: true, account: {id:actor,name:"Owner",provider:"local"}} as never);c.set("lunaRequestAuthKind" as never,"dashboard-cookie" as never);await next();}).route("/channels",routes);
 const result=await app.request("/channels",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(scoped())});expect(result.status).toBe(200);expect(await result.text()).not.toContain(input.appSecret);expect(reloaded).toBe(input.id);
 expect((await app.request("/channels")).status).toBe(400);
 const own = await app.request(`/channels?agentId=${agentId}`);
 const binding = new BotBindingStore(db.db).requireActive(input.id);
 expect(await own.json()).toMatchObject({ channels: [{ id: input.id, bindingId: binding.id, shadow: { id: shadowId } }] });
 const foreign = fixtureAgent(db.db,"other-owner");
 expect((await app.request(`/channels?agentId=${foreign.id}`)).status).toBe(403);
 const invalid=await app.request("/channels",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...scoped(),appSecret:"invalid"})});expect(invalid.status).toBe(400);expect(await invalid.text()).not.toContain("invalid credentials");
 const sessions = new SessionStore(db.db);
 const history = sessions.resolveByChannelSurface({channelType:"feishu",channelId:input.id,groupId:"old-group"});
 const retire = (scope: string) => app.request(`/channels/${input.id}/bindings/${binding.id}?agentId=${scope}`, {method:"DELETE"});
 expect((await retire(foreign.id)).status).toBe(403);
 reloaded = "";
 expect((await retire(agentId)).status).toBe(200);
 expect(reloaded).toBe(input.id);
 expect(store.list()[0]).toMatchObject({bindingId:null,shadow:null,enabled:false});
 expect(sessions.getById(history.id)?.binding_id).toBe(binding.id);
 expect(() => sessions.requireReplyUserId(history.id)).toThrow("bot_binding_required");
 const otherShadow = new AgentStore(db.db).createShadow(actor,agentId,{name:"New bot Shadow"},"new-bot-shadow");
 const rebound = await store.save({...scoped(),shadowId:otherShadow.id},actor);
 expect(rebound.bindingId).not.toBe(binding.id);
 expect((await retire(agentId)).status).toBe(200);
 expect(store.list()[0]).toMatchObject({bindingId:rebound.bindingId,enabled:true,shadow:{id:otherShadow.id}});
 const next = sessions.resolveByChannelSurface({channelType:"feishu",channelId:input.id,groupId:"old-group"});
 expect(next.id).not.toBe(history.id);
 expect(sessions.getById(history.id)?.binding_id).toBe(binding.id);
});

test("runtime self identity refresh keeps the verified external bot display name",async()=>{
 await store.save(scoped(),actor);store.recordIdentity(input.id,{externalId:`bot-${input.appId}`,kind:"bot"},new BotBindingStore(db.db).activeForChannel(input.id)!.id);
 expect(store.list()[0]?.botIdentity?.displayName).toBe("Feishu Name");
});

test("disabled scope cannot load a bot or refresh its identity",async()=>{
 await store.save(scoped(),actor);
 db.db.update(schema.agentShadows).set({status:"disabled"}).where(eq(schema.agentShadows.id,shadowId)).run();
 expect(store.runtimeConfigs()).toHaveLength(0);
 expect(()=>store.recordIdentity(input.id,{externalId:`bot-${input.appId}`,kind:"bot"},new BotBindingStore(db.db).activeForChannel(input.id)!.id)).toThrow("shadow_disabled");
});
test("database rejects a binding across Agent boundaries",async()=>{
 await store.save(scoped(),actor);
 const other=fixtureAgent(db.db,"other-owner"), bindings=new BotBindingStore(db.db);
 bindings.retire(actor,bindings.requireActive(input.id).id);
 const foreignShadow=new AgentStore(db.db).createShadow("other-owner",other.id,{name:"Foreign"},"foreign");
 expect(()=>db.db.insert(schema.shadowBotBindings).values({id:"invalid-binding",agentId:other.id,shadowId:foreignShadow.id,
  channelConfigId:input.id,revision:2,status:"active",createdAt:Date.now()}).run()).toThrow();
});
test("provider verification cannot race another Agent's claim to a channel ID",async()=>{
 const other=fixtureAgent(db.db,"other-owner"),foreignShadow=new AgentStore(db.db).createShadow("other-owner",other.id,{name:"Foreign"},"foreign");
 let release!:()=>void;
 const wait=new Promise<void>(resolve=>{release=resolve;});
 const slow=new ChannelConfigStore(db.db,AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:Buffer.alloc(32,7).toString("base64")}),async()=>{
  await wait;return {externalId:"bot-race",kind:"bot",providerIds:{open_id:"bot-race"}};
 });
 const pending=slow.save(scoped(),actor);
 await store.save({...scoped(),agentId:other.id,shadowId:foreignShadow.id,appId:"cli_other"},"other-owner");
 release();await expect(pending).rejects.toThrow("channel_scope_mismatch");
 expect(store.list()[0]?.agentId).toBe(other.id);
});

test("late adapter identity cannot attach itself to a replacement binding", async () => {
 await store.save(scoped(),actor);
 const bindings = new BotBindingStore(db.db), prior = bindings.requireActive(input.id);
 bindings.retire(actor, prior.id);
 const replacement = new AgentStore(db.db).createShadow(actor,agentId,{name:"Replacement"},"replacement");
 bindings.bind(actor,replacement.id,input.id);
 expect(() => store.recordIdentity(input.id,{externalId:"stale-bot",kind:"bot"},prior.id)).toThrow("bot_binding_retired");
 expect(store.list()[0]?.botIdentity?.externalId).toBe(`bot-${input.appId}`);
});

test("adding a Feishu bot creates its Shadow only after verification and retries reuse it", async () => {
 const agents = new AgentStore(db.db);
 const request = {...input, agentId};
 const initialCount = agents.listShadows(actor, agentId).length;
 await expect(store.save({...request, appSecret:"invalid"}, actor)).rejects.toThrow();
 expect(agents.listShadows(actor, agentId)).toHaveLength(initialCount);
 expect(store.list()).toHaveLength(0);

 const added = await store.save(request, actor);
 // A new Shadow is called what its bot is called in Feishu.
 expect(added.shadow).toMatchObject({name: "Feishu Name", status:"active"});
 expect(agents.listShadows(actor, agentId)).toHaveLength(initialCount + 1);
 const edited = await store.save({...request, name:"Updated", appSecret:""}, actor);
 expect(edited.bindingId).toBe(added.bindingId);
 expect(edited.shadow?.id).toBe(added.shadow?.id);

 store.retire(actor, agentId, input.id, added.bindingId!);
 const rebound = await store.save({...request, appSecret:""}, actor);
 expect(rebound.bindingId).not.toBe(added.bindingId);
 expect(rebound.shadow?.id).toBe(added.shadow?.id);
 expect(agents.listShadows(actor, agentId)).toHaveLength(initialCount + 1);
});

test("a saved bot can move to an existing Shadow after its original Shadow is deleted", async () => {
 const original = await store.save(scoped(), actor);
 const agents = new AgentStore(db.db);
 const replacement = agents.createShadow(actor, agentId, {name: "Replacement"}, "replacement");
 const request = {...scoped(), shadowId: replacement.id, appSecret: ""};
 await expect(store.save(request, actor)).rejects.toThrow("bot_already_bound");
 expect(store.list()[0]?.bindingId).toBe(original.bindingId);

 new AgentLifecycleStore(db.db).request(actor, {agentId, shadowId}, "deleted", "delete-original");
 const rebound = await store.save(request, actor);
 expect(rebound.shadow?.id).toBe(replacement.id);
 expect(rebound.bindingId).not.toBe(original.bindingId);
 expect(agents.shadow(shadowId).status).toBe("deleted");
 expect(store.runtimeConfigs()).toHaveLength(1);
});
