import type { DrizzleDB } from "@/data";
import type { SessionCommand, SessionCommandService } from "@/messaging/session-command-service";

export const SELF_ROUTINE_KINDS = [
  "reflection",
  "consolidation",
  "heartbeat",
  "request_expiry",
] as const;

export type SelfRoutineKind = (typeof SELF_ROUTINE_KINDS)[number];

export const SELF_ROUTINE_ORIGINS: Record<SelfRoutineKind, string> = {
  reflection: "memory-reflection:",
  consolidation: "memory-consolidation:",
  heartbeat: "heartbeat:",
  request_expiry: "request-expiry:",
};

/** Routines that reset the provider session before starting a fresh (non-recovered) turn. */
export const FRESH_CONTEXT_ROUTINE_KINDS: ReadonlySet<SelfRoutineKind> = new Set([
  "consolidation",
  "heartbeat",
]);

export const DEFAULT_SELF_ROUTINE_EXPIRES_MS = 60 * 60 * 1000;

export interface SelfRoutineContext {
  readonly db: DrizzleDB;
  readonly commands: Pick<SessionCommandService, "accept">;
  readonly now: number;
}

export interface SelfRoutine<TCandidate = unknown> {
  readonly kind: SelfRoutineKind;
  readonly originPrefix: string;
  readonly commandKey: string;
  readonly freshProviderContext?: boolean;
  readonly expiresMs?: number;
  enabled(ctx: SelfRoutineContext): boolean;
  findDue(ctx: SelfRoutineContext): readonly TCandidate[];
  resolveSessionId(ctx: SelfRoutineContext, candidate: TCandidate): string;
  actorUserId(ctx: SelfRoutineContext, candidate: TCandidate): string;
  originId(ctx: SelfRoutineContext, candidate: TCandidate): string;
  instruction(ctx: SelfRoutineContext, candidate: TCandidate): string;
  onQueued?(ctx: SelfRoutineContext, candidate: TCandidate, command: SessionCommand): void;
  onFailed?(ctx: SelfRoutineContext, candidate: TCandidate, error: unknown): void;
  onFinally?(ctx: SelfRoutineContext, candidate: TCandidate): void;
}
