import { feishuIdentityMetadata } from "@/identity/feishu-identity-scopes";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { channelConfigs, shadowBotBindings, agentShadows, lunaAgents } from "@/data/schema";
import { AgentSecretCipher } from "@/agent-config/secret-cipher";
import type { ChannelConfig } from "@/shared";
import { resolveDataFilePath } from "@/shared/config/paths";
import { recordShadowBotIdentity } from "@/identity/shadow-bot";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { BotBindingStore } from "@/agents/bot-binding-store";
import type { ChannelIdentity } from "./types";
export const feishuConfigInput = z.object({agentId:z.string().min(1),shadowId:z.string().min(1).optional(),id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(id=>id!=="luna-dashboard"),name:z.string().trim().min(1).max(100),appId:z.string().trim().min(1).max(150),appSecret:z.string().max(1000).optional(),chatId:z.string().trim().max(150).default(""),enabled:z.boolean().default(true)}).strict();
export type BotVerifier=(appId:string,secret:string)=>Promise<ChannelIdentity>;
export async function verifyFeishuBot(appId:string,appSecret:string):Promise<ChannelIdentity>{
  try {
    const client=new Client({appId,appSecret,loggerLevel:LoggerLevel.error,logger:{error(){},warn(){},info(){},debug(){},trace(){}}});
    const response=await client.request<{code?:number;bot?:{open_id?:string;app_name?:string;name?:string;avatar_url?:string};data?:{bot?:{open_id?:string;app_name?:string;name?:string;avatar_url?:string}}}>({url:"/open-apis/bot/v3/info",method:"GET"});
    const bot=response.bot??response.data?.bot;
    if(response.code || !bot?.open_id) throw new Error("invalid bot");
    return {externalId:bot.open_id,kind:"bot",displayName:bot.app_name??bot.name??appId,providerIds:{open_id:bot.open_id,app_id:appId},...(bot.avatar_url?{avatarUrl:bot.avatar_url}:{}),...feishuIdentityMetadata({environment:"feishu",appId},{open_id:bot.open_id})};
  } catch { throw new Error("无法验证飞书机器人，请检查 App ID、App Secret 和机器人能力。"); }
}
export function channelSecretCipher():AgentSecretCipher{
  const configured=AgentSecretCipher.tryFromEnvironment();if(configured)return configured;
  const path=resolveDataFilePath("channel-config.key");mkdirSync(dirname(path),{recursive:true});
  try{writeFileSync(path,randomBytes(32).toString("base64"),{flag:"wx",mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
  return AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY_FILE:path});
}
export class ChannelConfigStore {
 constructor(private readonly db:DrizzleDB,private readonly cipher:AgentSecretCipher=channelSecretCipher(),private readonly verify:BotVerifier=verifyFeishuBot){}
 recordIdentity(id:string,identity:ChannelIdentity,bindingId:string){
  const binding=new BotBindingStore(this.db).requireActive(id);
  if(binding.id!==bindingId)throw new AgentError("bot_binding_retired",409);
  const channel=this.db.select().from(channelConfigs).where(eq(channelConfigs.id,id)).get();
  if(!channel?.enabled)throw new AgentError("channel_disabled",409);
  const previous=channel.botIdentity;
  if(previous?.externalId===identity.externalId) identity={...previous,...identity,displayName:identity.displayName??previous.displayName??identity.externalId};
  recordShadowBotIdentity(this.db,id,identity);
  this.db.update(channelConfigs).set({botIdentity:identity}).where(eq(channelConfigs.id,id)).run();
 }
 list(){
  const bindings = new BotBindingStore(this.db);
  const agents = new AgentStore(this.db);
  return this.db.select().from(channelConfigs).all().map(({secret,...row})=>{
   const binding = bindings.activeForChannel(row.id);
   const shadow = binding ? agents.shadow(binding.shadowId) : undefined;
   return {
    ...row, hasSecret: Boolean(secret), bindingId: binding?.id ?? null, botUserId: shadow?.replyUserId ?? null,
    shadow: shadow ? { id: shadow.id, name: shadow.name, status: shadow.status } : null,
   };
  });
 }
 retire(actorUserId: string, agentId: string, channelId: string, bindingId: string) {
  return this.db.transaction(tx => {
   const db = tx as unknown as DrizzleDB;
   new AgentStore(db).requireOwner(actorUserId, agentId);
   const binding = tx.select().from(shadowBotBindings).where(eq(shadowBotBindings.id, bindingId)).get();
   if (binding?.channelConfigId !== channelId || binding.agentId !== agentId) {
    throw new AgentError("bot_binding_not_found", 404);
   }
   if (binding.status === "retired") return;
   new BotBindingStore(db).retire(actorUserId, bindingId);
   tx.update(channelConfigs).set({enabled: false, updatedAt: Date.now()}).where(eq(channelConfigs.id, channelId)).run();
  });
 }
 runtimeConfigs():ChannelConfig[]{return this.db.select({channel:channelConfigs}).from(channelConfigs)
 .innerJoin(shadowBotBindings,and(eq(shadowBotBindings.channelConfigId,channelConfigs.id),eq(shadowBotBindings.status,"active")))
 .innerJoin(agentShadows,and(eq(agentShadows.id,shadowBotBindings.shadowId),eq(agentShadows.status,"active")))
 .innerJoin(lunaAgents,and(eq(lunaAgents.id,channelConfigs.agentId),eq(lunaAgents.status,"active")))
 .where(eq(channelConfigs.enabled,true)).all().map(({channel:row})=>({id:row.id,type:row.type,name:row.name,description:"Database-managed channel",params:{app_id:row.appId,app_secret:this.decrypt(row),chat_id:row.chatId,...(row.botIdentity?{bot_open_id:row.botIdentity.externalId}:{})}}));}
 private decrypt(row:typeof channelConfigs.$inferSelect){return this.cipher.decrypt({...row.secret,profileId:row.id,revisionId:"channel-v1",key:"app_secret"});}
 async save(raw:unknown,actorUserId:string){
  const input=feishuConfigInput.parse(raw);
  const agents=new AgentStore(this.db);
  agents.requireOwner(actorUserId,input.agentId);
  if (input.shadowId) agents.requireScope(actorUserId, {agentId: input.agentId, shadowId: input.shadowId});
  const old=this.db.select().from(channelConfigs).where(eq(channelConfigs.id,input.id)).get();
  if(old&&old.agentId!==input.agentId)throw new Error("channel_scope_mismatch");
  if(old&&old.appId!==input.appId)throw new Error("已有通道不能更换 App ID，请新建通道。");
  const duplicate=this.db.select().from(channelConfigs).where(eq(channelConfigs.appId,input.appId)).get();
  if(duplicate&&duplicate.id!==input.id)throw new Error("此飞书应用已配置，请编辑已有通道。");
  const secret=input.appSecret?.trim() || (old?this.decrypt(old):"");if(!secret)throw new Error("请输入 App Secret。");
  const identity=!input.enabled&&old&&!input.appSecret ? old.botIdentity : await this.verify(input.appId,secret);
  if(identity && identity.kind!=="bot")throw new Error("应用不是机器人。");
  const encrypted=this.cipher.encrypt({profileId:input.id,revisionId:"channel-v1",key:"app_secret",plaintext:secret});
  this.db.transaction(tx=>{
    const db=tx as unknown as DrizzleDB;
    // Provider verification yields; recheck ownership against the committed row.
    const current=tx.select().from(channelConfigs).where(eq(channelConfigs.id,input.id)).get();
    if(current&&(current.agentId!==input.agentId||current.appId!==input.appId))throw new AgentError("channel_scope_mismatch",409);
    const shadowId = input.shadowId ?? this.resolveBotShadow(db, actorUserId, input);
    const bindings = new BotBindingStore(db);
    const active = bindings.activeForChannel(input.id);
    if (active && active.shadowId !== shadowId && new AgentStore(db).shadow(active.shadowId).status === "deleted") {
      bindings.retire(actorUserId, active.id);
    }
    const row={id:input.id,agentId:input.agentId,type:"feishu",name:input.name,appId:input.appId,secret:encrypted,chatId:input.chatId,enabled:input.enabled,botIdentity:identity,updatedAt:Date.now()};
    tx.insert(channelConfigs).values(row).onConflictDoUpdate({target:channelConfigs.id,set:row}).run();
    bindings.bind(actorUserId,shadowId,input.id);
    if(identity) recordShadowBotIdentity(db,input.id,identity);
  });
  return this.list().find(row=>row.id===input.id)!;
 }

 private resolveBotShadow(db: DrizzleDB, actorUserId: string, input: z.infer<typeof feishuConfigInput>): string {
  const bindings = new BotBindingStore(db);
  const active = bindings.activeForChannel(input.id);
  if (active) return active.shadowId;

  const agents = new AgentStore(db);
  const previous = db.select().from(shadowBotBindings).where(eq(shadowBotBindings.channelConfigId, input.id))
    .orderBy(desc(shadowBotBindings.revision)).get();
  if (previous && agents.shadow(previous.shadowId).status === "active") {
    const occupied = db.select({id: shadowBotBindings.id}).from(shadowBotBindings).where(and(
      eq(shadowBotBindings.shadowId, previous.shadowId), eq(shadowBotBindings.status, "active"),
    )).get();
    if (!occupied) return previous.shadowId;
  }
  return agents.createShadow(actorUserId, input.agentId, {name: input.name},
    `channel:${input.id}:${previous?.id ?? "initial"}`).id;
 }
}
