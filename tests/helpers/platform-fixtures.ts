import {AgentProfileStore, ActiveAgentConfigService} from "../../src/agent-config";
import {executionReference} from "../../src/agent-config/execution-reference";
import {runnerContexts} from "../../src/data/schema";
import {TaskScopeResolver} from "../../src/agents/task-scope";
import {sessions} from "../../src/data/schema";
import {eq} from "drizzle-orm";
import {AgentSecretCipher} from "../../src/agent-config";
import {BotBindingStore} from "../../src/agents/bot-binding-store";
import {channelConfigs, channelUserBindings} from "../../src/data/schema";
import type { DrizzleDB } from "../../src/data";
import { users } from "../../src/data/schema";
import { feishuIdentityMetadata } from "../../src/identity/feishu-identity-scopes";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { AgentStore } from "../../src/agents/agent-store";
import { AccountStore } from "../../src/identity/account-store";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";

/** Signs an account in, as the Dashboard does on first login. */
export function fixtureAccount(db: DrizzleDB, accountId: string) {
  return new AccountStore(db).ensure({id: accountId, name: accountId});
}

/**
 * The owner's user in a fixture Agent is named `user:<account>`, distinct from
 * the account id, so a test cannot pass one where the other is meant.
 */
export function fixtureOwnerUserId(accountId: string) {
  return `user:${accountId}`;
}

/** Explicit test tenant; never used by production as a default scope. */
export function fixtureAgent(db: DrizzleDB, ownerAccountId = "fixture-owner") {
  fixtureAccount(db, ownerAccountId);
  const agent = new AgentStore(db).create(ownerAccountId, {name: "Test Agent"}, "fixture-agent");
  const ownerUserId = new AgentStore(db).ownerUserId(agent.id), named = fixtureOwnerUserId(ownerAccountId);
  if (ownerUserId !== named && !db.select({id: users.id}).from(users).where(eq(users.id, named)).get()) {
    db.update(users).set({id: named}).where(eq(users.id, ownerUserId)).run();
  }
  return agent;
}

/** A human user of an Agent who is not its owner, as a channel sender would be. */
export function fixtureUser(db: DrizzleDB, agentId: string, userId: string, kind: "human" | "bot" = "human", displayName = userId) {
  const now = String(Date.now());
  db.insert(users).values({id: userId, agentId, kind, displayName, status: "active", createdAt: now, updatedAt: now})
    .onConflictDoNothing().run();
  return userId;
}

export function fixturePlatformAdmin(db: DrizzleDB, accountId: string) {
  fixtureAccount(db, accountId);
  new AuthorizationRuleStore(db, {kind: "platform"}).addGrant({
    subjectType: "user", subjectId: accountId, target: "system.admin", effect: "allow",
  });
}

/** Explicit Dashboard scope for a test's human owner. */
export function fixtureScope(db: DrizzleDB, ownerAccountId = "fixture-owner") {
  const agent = fixtureAgent(db, ownerAccountId);
  return {agentId: agent.id, shadowId: agent.defaultShadowId, ownerUserId: new AgentStore(db).ownerUserId(agent.id)};
}

/** Creates explicit ownership for raw session rows used by persistence tests. */
export function fixtureSessionOwnership(db: DrizzleDB, channelType: string, channelId: string, ownerAccountId = "fixture-owner") {
  const scope = fixtureScope(db, ownerAccountId);
  const agents = new AgentStore(db);
  if (channelType === "dashboard") return {agent_id: scope.agentId,shadow_id:scope.shadowId,binding_id:null,bot_user_id:agents.shadow(scope.shadowId).replyUserId};
  const shadow = agents.createShadow(ownerAccountId,scope.agentId,{name:channelId},`channel:${channelType}:${channelId}`);
  const cipher=AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:Buffer.alloc(32,5).toString("base64")});
  db.insert(channelConfigs).values({id:channelId,agentId:scope.agentId,type:channelType,name:channelId,appId:`test:${channelType}:${channelId}`,
    secret:cipher.encrypt({profileId:channelId,revisionId:"channel-v1",key:"app_secret",plaintext:"fixture-secret"}),updatedAt:Date.now()}).onConflictDoNothing().run();
  const binding=new BotBindingStore(db).bind(ownerAccountId,shadow.id,channelId);
  return {agent_id:scope.agentId,shadow_id:shadow.id,binding_id:binding.id,bot_user_id:shadow.replyUserId};
}

export function fixtureFeishuSender(channelId: string, externalId: string) {
  return {
    externalId, kind: "user" as const,
    ...feishuIdentityMetadata({environment: "feishu", appId: `test:feishu:${channelId}`}, {open_id: externalId}),
  };
}

/** Creates the persisted channel identity used by ingress fixtures. */
export function fixtureObserveFeishuSender(db: DrizzleDB, channelId: string, externalId: string) {
  const observed = new ChannelDirectoryStore(db).upsertIdentity({
    channel: {type: "feishu", id: channelId},
    identity: fixtureFeishuSender(channelId, externalId),
  });
  const member = db.select().from(channelUserBindings).where(eq(channelUserBindings.channelIdentityId, observed.id)).get();
  if (!member) throw new Error("Feishu fixture did not resolve a canonical user");
  return member.userId;
}

/** Raw task fixtures inherit their explicit primary session, or a dedicated test scope. */
export function fixtureTaskOwnership(db:DrizzleDB,sessionId?:string|null){
  if(sessionId){
    const session=db.select().from(sessions).where(eq(sessions.id,sessionId)).get();
    if(!session)throw new Error("Missing task fixture session");
    return {agent_id:session.agent_id,shadow_id:session.shadow_id};
  }
  const scope=fixtureScope(db);
  return {agent_id:scope.agentId,shadow_id:scope.shadowId};
}

/** Raw runner fixtures resolve their declared owner, just like the production store. */
export function fixtureRunnerContext<T extends {owner_type: string; owner_id: string}>(db: DrizzleDB, row: T) {
  const scope = new TaskScopeResolver(db).owner(row.owner_type, row.owner_id);
  return {...row, agent_id: scope.agentId, shadow_id: scope.shadowId};
}

/** Raw artifacts carry the actual owner scope; a user ID alone is not ownership. */
export function fixtureArtifact<T extends {scope_type: string; scope_id: string}>(db: DrizzleDB, row: T) {
  const scope = new TaskScopeResolver(db).owner(row.scope_type, row.scope_id);
  return {...row, agent_id: scope.agentId, shadow_id: scope.shadowId};
}

/** Creates an explicitly named Dashboard session for low-level runtime fixtures. */
export function fixtureNamedSession(db: DrizzleDB, id: string, actor = "user") {
  const scope = fixtureScope(db, actor);
  db.insert(sessions).values({id, agent_id: scope.agentId, shadow_id: scope.shadowId,
    bot_user_id: new AgentStore(db).shadow(scope.shadowId).replyUserId,
    channel_type: "dashboard", channel_id: "dashboard", created_by_user_id: scope.ownerUserId,
    created_at: Date.now(), updated_at: Date.now()}).run();
  return scope;
}

/** Real scoped configuration for transport fixtures; no network or external credentials. */
export function fixtureExecutionReference(db:DrizzleDB, contextId="context") {
 const context=db.select().from(runnerContexts).where(eq(runnerContexts.id,contextId)).get();
 if(!context || !["codex","claude"].includes(context.runner_type)) throw new Error("Fixture requires a real owned production-type context");
 const store=new AgentProfileStore(db,undefined,context.agent_id);
 const profile=store.listProfiles().find(p=>p.name===`transport-${context.runner_type}`) ?? store.createProfile({
  name:`transport-${context.runner_type}`,agentType:context.runner_type as "codex"|"claude",model:"fixture-model",env:{},secrets:{}});
 store.recordValidation(profile.latestRevision.id,{success:true,message:"fixture"});
 return executionReference(new ActiveAgentConfigService(db,undefined).resolveRevisionSnapshot(context.agent_id,profile.latestRevision.id));
}
