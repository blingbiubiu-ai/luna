import { and, desc, eq, sql } from "drizzle-orm";
import { ContextPackStore } from "@/context/context-pack-store";
import type { DrizzleDB } from "@/data";
import {
  messages,
  sessionRunnerAttempts,
  sessions,
  sessionTimelineEntries,
  sessionTurnEntries,
  sessionTurns,
  type MemoryOriginKind,
} from "@/data/schema";
import { memoryOriginOfTrigger, prepareMemoryConsolidationRun } from "@/agents/agent-memory-maintenance";
import { MainRunnerContextBuilder } from "@/main-runner/context-builder";
import { MainRunnerFreshLaunchReplayRequiredError, type MainRunner } from "@/main-runner/main-runner";
import type { SessionCommand } from "@/messaging/session-command-service";
import { InvocationStore } from "@/runners/invocation-store";
import { RunnerContextStore, type ResolvedRunnerContext } from "@/runners/runner-context-store";
import { RuntimeDetachedError } from "@/runners/runtime-detach";

/** Runs a Service-queued memory turn in a Work session with that session's own Runner. */
export type WorkMaintenanceTurn = (
  session: typeof sessions.$inferSelect,
  command: { id: string; actorUserId: string; instruction: string },
  signal: AbortSignal,
) => Promise<void>;

/**
 * Selects timeline messages a `session_trigger` turn needs in `<history>.deltaContext`:
 * - Consolidation turns need none (all candidate entries are in the instruction).
 * - Reflection turns run inside an existing provider session (`runner_session_id !== null`) that
 *   already holds every turn of the conversation, so re-sending recent messages would only bloat
 *   the provider transcript and TUI scrollback; recent context is attached only if the provider
 *   session was reset (`runner_session_id === null`).
 * - Inline triggers (`schedule`, `session.invoke`) on an existing provider session only attach
 *   unaddressed user messages that arrived after the session's last completed attempt and were not
 *   part of any completed turn; cold launches (`runner_session_id === null`) attach recent messages
 *   not already covered by `launchSeed`.
 */
function ensureTriggerDeltaPack(
  db: DrizzleDB,
  command: SessionCommand,
  origin: MemoryOriginKind,
  runnerContext: ResolvedRunnerContext,
  launchSeedEntryIds: ReadonlySet<string>,
): string | undefined {
  if (origin === "consolidation") return undefined;
  const hasSession = runnerContext.runner_session_id !== null;
  if (origin === "reflection" && hasSession) return undefined;

  const packs = new ContextPackStore(db);
  const existing = packs
    .listPacksForOwner("session", command.sessionId)
    .find(pack => pack.kind === "turn_delta" && pack.createdForInvocationId === command.id);
  if (existing) return existing.id;

  const lastAttemptStartedAt = hasSession
    ? db
        .select({ startedAt: sessionRunnerAttempts.startedAt })
        .from(sessionRunnerAttempts)
        .where(
          and(
            eq(sessionRunnerAttempts.sessionId, command.sessionId),
            eq(sessionRunnerAttempts.runnerContextId, runnerContext.id),
            eq(sessionRunnerAttempts.runnerSessionId, runnerContext.runner_session_id!),
            eq(sessionRunnerAttempts.status, "parsed"),
          ),
        )
        .orderBy(desc(sessionRunnerAttempts.startedAt))
        .get()?.startedAt
    : undefined;

  const handledEntryIds = hasSession
    ? new Set(
        db
          .select({ entryId: sessionTurnEntries.entry_id })
          .from(sessionTurnEntries)
          .innerJoin(sessionTurns, eq(sessionTurns.id, sessionTurnEntries.turn_id))
          .where(
            and(
              eq(sessionTurnEntries.session_id, command.sessionId),
              eq(sessionTurns.status, "completed"),
              sql`${sessionTurnEntries.role} IN ('trigger', 'coalesced_input', 'context', 'launch_context', 'output')`,
            ),
          )
          .all()
          .map(row => row.entryId),
      )
    : undefined;

  const recent = db
    .select({ entry: sessionTimelineEntries, message: messages })
    .from(sessionTimelineEntries)
    .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .where(eq(sessionTimelineEntries.sessionId, command.sessionId))
    .orderBy(desc(sessionTimelineEntries.createdAt))
    .limit(30)
    .all()
    .reverse()
    .filter(row => {
      const raw = row.message.rawPayloadJson as Record<string, unknown> | null;
      if ((raw?.deliveryStatus && raw.deliveryStatus !== "sent") || raw?.origin === "session_trigger") {
        return false;
      }
      if (!hasSession) {
        return !launchSeedEntryIds.has(row.entry.id);
      }
      if (handledEntryIds?.has(row.entry.id)) return false;
      if (row.message.role === "assistant") return false;
      return lastAttemptStartedAt === undefined || row.entry.createdAt >= lastAttemptStartedAt;
    });

  if (recent.length === 0) return undefined;

  const pack = packs.createPack({
    ownerType: "session",
    ownerId: command.sessionId,
    kind: "turn_delta",
    selectionStrategy: "trigger_recent_context",
    createdForInvocationId: command.id,
  });
  packs.addItems(
    pack.id,
    recent.map(row => ({
      itemKind: "message",
      itemId: row.message.id,
      sourceSessionId: command.sessionId,
      sourceEntryId: row.entry.id,
      sourceMessageId: row.message.id,
      role: "delta_context",
      reason: "trigger_recent_context",
    })),
  );
  return pack.id;
}

export function createSessionTriggerExecutor(
  db: DrizzleDB,
  main: () => MainRunner,
  runnerType: (sessionId: string) => string,
  workMaintenance?: WorkMaintenanceTurn,
) {
  return async (command: SessionCommand, signal: AbortSignal) => {
    const session = db.select().from(sessions).where(eq(sessions.id, command.sessionId)).get();
    const origin = memoryOriginOfTrigger(db, command.id);
    if (session?.kind === "work" && workMaintenance && origin !== "inline") {
      // A Work session's conversation lives in the Work Runner's provider context; Main would start from nothing.
      const now = Date.now();
      db.insert(sessionTurns)
        .values({
          id: command.id,
          session_id: command.sessionId,
          turn_kind: "execution",
          status: "running",
          runner_invoked: true,
          reason: "session_trigger",
          started_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: sessionTurns.id,
          set: { status: "running", error: null, completed_at: null, updated_at: now },
        })
        .run();
      let outcome: "completed" | "failed" | undefined = "failed",
        failure: string | null = null;
      try {
        await workMaintenance(
          session,
          { id: command.id, actorUserId: command.actorUserId, instruction: String(command.payload.content) },
          signal,
        );
        if (signal.aborted) throw new Error("Trigger cancelled");
        outcome = "completed";
      } catch (error) {
        if (error instanceof RuntimeDetachedError) outcome = undefined;
        else failure = String(error);
        throw error;
      } finally {
        if (outcome) {
          db.update(sessionTurns)
            .set({ status: outcome, error: failure, completed_at: Date.now(), updated_at: Date.now() })
            .where(eq(sessionTurns.id, command.id))
            .run();
        }
      }
      return;
    }

    const now = Date.now();
    db.insert(sessionTurns)
      .values({
        id: command.id,
        session_id: command.sessionId,
        turn_kind: "execution",
        status: "running",
        runner_invoked: true,
        reason: "session_trigger",
        started_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: sessionTurns.id,
        set: { status: "running", error: null, completed_at: null, updated_at: now },
      })
      .run();

    let detached = false;
    try {
      prepareMemoryConsolidationRun(
        db,
        command,
        Boolean(new InvocationStore(db).findActive({ runnerKind: "main", originId: command.id, sessionId: command.sessionId })),
      );
      const contextBuilder = new MainRunnerContextBuilder(db);
      const contextStore = new RunnerContextStore(db);
      const runOnce = async () => {
        const runnerContext = contextStore.resolveForSession(command.sessionId, runnerType(command.sessionId));
        const includeLaunchSeed = runnerContext.runner_session_id === null;
        const baseSeedBuild = includeLaunchSeed
          ? contextBuilder.buildForSessionWithEntries(command.sessionId, {
              includeLaunchSeed: true,
              createdForInvocationId: command.id,
            })
          : undefined;
        const seedEntryIds = new Set(baseSeedBuild?.contextEntryIds ?? []);
        const deltaPackId = ensureTriggerDeltaPack(db, command, origin, runnerContext, seedEntryIds);
        const context = contextBuilder.buildForSession(command.sessionId, {
          includeLaunchSeed,
          createdForInvocationId: command.id,
          ...(deltaPackId ? { deltaContextPackIds: [deltaPackId] } : {}),
        });
        await main().run({
          signal,
          turnId: command.id,
          runnerContext,
          input: {
            type: "session_trigger",
            triggerId: command.id,
            instruction: String(command.payload.content),
            requesterUserId: command.actorUserId,
            context,
            artifactRefs: ((command.payload.contextRefs as string[]) ?? []).map(id => `artifact:${id}`),
            sourceSessionId: command.sourceSessionId,
            correlationId: command.correlationId,
            hops: command.hops,
          },
        });
      };

      try {
        await runOnce();
      } catch (error) {
        if (error instanceof MainRunnerFreshLaunchReplayRequiredError) {
          await runOnce();
        } else {
          throw error;
        }
      }
      if (signal.aborted) throw new Error("Trigger cancelled");
    } catch (error) {
      if (error instanceof RuntimeDetachedError) {
        detached = true;
        throw error;
      }
      db.update(sessionTurns)
        .set({ status: "failed", error: String(error), completed_at: Date.now(), updated_at: Date.now() })
        .where(eq(sessionTurns.id, command.id))
        .run();
      throw error;
    } finally {
      const turn = db.select().from(sessionTurns).where(eq(sessionTurns.id, command.id)).get();
      if (!detached && turn?.status === "running") {
        db.update(sessionTurns)
          .set({ status: signal.aborted ? "failed" : "completed", completed_at: Date.now(), updated_at: Date.now() })
          .where(eq(sessionTurns.id, command.id))
          .run();
      }
    }
  };
}
