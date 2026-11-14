import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { sessionTriggers } from "@/data/schema";
import { AgentError } from "@/agents/agent-store";
import { TaskScopeResolver } from "@/agents/task-scope";
import type { TaskResultForMainRunner } from "@/main-runner/types";
import { SessionStore } from "@/sessions/session-store";
import type { TaskSubscription } from "./types";

/** Must participate in the caller's transaction when accepting a report. */
export function enqueueTaskResult(db: DrizzleDB, result: TaskResultForMainRunner, subscription: TaskSubscription): string {
  const dedupeKey = `task_result:${result.taskRunId}:${subscription.id}`;
  const now = Date.now();
  let error: string | null = null;
  try {
    const scopes = new TaskScopeResolver(db);
    scopes.assertSame(scopes.task(result.taskId), scopes.session(subscription.session_id));
    new SessionStore(db).requireReplyUserId(subscription.session_id);
  } catch (cause) {
    if (!(cause instanceof AgentError)) throw cause;
    error = cause.code;
  }
  db.insert(sessionTriggers).values({id: randomUUID(), sessionId: subscription.session_id,
    kind: "task_result", dedupeKey, payload: {result, subscriptionId: subscription.id},
    status: error ? "cancelled" : "pending", error, createdAt: now, updatedAt: now}).onConflictDoNothing().run();
  if (error) db.update(sessionTriggers).set({status: "cancelled", error, updatedAt: now})
    .where(and(eq(sessionTriggers.dedupeKey, dedupeKey), inArray(sessionTriggers.status, ["pending", "failed"]))).run();
  return dedupeKey;
}
