import { eq } from "drizzle-orm";
import {
  selfRoutineKindOfOrigin,
  selfRoutineKindOfTrigger,
  type SelfRoutineKind,
} from "@/agents/self-routines";
import type { DrizzleDB } from "@/data";
import {
  scheduleOccurrences,
  sessionCommands,
  shadowHeartbeats,
  taskRuns,
} from "@/data/schema";
import type { MainRunnerInput } from "@/main-runner/types";
import {
  inspectOutboundQuota,
  type OutboundQuotaSnapshot,
} from "@/messaging/outbound-governance";

export const RUNNER_PROTOCOL_VERSION = 2 as const;

export type TurnOriginKind =
  | "user_messages"
  | "ambient_listening"
  | "task_result"
  | "schedule_fired"
  | "handoff"
  | "request_result"
  | "self_routine"
  | "task_run"
  | "work_turn";

export type TerminalOutputMode =
  | "reply_current_session"
  | "ignored"
  | "ignored_use_tasks_report";

export interface RunnerCapabilitiesManifest {
  readonly protocolVersion: typeof RUNNER_PROTOCOL_VERSION;
  readonly identity: {
    readonly agentId?: string | undefined;
    readonly shadowId?: string | undefined;
    readonly runnerKind: "main" | "work" | "task";
    readonly routineKind?: SelfRoutineKind | undefined;
  };
  readonly turn: {
    readonly sessionId?: string | undefined;
    readonly taskId?: string | undefined;
    readonly taskRunId?: string | undefined;
    readonly actorUserId?: string | undefined;
    readonly originKind: TurnOriginKind;
    readonly allowSilent: boolean;
    readonly terminalOutputMode: TerminalOutputMode;
  };
  readonly commands: readonly string[];
  readonly addressScope: {
    readonly allowCurrent: boolean;
    readonly allowSelf: boolean;
    readonly allowOwner: boolean;
    readonly allowSession: boolean;
    readonly allowGroup: boolean;
    readonly allowUser: boolean;
  };
  readonly outboundGovernance?: OutboundQuotaSnapshot | null | undefined;
}

const MAIN_COMMANDS = [
  "say",
  "handoff",
  "handoffs resolve",
  "asks create|answer|cancel|list",
  "requests list",
  "tasks create|update|restart|cancel|list|get|status-card",
  "sessions list|timeline|messages|create-thread|clarify|release",
  "schedules create|list|get|update|pause|resume|cancel",
  "activity",
  "memory list|search|timeline|get|add|update|delete|restore",
  "users search|get|lookup",
  "groups search|get|lookup|create|invite",
  "chat listen",
  "artifacts",
  "commands status|wait",
  "whoami",
] as const;

const HEARTBEAT_COMMANDS = [
  "handoff",
  "asks create|cancel|list",
  "requests list",
  "schedules create|list|get|update|pause|resume|cancel",
  "sessions list|timeline|messages",
  "tasks list|get",
  "activity",
  "memory list|search|timeline|get|add|update|delete|restore",
  "users search|get",
  "groups search|get",
  "commands status|wait",
  "whoami",
] as const;

const MEMORY_ROUTINE_COMMANDS = [
  "memory list|search|timeline|get|add|update|delete|restore",
  "sessions timeline",
  "whoami",
] as const;

const WORK_COMMANDS = [
  "say",
  "handoff",
  "asks create|answer|cancel|list",
  "requests list",
  "schedules create|list|get|update|pause|resume|cancel",
  "sessions list|timeline|messages",
  "activity",
  "memory list|search|timeline|get|add|update|delete|restore",
  "users search|get|lookup",
  "groups search|get|lookup|create|invite",
  "artifacts",
  "knowledge",
  "workspace",
  "commands status|wait",
  "whoami",
] as const;

const TASK_COMMANDS = [
  "tasks report",
  "memory list|search|timeline|get|add|update|delete|restore",
  "artifacts",
  "knowledge",
  "workspace",
  "commands status|wait",
  "whoami",
] as const;

export function resolveMainTriggerClassification(
  db: DrizzleDB | undefined,
  triggerId: string,
  sourceSessionId: string,
  currentSessionId: string,
): {
  readonly originKind: TurnOriginKind;
  readonly routineKind?: SelfRoutineKind | undefined;
  readonly requestResult?: Record<string, unknown> | undefined;
} {
  if (db) {
    const routine = selfRoutineKindOfTrigger(db, triggerId);
    if (routine === "reflection" || routine === "consolidation" || routine === "heartbeat") {
      return { originKind: "self_routine", routineKind: routine };
    }
    const cmd = db
      .select()
      .from(sessionCommands)
      .where(eq(sessionCommands.id, triggerId))
      .get();
    if (cmd) {
      if (
        cmd.payload &&
        typeof cmd.payload === "object" &&
        "requestResult" in cmd.payload &&
        cmd.payload.requestResult &&
        typeof cmd.payload.requestResult === "object"
      ) {
        return {
          originKind: "request_result",
          ...(routine ? { routineKind: routine } : {}),
          requestResult: cmd.payload.requestResult as Record<string, unknown>,
        };
      }
      const occ = db
        .select({ id: scheduleOccurrences.id })
        .from(scheduleOccurrences)
        .where(eq(scheduleOccurrences.id, cmd.originId))
        .get();
      if (occ) {
        return { originKind: "schedule_fired" };
      }
    }
  } else {
    const routine = selfRoutineKindOfOrigin(triggerId);
    if (routine === "reflection" || routine === "consolidation" || routine === "heartbeat") {
      return { originKind: "self_routine", routineKind: routine };
    }
  }
  if (sourceSessionId !== currentSessionId) {
    return { originKind: "handoff" };
  }
  return { originKind: "schedule_fired" };
}

export function isMainSelfRoutineInput(
  db: DrizzleDB | undefined,
  input: MainRunnerInput,
): boolean {
  if (input.type !== "session_trigger") return false;
  const classified = resolveMainTriggerClassification(
    db,
    input.triggerId,
    input.sourceSessionId,
    input.context.sessionId,
  );
  return classified.originKind === "self_routine";
}

export function resolveMainAllowSilent(
  db: DrizzleDB | undefined,
  input: MainRunnerInput,
): boolean {
  if (input.type === "user_messages") {
    if (input.ambient) return true;
    return input.latestMessage.surface.kind !== "p2p";
  }
  if (input.type === "task_result") {
    if (!db) return false;
    const run = db
      .select({ input: taskRuns.input_snapshot })
      .from(taskRuns)
      .where(eq(taskRuns.id, input.result.taskRunId))
      .get();
    return (run?.input as { quiet?: unknown } | null | undefined)?.quiet === true;
  }
  return true;
}

export function buildMainCapabilities(
  db: DrizzleDB | undefined,
  input: MainRunnerInput,
  scope?: {
    readonly agentId?: string | undefined;
    readonly shadowId?: string | undefined;
    readonly actorUserId?: string | undefined;
  },
): RunnerCapabilitiesManifest {
  const sessionId = input.context.sessionId;
  let originKind: TurnOriginKind = "user_messages";
  let routineKind: SelfRoutineKind | undefined;

  if (input.type === "user_messages") {
    originKind = input.ambient ? "ambient_listening" : "user_messages";
  } else if (input.type === "task_result") {
    originKind = "task_result";
  } else {
    const classified = resolveMainTriggerClassification(
      db,
      input.triggerId,
      input.sourceSessionId,
      sessionId,
    );
    originKind = classified.originKind;
    routineKind = classified.routineKind;
  }

  const isRoutine = originKind === "self_routine";
  const isHeartbeatSession = db
    ? Boolean(
        db
          .select({ shadowId: shadowHeartbeats.shadowId })
          .from(shadowHeartbeats)
          .where(eq(shadowHeartbeats.sessionId, sessionId))
          .get(),
      )
    : false;
  const ignoreTerminal = isRoutine || isHeartbeatSession;
  const allowSilent = ignoreTerminal ? true : resolveMainAllowSilent(db, input);
  const terminalOutputMode: TerminalOutputMode = ignoreTerminal
    ? "ignored"
    : "reply_current_session";

  const commands =
    routineKind === "heartbeat" || isHeartbeatSession
      ? HEARTBEAT_COMMANDS
      : routineKind === "reflection" || routineKind === "consolidation"
        ? MEMORY_ROUTINE_COMMANDS
        : MAIN_COMMANDS;

  const isMemoryOnly =
    routineKind === "reflection" || routineKind === "consolidation";

  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    identity: {
      agentId: scope?.agentId,
      shadowId: scope?.shadowId,
      runnerKind: "main",
      ...(routineKind ? { routineKind } : {}),
    },
    turn: {
      sessionId,
      actorUserId: scope?.actorUserId ?? input.requesterUserId,
      originKind,
      allowSilent,
      terminalOutputMode,
    },
    commands,
    addressScope: {
      allowCurrent: !ignoreTerminal,
      allowSelf: !isMemoryOnly,
      allowOwner: !isMemoryOnly,
      allowSession: !isMemoryOnly,
      allowGroup: !isMemoryOnly,
      allowUser: !isMemoryOnly,
    },
    outboundGovernance:
      db && scope?.agentId
        ? inspectOutboundQuota(db, scope.agentId, sessionId)
        : null,
  };
}

export function buildWorkCapabilities(
  db: DrizzleDB | undefined,
  options: {
    readonly agentId?: string | undefined;
    readonly shadowId?: string | undefined;
    readonly sessionId: string;
    readonly actorUserId?: string | undefined;
    readonly routineKind?: SelfRoutineKind | undefined;
    readonly allowSilent: boolean;
  },
): RunnerCapabilitiesManifest {
  const isRoutine = Boolean(options.routineKind);
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    identity: {
      agentId: options.agentId,
      shadowId: options.shadowId,
      runnerKind: "work",
      ...(options.routineKind ? { routineKind: options.routineKind } : {}),
    },
    turn: {
      sessionId: options.sessionId,
      actorUserId: options.actorUserId,
      originKind: isRoutine ? "self_routine" : "work_turn",
      allowSilent: isRoutine ? true : options.allowSilent,
      terminalOutputMode: isRoutine ? "ignored" : "reply_current_session",
    },
    commands: isRoutine ? MEMORY_ROUTINE_COMMANDS : WORK_COMMANDS,
    addressScope: {
      allowCurrent: !isRoutine,
      allowSelf: !isRoutine,
      allowOwner: !isRoutine,
      allowSession: !isRoutine,
      allowGroup: !isRoutine,
      allowUser: !isRoutine,
    },
    outboundGovernance:
      db && options.agentId
        ? inspectOutboundQuota(db, options.agentId, options.sessionId)
        : null,
  };
}

export function buildTaskCapabilities(options: {
  readonly agentId?: string | undefined;
  readonly shadowId?: string | undefined;
  readonly taskId: string;
  readonly taskRunId?: string | undefined;
  readonly actorUserId?: string | undefined;
}): RunnerCapabilitiesManifest {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    identity: {
      agentId: options.agentId,
      shadowId: options.shadowId,
      runnerKind: "task",
    },
    turn: {
      taskId: options.taskId,
      ...(options.taskRunId ? { taskRunId: options.taskRunId } : {}),
      actorUserId: options.actorUserId,
      originKind: "task_run",
      allowSilent: true,
      terminalOutputMode: "ignored_use_tasks_report",
    },
    commands: TASK_COMMANDS,
    addressScope: {
      allowCurrent: false,
      allowSelf: false,
      allowOwner: false,
      allowSession: false,
      allowGroup: false,
      allowUser: false,
    },
    outboundGovernance: null,
  };
}
