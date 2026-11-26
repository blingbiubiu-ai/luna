import type {
  taskSubscriptions,
  tasks,
  timelineEvents,
} from "@/data/schema";

/**
 * Represents Persistent Task values used by task workflow.
 */
export type PersistentTask = typeof tasks.$inferSelect;
/**
 * Represents Task Subscription values used by task workflow.
 */
export type TaskSubscription = Omit<typeof taskSubscriptions.$inferSelect, "status_card_style"> & { status_card_style?: "card" | "native" };
/**
 * Represents Timeline Event values used by task workflow.
 */
export type TimelineEvent = typeof timelineEvents.$inferSelect;

/**
 * Represents Task Type values used by task workflow.
 */
export type TaskType = "question" | "task" | "approval" | "handoff";
/**
 * Represents Task Priority values used by task workflow.
 */
export type TaskPriority = "low" | "medium" | "high" | "urgent";
/**
 * Allowed status values for task workflow.
 */
export type TaskStatus =
  | "new"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
/**
 * Describes why a Task subagent is blocked after its latest run.
 */
export type TaskBlockReason =
  | null
  | "waiting_user"
  | "waiting_dev"
  | "waiting_approval"
  | "waiting_external";
/** Set when a Task pauses awaiting external response or condition; cleared when the next run starts. */
export const WAITING_FOR_INPUT: TaskBlockReason = "waiting_user";
/**
 * Defines canonical Task thread statuses that can still receive follow-up input.
 *
 * Task status mirrors the latest run state; it does not close the Task thread.
 */
export const REUSABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "new",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
];
/**
 * Represents Task Notification Level values used by task workflow.
 */
export type TaskNotificationLevel = "major_updates" | "result_only" | "all" | "none";
/**
 * Represents Task Visibility values used by task workflow.
 */
export type TaskVisibility = "full" | "summary";
/**
 * Describes the Persistent Task Resolved contract used by task workflow.
 */
export interface PersistentTaskResolved {
  readonly persistentTask: PersistentTask;
  readonly created: boolean;
  readonly subscription?: TaskSubscription;
}

/**
 * Describes the Task View contract used by task workflow.
 */
export interface TaskView {
  readonly persistentTask: PersistentTask;
  readonly subscription: TaskSubscription;
  readonly latestEvent?: TimelineEvent;
  readonly timelineEvents?: readonly TimelineEvent[];
}
