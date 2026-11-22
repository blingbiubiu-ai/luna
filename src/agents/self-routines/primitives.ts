import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { runnerContexts, sessionCommands, sessions } from "@/data/schema";
import type { SessionCommand } from "@/messaging/session-command-service";
import { SessionStore } from "@/sessions/session-store";
import {
  FRESH_CONTEXT_ROUTINE_KINDS,
  SELF_ROUTINE_ORIGINS,
  type SelfRoutineKind,
} from "./types";

/** Resolves which self-routine queued a session command from its `originId` prefix. */
export function selfRoutineKindOfOrigin(
  originId: string | null | undefined,
): SelfRoutineKind | undefined {
  if (!originId) return undefined;
  for (const [kind, prefix] of Object.entries(SELF_ROUTINE_ORIGINS) as [
    SelfRoutineKind,
    string,
  ][]) {
    if (originId.startsWith(prefix)) return kind;
  }
  return undefined;
}

export function isSelfRoutineOrigin(originId: string | null | undefined): boolean {
  return selfRoutineKindOfOrigin(originId) !== undefined;
}

/** Looks up the self-routine kind of a `session_commands` trigger row. */
export function selfRoutineKindOfTrigger(
  db: DrizzleDB,
  triggerId: string,
): SelfRoutineKind | undefined {
  const origin = db
    .select({ originId: sessionCommands.originId })
    .from(sessionCommands)
    .where(eq(sessionCommands.id, triggerId))
    .get()?.originId;
  return selfRoutineKindOfOrigin(origin);
}

/** Queued or running work in a session: inbound messages not yet handled, a running turn or a pending Service-queued turn. */
export function sessionBusy(db: DrizzleDB, sessionId: string): boolean {
  return Boolean(
    db.get(sql`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM session_inbox WHERE session_id = ${sessionId} AND status IN ('pending', 'claimed', 'processing'))
    OR EXISTS (SELECT 1 FROM session_turns WHERE session_id = ${sessionId} AND status = 'running')
    OR EXISTS (SELECT 1 FROM session_commands WHERE session_id = ${sessionId} AND kind = 'session.invoke' AND status IN ('pending', 'running'))`),
  );
}

/** True when a previously queued routine command is still pending or running. */
export function commandInFlight(
  db: DrizzleDB,
  commandId: string | null | undefined,
): boolean {
  if (!commandId) return false;
  const status = db
    .select({ status: sessionCommands.status })
    .from(sessionCommands)
    .where(eq(sessionCommands.id, commandId))
    .get()?.status;
  return status === "pending" || status === "running";
}

/**
 * Reuses an active dedicated local session, or creates a new one and calls
 * `onCreated` before queueing so a failed queue leaves no orphaned session behind.
 */
export function ensureDedicatedLocalSession(
  db: DrizzleDB,
  options: {
    readonly agentId: string;
    readonly shadowId: string;
    readonly ownerUserId: string;
    readonly existingSessionId?: string | null | undefined;
    readonly title: string;
    readonly onCreated?: (sessionId: string) => void;
  },
): typeof sessions.$inferSelect {
  const sessionStore = new SessionStore(db);
  const existing = options.existingSessionId
    ? sessionStore.getById(options.existingSessionId)
    : undefined;
  if (existing?.status === "active") return existing;
  const created = sessionStore.createLocalSession(options.ownerUserId, {
    agentId: options.agentId,
    shadowId: options.shadowId,
  });
  db.update(sessions)
    .set({ title: options.title })
    .where(eq(sessions.id, created.id))
    .run();
  options.onCreated?.(created.id);
  return sessionStore.getById(created.id) ?? created;
}

/**
 * Clears the provider session before starting a non-recovered turn of a routine
 * that requires a fresh provider context (such as consolidation or heartbeat).
 */
export function prepareSelfRoutineRun(
  db: DrizzleDB,
  command: Pick<SessionCommand, "id" | "sessionId">,
  recovering: boolean,
): void {
  if (recovering) return;
  const kind = selfRoutineKindOfTrigger(db, command.id);
  if (!kind || !FRESH_CONTEXT_ROUTINE_KINDS.has(kind)) return;
  db.update(runnerContexts)
    .set({ runner_session_id: null })
    .where(
      and(
        eq(runnerContexts.owner_type, "session"),
        eq(runnerContexts.owner_id, command.sessionId),
      ),
    )
    .run();
}
