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
  taskRuns,
} from "@/data/schema";
import type { MainRunnerInput } from "@/main-runner/types";
import { isHeartbeatSession } from "@/messaging/correlated-request-service";
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
  | "peer_message"
  | "request_opened"
  | "request_message"
  | "request_update"
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
    readonly allowMain: boolean;
    readonly allowTask: boolean;
    readonly allowSession: boolean;
    readonly allowGroup: boolean;
    readonly allowUser: boolean;
  };
  readonly outboundGovernance?: OutboundQuotaSnapshot | null | undefined;
}

const MAIN_COMMANDS = [
  "say",
  "ask | ask reply|message|wait|cancel|get|list",
  "tasks create|update|restart|cancel|transfer|watch|unwatch|list|get|status-card",
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
  "say --via-main",
  "ask | ask message|cancel|get|list",
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
  "ask | ask reply|message|wait|cancel|get|list",
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
  "say --to main",
  "ask --to main | ask wait|message|cancel|get|list",
  "tasks report|pause",
  "memory list|search|timeline|get|add|update|delete|restore",
  "artifacts",
  "knowledge",
  "workspace",
  "commands status|wait",
  "whoami",
] as const;

export interface ResolvedMainTriggerClassification {
  readonly originKind: TurnOriginKind;
  readonly routineKind?: SelfRoutineKind | undefined;
  readonly requestUpdate?: Record<string, unknown> | undefined;
  readonly requestOpened?: Record<string, unknown> | undefined;
  readonly requestMessage?: Record<string, unknown> | undefined;
  readonly peerMessage?: Record<string, unknown> | undefined;
}

export function resolveMainTriggerClassification(
  db: DrizzleDB | undefined,
  triggerId: string,
  sourceSessionId: string,
  currentSessionId: string,
): ResolvedMainTriggerClassification {
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
    if (cmd && cmd.payload && typeof cmd.payload === "object") {
      const payload = cmd.payload as Record<string, unknown>;
      if (payload.requestUpdate && typeof payload.requestUpdate === "object") {
        return {
          originKind: "request_update",
          ...(routine ? { routineKind: routine } : {}),
          requestUpdate: payload.requestUpdate as Record<string, unknown>,
        };
      }
      if (payload.requestResult && typeof payload.requestResult === "object") {
        return {
          originKind: "request_update",
          ...(routine ? { routineKind: routine } : {}),
          requestUpdate: payload.requestResult as Record<string, unknown>,
        };
      }
      if (payload.requestOpened && typeof payload.requestOpened === "object") {
        return {
          originKind: "request_opened",
          requestOpened: payload.requestOpened as Record<string, unknown>,
        };
      }
      if (payload.requestMessage && typeof payload.requestMessage === "object") {
        return {
          originKind: "request_message",
          requestMessage: payload.requestMessage as Record<string, unknown>,
        };
      }
      if (payload.peerMessage && typeof payload.peerMessage === "object") {
        return {
          originKind: "peer_message",
          peerMessage: payload.peerMessage as Record<string, unknown>,
        };
      }
      if (payload.eventKind === "peer_message") {
        return { originKind: "peer_message" };
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
    return { originKind: "peer_message" };
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
  const inHeartbeatSession = db ? isHeartbeatSession(db, sessionId) : false;
  const ignoreTerminal = isRoutine || inHeartbeatSession;
  const allowSilent = ignoreTerminal ? true : resolveMainAllowSilent(db, input);
  const terminalOutputMode: TerminalOutputMode = ignoreTerminal
    ? "ignored"
    : "reply_current_session";

  const commands =
    routineKind === "heartbeat" || inHeartbeatSession
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
      allowCurrent: !ignoreTerminal && !isMemoryOnly,
      allowSelf: !isMemoryOnly,
      allowOwner: !isMemoryOnly,
      allowMain: false,
      allowTask: !isMemoryOnly,
      allowSession: !isMemoryOnly,
      allowGroup: !isMemoryOnly,
      allowUser: !isMemoryOnly,
    },
    outboundGovernance:
      db && scope?.agentId && !isMemoryOnly
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
  const isRoutine =
    options.routineKind === "reflection" ||
    options.routineKind === "consolidation";

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
      allowMain: false,
      allowTask: !isRoutine,
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
      allowMain: true,
      allowTask: false,
      allowSession: false,
      allowGroup: false,
      allowUser: false,
    },
    outboundGovernance: null,
  };
}
