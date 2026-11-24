import { eq } from "drizzle-orm";
import { ensureTurnDeltaPack } from "@/context";
import type { DrizzleDB } from "@/data";
import {
  sessions,
  sessionTurns,
} from "@/data/schema";
import { memoryOriginOfTrigger, prepareMemoryConsolidationRun } from "@/agents/agent-memory-maintenance";
import { MainRunnerContextBuilder } from "@/main-runner/context-builder";
import { MainRunnerFreshLaunchReplayRequiredError, type MainRunner } from "@/main-runner/main-runner";
import type { SessionCommand } from "@/messaging/session-command-service";
import { InvocationStore } from "@/runners/invocation-store";
import { RunnerContextStore } from "@/runners/runner-context-store";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { SessionTurnStore } from "@/sessions/session-turn-store";

/** Runs a Service-queued memory turn in a Work session with that session's own Runner. */
export type WorkMaintenanceTurn = (
  session: typeof sessions.$inferSelect,
  command: { id: string; actorUserId: string; instruction: string },
  signal: AbortSignal,
) => Promise<void>;

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
      const turnStore = new SessionTurnStore(db);
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
        const deltaPackId = ensureTurnDeltaPack({
          db,
          sessionId: command.sessionId,
          invocationId: command.id,
          runnerContext,
          turnFlavor: "session_trigger",
          memoryOrigin: origin,
          launchSeedEntryIds: seedEntryIds,
        });
        const contextBuild = contextBuilder.buildForSessionWithEntries(command.sessionId, {
          includeLaunchSeed,
          createdForInvocationId: command.id,
          ...(deltaPackId ? { deltaContextPackIds: [deltaPackId] } : {}),
        });
        if (contextBuild.contextEntries.length > 0) {
          turnStore.attachEntries(command.id, contextBuild.contextEntries);
        }
        await main().run({
          signal,
          turnId: command.id,
          runnerContext,
          input: {
            type: "session_trigger",
            triggerId: command.id,
            instruction: String(command.payload.content),
            requesterUserId: command.actorUserId,
            context: contextBuild.context,
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
        const finalStatus = signal.aborted ? "failed" : "completed";
        db.update(sessionTurns)
          .set({ status: finalStatus, completed_at: Date.now(), updated_at: Date.now() })
          .where(eq(sessionTurns.id, command.id))
          .run();
      }
    }
  };
}
