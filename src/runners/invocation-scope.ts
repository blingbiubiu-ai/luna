import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {contextPacks, runnerContexts, taskRuns} from "@/data/schema";
import {AgentError, AgentStore, type AgentScope} from "@/agents/agent-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import {SessionStore} from "@/sessions/session-store";
import {ContextPackScope} from "@/context/context-pack-scope";
import {decodeInvocation} from "./invocation-codec";

export interface InvocationScopeInput {
  runnerKind: "main" | "task";
  actorUserId: string;
  runnerContextId: string;
  sessionId: string | null;
  taskId: string | null;
  taskRunId: string | null;
  contextPackIds: readonly string[];
}

/** Authoritative scope is derived from persisted business entities, never snapshot metadata. */
export function resolveInvocationScope(db: DrizzleDB, input: InvocationScopeInput): AgentScope {
  const scopes = new TaskScopeResolver(db);
  const context = db.select().from(runnerContexts).where(eq(runnerContexts.id, input.runnerContextId)).get();
  const ownerType = input.runnerKind === "task" ? "task" : "session";
  const ownerId = ownerType === "task" ? input.taskId : input.sessionId;
  if (!context || !ownerId || context.owner_type !== ownerType || context.owner_id !== ownerId) {
    throw new AgentError("invocation_context_scope_mismatch", 409);
  }
  const scope = ownerType === "task" ? scopes.task(ownerId) : scopes.session(ownerId);
  scopes.assertSame(scope, {agentId: context.agent_id, shadowId: context.shadow_id});
  new AgentStore(db).requireScope(input.actorUserId, scope);
  if (input.sessionId) {
    scopes.assertSame(scope, scopes.session(input.sessionId));
    new SessionStore(db).requireReplyUserId(input.sessionId);
  }
  if (input.taskId) scopes.assertSame(scope, scopes.task(input.taskId));
  if (input.taskRunId) {
    const run = db.select().from(taskRuns).where(eq(taskRuns.id, input.taskRunId)).get();
    if (!run || run.task_id !== input.taskId) throw new AgentError("invocation_task_run_mismatch", 409);
  }
  const packs = new ContextPackScope(db);
  for (const id of input.contextPackIds) {
    const pack = db.select().from(contextPacks).where(eq(contextPacks.id, id)).get();
    if (!pack) throw new AgentError("context_pack_not_found", 404);
    scopes.assertSame(scope, packs.owner(pack.ownerType, pack.ownerId));
  }
  return scope;
}

/** Durable execution input must identify the same owner as the authority ledger. */
export function validateInvocationSnapshot(input: InvocationScopeInput & {inputSnapshot: unknown}, scope: AgentScope) {
  const snapshot = decodeInvocation(input.inputSnapshot);
  let matches = snapshot.kind === input.runnerKind;
  if (snapshot.kind === "task") {
    matches &&= snapshot.input.taskId === input.taskId && snapshot.input.taskRunId === input.taskRunId && snapshot.input.runnerContextId === input.runnerContextId;
  } else {
    const context = snapshot.input.runnerContext;
    const command = snapshot.input.input;
    matches &&= context.agent_id === scope.agentId && context.shadow_id === scope.shadowId;
    matches &&= context.id === input.runnerContextId && context.owner_type === "session" && context.owner_id === input.sessionId && command.context.sessionId === input.sessionId;
    if (command.type === "task_result") {
      matches &&= command.sessionId === input.sessionId && command.taskId === input.taskId && command.result.taskId === input.taskId && command.result.taskRunId === input.taskRunId;
    }
  }
  if (!matches) throw new AgentError("invocation_snapshot_scope_mismatch", 409);
  return snapshot;
}
