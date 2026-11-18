import {AgentProfileStore,ActiveAgentConfigService} from "@/agent-config";
import {executionReference} from "@/agent-config/execution-reference";
import {eq} from "drizzle-orm";
import {RunnerContextStore, createSessionRunnerPaths} from "@/runners/runner-context-store";
import {fixtureRunnerContext} from "../helpers/platform-fixtures";
import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {SessionStore} from "@/sessions/session-store";
import {InvocationStore} from "@/runners/invocation-store";
import {AccessTokenService} from "@/server/auth/access-token-service";
import {ContextPackStore} from "@/context/context-pack-store";
import {fixtureScope,fixtureOwnerUserId,fixtureUser} from "../helpers/platform-fixtures";

let home: string, connection: DataConnection<typeof schema>;
let first: string, second: string, scope: ReturnType<typeof fixtureScope>;
const owner = "owner", ownerUser = fixtureOwnerUserId(owner);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-runner-scope-"));
  setLunaHome(home);
  connection = new DataConnection(schema);
  scope = fixtureScope(connection.db, owner);
  const shadow = new AgentStore(connection.db).createShadow(owner, scope.agentId, {name: "Other"}, "other");
  const sessions = new SessionStore(connection.db);
  first = sessions.createLocalSession(ownerUser, scope).id;
  second = sessions.createLocalSession(ownerUser, {...scope, shadowId: shadow.id}).id;
  for (const [id, session] of [["context", first], ["foreign", second]]) {
    connection.db.insert(schema.runnerContexts).values(fixtureRunnerContext(connection.db, {id: id!, owner_type: "session", owner_id: session!, runner_type: "mock", runner_root_path: "/unused", created_at: 1, updated_at: 1})).run();
  }
});
afterEach(() => {connection.close(); rmSync(home, {recursive: true, force: true});});
function invocation() {
  return {id: "invocation", runnerKind: "work" as const, actorUserId: ownerUser, runnerContextId: "context", sessionId: first, taskId: null, taskRunId: null, originId: "turn", contextPackIds: [], inputSnapshot: {version: 1 as const, kind: "work", input: {sessionId: first, runnerContextId: "context", turnId: "turn"}}};
}
test("invocation scope is derived from its real owner and rejects foreign context or snapshot", () => {
  const store = new InvocationStore(connection.db);
  expect(() => store.register({...invocation(), runnerContextId: "foreign"})).toThrow("invocation_context_scope_mismatch");
  const forged = invocation(); forged.inputSnapshot.input.sessionId = second;
  expect(() => store.register(forged)).toThrow("invocation_snapshot_scope_mismatch");
  expect(connection.db.select().from(schema.runnerInvocations).all()).toHaveLength(0);
  expect(store.register(invocation())).toMatchObject({agentId: scope.agentId, shadowId: scope.shadowId});
});
test("invocation cannot import another Shadow's context pack", () => {
  const pack = new ContextPackStore(connection.db).createPack({ownerType: "session", ownerId: second, kind: "session_launch", selectionStrategy: "test"});
  expect(() => new InvocationStore(connection.db).register({...invocation(), contextPackIds: [pack.id]})).toThrow("task_scope_mismatch");
});
test("runner token carries authoritative scope and disabled actor prevents issuing it again", () => {
  fixtureUser(connection.db, scope.agentId, "member");
  const service = new AccessTokenService({db: connection.db, signingSecret: "test-secret"});
  const input = {userId: "member", name: "runner", source: "runner" as const, role: "runner" as const, runnerKind: "work" as const, sourceRunnerJobId: "context", sourceSessionId: first, ttlMs: 60_000, now: Date.now()};
  const issued = service.issueToken(input);
  expect(issued.claims).toMatchObject({agentId: scope.agentId, shadowId: scope.shadowId});
  expect(issued.record).toMatchObject({agentId: scope.agentId, shadowId: scope.shadowId});
  expect(service.verifyBearer(issued.token, {now: Date.now()}).claims).toMatchObject({agentId: scope.agentId, shadowId: scope.shadowId});
  expect(() => service.issueToken({...input, sourceRunnerJobId: "foreign"})).toThrow("invocation_context_scope_mismatch");
  connection.db.update(schema.users).set({status:"blocked"}).where(eq(schema.users.id,"member")).run();
  expect(() => service.issueToken(input)).toThrow("invalid_access_token");
});


test("Runner context validates its real owner before creating any directories", () => {
  const contexts = new RunnerContextStore(connection.db);
  const missingRoot = createSessionRunnerPaths("missing-session").runnerRootPath;
  expect(() => contexts.resolveForSession("missing-session", "codex")).toThrow("session_not_found");
  expect(existsSync(missingRoot)).toBe(false);
  const resolved = contexts.resolveForSession(first, "codex");
  expect(resolved).toMatchObject({agent_id: scope.agentId, shadow_id: scope.shadowId, owner_id: first});
  expect(contexts.resolveForSession(first, "codex").id).toBe(resolved.id);
  connection.db.update(schema.agentShadows).set({status: "disabled"}).where(eq(schema.agentShadows.id, scope.shadowId)).run();
  expect(() => contexts.resolveForSession(first, "codex")).toThrow("shadow_disabled");
});

test("database rejects forged or rebound Runner context ownership", () => {
  const row = connection.db.select().from(schema.runnerContexts).where(eq(schema.runnerContexts.id, "context")).get()!;
  expect(() => connection.db.insert(schema.runnerContexts).values({...row, id: "forged", owner_id: second}).run()).toThrow("runner_context_owner_mismatch");
  expect(() => connection.db.update(schema.runnerContexts).set({owner_id: second}).where(eq(schema.runnerContexts.id, row.id)).run()).toThrow("runner_context_owner_immutable");
  expect(() => connection.db.update(schema.runnerContexts).set({shadow_id: "foreign"}).where(eq(schema.runnerContexts.id, row.id)).run()).toThrow("runner_context_owner_immutable");
});


test("invocation pins a secret-free revision across activation and rejects rebinding or deletion before settlement", () => {
 const profiles=new AgentProfileStore(connection.db,undefined,scope.agentId);
 const firstProfile=profiles.createProfile({name:"first",agentType:"codex",model:"model-first",env:{},secrets:{}});
 const secondProfile=profiles.createProfile({name:"second",agentType:"claude",model:"model-second",env:{},secrets:{}});
 for(const profile of [firstProfile,secondProfile]) profiles.recordValidation(profile.latestRevision.id,{success:true,message:"ok"});
 const active=new ActiveAgentConfigService(connection.db,undefined);
 const snapshot=active.activate(scope.agentId,firstProfile.latestRevision.id,owner);
 const store=new InvocationStore(connection.db);
 const record=store.register({...invocation(),agentConfig:executionReference(snapshot)});
 expect(record.agentConfig).not.toHaveProperty("env");
 active.activate(scope.agentId,secondProfile.latestRevision.id,owner);
 expect(active.resolveExecutionSnapshot(scope.agentId).model).toBe("model-second");
 expect(active.resolvePinnedSnapshot(scope.agentId,record.agentConfig!).model).toBe("model-first");
 expect(()=>profiles.deleteProfile(firstProfile.id)).toThrow("unsettled invocation");
 expect(()=>store.register({...invocation(),agentConfig:executionReference(active.resolveExecutionSnapshot(scope.agentId))})).toThrow("invocation_conflict");
 expect(()=>connection.db.update(schema.runnerInvocations).set({agentConfig:null}).where(eq(schema.runnerInvocations.id,record.id)).run()).toThrow("invocation_config_immutable");
 expect(()=>connection.db.insert(schema.runnerInvocations).values({...record,id:"forged-config",agentConfig:{...record.agentConfig!,agentId:"foreign"}}).run()).toThrow("invocation_config_mismatch");
 const foreign=fixtureScope(connection.db,"foreign-owner");
 expect(()=>active.resolvePinnedSnapshot(foreign.agentId,record.agentConfig!)).toThrow("execution_config_scope_mismatch");
 expect(()=>active.resolvePinnedSnapshot(scope.agentId,{...record.agentConfig!,configFingerprint:"changed"})).toThrow("execution_config_changed");
 store.finish(record.id);
 profiles.deleteProfile(firstProfile.id);
 expect(profiles.getProfile(firstProfile.id)?.deletedAt).not.toBeNull();
});
