import {
  DEFAULT_SELF_ROUTINE_EXPIRES_MS,
  type SelfRoutine,
  type SelfRoutineContext,
} from "./types";

/**
 * Evaluates a single self-routine and queues `session.invoke` commands for due candidates.
 * Failures on one candidate are isolated so remaining candidates and routines still advance.
 */
export function runSelfRoutine<TCandidate>(
  ctx: SelfRoutineContext,
  routine: SelfRoutine<TCandidate>,
): string[] {
  if (!routine.enabled(ctx)) return [];
  const candidates = routine.findDue(ctx);
  const queued: string[] = [];
  const expiresMs = routine.expiresMs ?? DEFAULT_SELF_ROUTINE_EXPIRES_MS;
  for (const candidate of candidates) {
    try {
      const sessionId = routine.resolveSessionId(ctx, candidate);
      const actorUserId = routine.actorUserId(ctx, candidate);
      const originId = routine.originId(ctx, candidate);
      const content = routine.instruction(ctx, candidate);
      const command = ctx.commands.accept(
        {
          userId: actorUserId,
          sourceSessionId: sessionId,
          originId,
        },
        sessionId,
        "session.invoke",
        routine.commandKey,
        { content, purpose: "notification" },
        { expiresAt: ctx.now + expiresMs },
      );
      queued.push(command.id);
      routine.onQueued?.(ctx, candidate, command);
    } catch (error) {
      if (routine.onFailed) {
        routine.onFailed(ctx, candidate, error);
      } else {
        console.warn(`self-routine ${routine.kind} was not queued`, {
          error: String(error),
        });
      }
    } finally {
      routine.onFinally?.(ctx, candidate);
    }
  }
  return queued;
}

/**
 * Runs an ordered list of self-routines; an unexpected error in one routine never blocks the rest.
 */
export function runSelfRoutines(
  ctx: SelfRoutineContext,
  routines: readonly SelfRoutine<any>[],
): Record<string, string[]> {
  const results: Record<string, string[]> = {};
  for (const routine of routines) {
    try {
      results[routine.kind] = runSelfRoutine(ctx, routine);
    } catch (error) {
      console.warn(`self-routine ${routine.kind} pass failed`, {
        error: String(error),
      });
      results[routine.kind] = [];
    }
  }
  return results;
}
