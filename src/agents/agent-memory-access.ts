import {and, eq, isNull, ne} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {messages, tasks, users} from "@/data/schema";
import {AuthorizationRuleStore} from "@/server/policy/authorization-rule-store";
import {ruleMatchesOperation} from "@/server/policy/operation-policy";
import {AgentError, AgentStore} from "./agent-store";
import type {MemoryViewer, MemoryWriter} from "./agent-memory-store";

export interface MemoryInvocation {
  agentId: string;
  shadowId: string;
  actorUserId: string;
  sessionId: string | null;
  taskId: string | null;
  runnerContextId: string;
}

/**
 * The actor, everyone who has spoken in the session, and for a Task its creator and primary session.
 * System users, such as a Shadow's own reply identity, are the Agent speaking, not people taking part.
 */
export function memoryParticipants(db: DrizzleDB, invocation: Pick<MemoryInvocation, "actorUserId" | "sessionId" | "taskId">): string[] {
  const participants = new Set([invocation.actorUserId]);
  const sessionIds = new Set(invocation.sessionId ? [invocation.sessionId] : []);
  if (invocation.taskId) {
    const task = db.select().from(tasks).where(eq(tasks.id, invocation.taskId)).get();
    if (task?.creator_user_id) participants.add(task.creator_user_id);
    if (task?.primary_session_id) sessionIds.add(task.primary_session_id);
  }
  for (const sessionId of sessionIds) {
    for (const row of db.selectDistinct({userId: messages.senderUserId}).from(messages)
      .innerJoin(users, eq(users.id, messages.senderUserId))
      .where(and(eq(messages.ownerSessionId, sessionId), isNull(messages.deletedAt), ne(users.kind, "system"))).all()) participants.add(row.userId);
  }
  return [...participants];
}

/**
 * Memory scope of a Runner invocation. The actor is trusted when it owns the
 * Agent or holds an allow rule for `memory.write`; an explicit deny blocks the
 * corresponding operation.
 */
export function memoryAccess(db: DrizzleDB, invocation: MemoryInvocation, kind: MemoryWriter["kind"] = "inline"): {viewer: MemoryViewer; writer: () => MemoryWriter} {
  const grants = new AuthorizationRuleStore(db, {kind: "agent", agentId: invocation.agentId}).getEffectiveGrantsForUser(invocation.actorUserId);
  const rule = (effect: "allow" | "deny", operation: string) => grants.some(grant => grant.effect === effect && ruleMatchesOperation(grant, operation));
  if (rule("deny", "memory.read")) throw new AgentError("memory_access_denied", 403);
  const owner = new AgentStore(db).get(invocation.agentId).ownerUserId === invocation.actorUserId;
  return {
    // Consolidation is queued by Service for the owner and has to see everything it tidies.
    viewer: kind === "consolidation" && owner ? {agentId: invocation.agentId, all: true}
      : {agentId: invocation.agentId, shadowId: invocation.shadowId, participants: memoryParticipants(db, invocation), actorUserId: invocation.actorUserId, owner},
    writer: () => {
      if (rule("deny", "memory.write")) throw new AgentError("memory_access_denied", 403);
      return {
        agentId: invocation.agentId, kind, trusted: owner || rule("allow", "memory.write"),
        userId: invocation.actorUserId, shadowId: invocation.shadowId, sessionId: invocation.sessionId, taskId: invocation.taskId,
        contextId: invocation.runnerContextId, owner,
      };
    },
  };
}
