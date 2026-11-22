import type { TaskStatus, TaskType } from "@/tasks/types";
import type {
  SessionMessageRole,
} from "@/sessions/types";
import type { NormalizedInboundMessage } from "@/channels";
import type { RunnerMessageEnvelope } from "@/runners/message-envelope";

/**
 * Represents Main Runner Task Intent values used by session Main Runner.
 */
export type MainRunnerTaskIntent = Extract<
  TaskType,
  "task" | "question"
>;

/**
 * Describes the Task Result For Main Runner contract used by session Main Runner.
 */
export interface TaskResultForMainRunner {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly runIndex?: number;
  readonly status: Extract<
    TaskStatus,
    "completed" | "failed" | "cancelled"
  >;
  readonly title: string;
  readonly summary: string;
  readonly conclusion?: string;
  readonly evidenceSummary: readonly string[];
  readonly userVisibleReport: string;
  readonly artifactIds: readonly string[];
  /** Downloadable managed artifacts; artifactIds retain timeline/report identity. */
  readonly artifactRefs?: readonly string[];
  readonly nextActions: readonly string[];
  /** The Task stopped to wait for an answer; its report holds the questions. */
  readonly waitingForInput?: boolean;
}

/**
 * Describes a single user message item in a Main Runner user turn.
 */
export interface MainRunnerUserMessageItem extends RunnerMessageEnvelope {
  readonly rawMessage: NormalizedInboundMessage;
}

export interface ActivationContextMessage {
  readonly messageId: string;
  readonly channelMessageKey?: string;
  readonly senderUserId?: string;
  readonly createdAt: number;
  readonly text: string;
}

/**
 * Describes the Main Runner batched user message input contract.
 */
export interface MainRunnerUserMessagesInput {
  readonly type: "user_messages";
  readonly messages: readonly MainRunnerUserMessageItem[];
  readonly latestMessage: NormalizedInboundMessage;
  readonly context: MainRunnerSessionContext;
  readonly activationSourceMessage?: ActivationContextMessage;
  readonly activationContextMessages?: readonly ActivationContextMessage[];
  readonly requesterUserId?: string;
  /** A listening turn: `messages` were overheard in a group chat and nobody addressed the Agent. */
  readonly ambient?: true;
}

/**
 * Describes the Main Runner task result input contract.
 */
export interface MainRunnerTaskResultInput {
  readonly type: "task_result";
  readonly sessionId: string;
  readonly taskId: string;
  readonly surface?: "p2p" | "group" | "thread";
  readonly requesterUserId?: string;
  readonly sourceMessageId?: string;
  readonly result: TaskResultForMainRunner;
  readonly context: MainRunnerSessionContext;
}

/**
 * Represents Main Runner Input values used by session Main Runner.
 */
export interface MainRunnerTriggerInput {
  readonly type: "session_trigger";
  readonly triggerId: string;
  readonly instruction: string;
  readonly requesterUserId: string;
  readonly context: MainRunnerSessionContext;
  readonly artifactRefs: readonly string[];
  readonly sourceSessionId: string;
  readonly correlationId: string;
  readonly hops: number;
}
export type MainRunnerInput = MainRunnerUserMessagesInput | MainRunnerTaskResultInput | MainRunnerTriggerInput;

/**
 * Describes the Session Clarification State contract used by session Main Runner.
 */
export interface SessionClarificationState {
  readonly pendingIntent: MainRunnerTaskIntent;
  readonly missingFields: readonly string[];
  readonly collectedFacts: readonly string[];
  readonly lastReply?: string;
  readonly reason?: string;
}

/**
 * Describes a Main Runner context pack item materialized for runner input.
 */
export interface MainRunnerContextPackItem {
  readonly contextItemId: string;
  readonly role:
    | "seed"
    | "source"
    | "delta_context"
    | "launch_context"
    | "context";
  readonly messageRole: SessionMessageRole;
  readonly text: string;
  readonly entryId: string | null;
  readonly messageId: string | null;
  readonly sourceEntryId: string | null;
  readonly sourceMessageId: string | null;
  readonly sourceSessionId: string | null;
  readonly source?: "message" | "reference";
  readonly reason: string;
  readonly displayOrder: number;
}

/**
 * Describes a durable Main Runner launch or delta context pack.
 */
export interface MainRunnerContextPack {
  readonly packId: string;
  readonly kind: string;
  readonly selectionStrategy: string;
  readonly items: readonly MainRunnerContextPackItem[];
}

/**
 * Describes the Main Runner Session Context contract used by session Main Runner.
 */
export interface MainRunnerSessionContext {
  readonly sessionId: string;
  readonly launchSeed?: MainRunnerContextPack;
  readonly deltaContext?: MainRunnerContextPack;
  readonly clarification?: SessionClarificationState;
  readonly candidateOpenTasks: readonly {
    readonly taskId: string;
    readonly taskType: TaskType;
    readonly status: TaskStatus;
    readonly title: string;
    readonly summary: string;
  }[];
}

/** Completion metadata only; all business effects are committed through commands. */
export interface MainRunnerCompletion {
  readonly status: "completed";
  readonly followupReleased: boolean;
}
