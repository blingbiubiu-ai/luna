import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { artifactizeLocalFileReferencesInValue } from "@/artifacts/local-file-artifactizer";
import {
  REUSABLE_TASK_STATUSES,
  type TaskStatus,
  type TaskType,
} from "@/tasks/types";
import { taskWithLatestRunStatus } from "@/tasks/task-status-projection";
import type { DrizzleDB } from "@/data";
import {
  messages,
  sessionTimelineEntries,
  tasks,
  taskSubscriptions,
} from "@/data/schema";
import {
  ContextPackStore,
  type ContextPackItemRow,
  type ContextPackRow,
} from "@/context";
import type { MessageContentBlock } from "@/sessions/types";

import { SessionStateStore } from "./session-state-store";
import type {
  MainRunnerContextPack,
  MainRunnerContextPackItem,
  MainRunnerSessionContext,
} from "./types";

type TaskRow = typeof tasks.$inferSelect;
type MaterializedContextPackItem = {
  readonly item: MainRunnerContextPackItem;
  readonly occurredAt: number;
};

export interface MainRunnerSessionContextBuildOptions {
  readonly excludeEntryIds?: readonly string[];
  readonly includeLaunchSeed?: boolean;
  readonly createdForInvocationId?: string;
  readonly deltaContextPackIds?: readonly string[];
}

export interface MainRunnerSessionContextBuild {
  readonly context: MainRunnerSessionContext;
  readonly contextEntryIds: readonly string[];
  readonly contextEntries: readonly {
    readonly entryId: string;
    readonly role: "context" | "launch_context";
  }[];
}

/**
 * Builds Main Runner Context Builder data for session Main Runner.
 */
export class MainRunnerContextBuilder {
  private readonly _stateStore: SessionStateStore;
  private readonly _contextPackStore: ContextPackStore;

  constructor(private readonly _db: DrizzleDB) {
    this._stateStore = new SessionStateStore(_db);
    this._contextPackStore = new ContextPackStore(_db);
  }

  buildForSession(
    sessionId: string,
    options: MainRunnerSessionContextBuildOptions = {},
  ): MainRunnerSessionContext {
    return this.buildForSessionWithEntries(sessionId, options).context;
  }

  buildForSessionWithEntries(
    sessionId: string,
    options: MainRunnerSessionContextBuildOptions = {},
  ): MainRunnerSessionContextBuild {
    const contextPacks = this._contextPackStore.listPacksForOwner(
      "session",
      sessionId,
    );
    const launchSeed =
      options.includeLaunchSeed === false
        ? undefined
        : this._buildLaunchSeed(contextPacks, options);
    const deltaContext = this._buildDeltaContext(contextPacks, options);
    const candidateRows = this._readMostRecentlyUpdatedSubscribedTasks(
      sessionId,
    );
    const clarification = this._stateStore.getClarification(sessionId);

    return {
      context: {
        sessionId,
        ...(launchSeed !== undefined ? { launchSeed } : {}),
        ...(deltaContext !== undefined ? { deltaContext } : {}),
        ...(clarification !== undefined ? { clarification } : {}),
        candidateOpenTasks: candidateRows
          .slice(0, 5)
          .map((row) => this._taskContextForRow(row)),
      },
      contextEntryIds: contextEntryIds({ launchSeed, deltaContext, options }),
      contextEntries: contextTurnEntries({ launchSeed, deltaContext, options }),
    };
  }

  private _taskContextForRow(row: TaskRow): {
    readonly taskId: string;
    readonly taskType: TaskType;
    readonly status: TaskStatus;
    readonly title: string;
    readonly summary: string;
  } {
    const text = artifactizeLocalFileReferencesInValue({
      db: this._db,
      value: {
        title: row.title,
        summary: row.summary ?? "",
      },
      scopeType: "task",
      scopeId: row.id,
      producer: "main_runner_context",
    });
    return {
      taskId: row.id,
      taskType: row.type as TaskType,
      status: row.status as TaskStatus,
      title: text.title,
      summary: text.summary,
    };
  }

  private _buildLaunchSeed(
    contextPacks: readonly ContextPackRow[],
    options: MainRunnerSessionContextBuildOptions,
  ): MainRunnerContextPack | undefined {
    const launchPacks = [...contextPacks]
      .reverse()
      .filter(isSessionLaunchContextPack);
    const pack =
      launchPacks.find((candidate) => candidate.kind === "session_launch") ??
      launchPacks.find(isThreadHandoffLaunchPack) ??
      launchPacks[0];
    if (pack === undefined) {
      return undefined;
    }
    return this._materializePack(
      pack,
      ["seed", "source", "launch_context"],
      options,
    );
  }

  private _buildDeltaContext(
    contextPacks: readonly ContextPackRow[],
    options: MainRunnerSessionContextBuildOptions,
  ): MainRunnerContextPack | undefined {
    const explicitPackIds = new Set(options.deltaContextPackIds ?? []);
    const pack = explicitPackIds.size > 0
      ? [...contextPacks]
          .reverse()
          .find((candidate) => explicitPackIds.has(candidate.id))
      : [...contextPacks]
          .reverse()
          .find(
            (candidate) =>
              (candidate.kind === "group_activation" ||
                candidate.kind === "turn_delta") &&
              (options.createdForInvocationId === undefined ||
                candidate.createdForInvocationId ===
                  options.createdForInvocationId),
          );
    if (pack === undefined) {
      return undefined;
    }
    return this._materializePack(pack, ["delta_context"], options);
  }

  private _materializePack(
    pack: ContextPackRow,
    roles: readonly string[],
    options: MainRunnerSessionContextBuildOptions,
  ): MainRunnerContextPack | undefined {
    const excludeEntryIds = new Set(options.excludeEntryIds ?? []);
    const items = this._contextPackStore
      .listItemsForPack(pack.id)
      .filter((item) => roles.includes(item.role))
      .flatMap((item) => {
        const materialized = this._materializePackItem(item);
        if (materialized === undefined) {
          return [];
        }
        if (
          materialized.item.entryId !== null &&
          excludeEntryIds.has(materialized.item.entryId)
        ) {
          return [];
        }
        return [materialized];
      })
      .sort(compareMaterializedContextPackItems)
      .map((item) => item.item);
    if (items.length === 0) {
      return undefined;
    }
    return {
      packId: pack.id,
      kind: pack.kind,
      selectionStrategy: pack.selectionStrategy,
      items,
    };
  }

  private _materializePackItem(
    item: ContextPackItemRow,
  ): MaterializedContextPackItem | undefined {
    const messageId = item.sourceMessageId ?? item.itemId;
    const message = this._db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();
    if (message === undefined || message.deletedAt !== null) {
      return undefined;
    }
    const entryId =
      item.itemKind === "timeline_entry" ? item.itemId : item.sourceEntryId;
    const source = this._readContextPackItemSource(entryId);
    return {
      item: {
        contextItemId: item.id,
        role: contextItemRole(item.role),
        messageRole: message.role === "assistant" ? "assistant" : "user",
        text: renderMessageBlocksForRunner(
          Array.isArray(message.contentJson)
            ? (message.contentJson as readonly MessageContentBlock[])
            : [],
        ),
        entryId: entryId ?? null,
        messageId: message.id,
        sourceEntryId: item.sourceEntryId,
        sourceMessageId: item.sourceMessageId,
        sourceSessionId: item.sourceSessionId,
        ...(source !== undefined ? { source } : {}),
        reason: item.reason,
        displayOrder: item.displayOrder,
      },
      occurredAt: message.occurredAt,
    };
  }

  private _readContextPackItemSource(
    entryId: string | null,
  ): MainRunnerContextPackItem["source"] | undefined {
    if (entryId === null) {
      return undefined;
    }
    const entryKind = this._db
      .select({ entryKind: sessionTimelineEntries.entryKind })
      .from(sessionTimelineEntries)
      .where(eq(sessionTimelineEntries.id, entryId))
      .get()?.entryKind;
    switch (entryKind) {
      case "message":
        return "message";
      case "reference":
        return "reference";
      default:
        return undefined;
    }
  }

  private _readMostRecentlyUpdatedSubscribedTasks(
    sessionId: string,
  ): TaskRow[] {
    const rows = this._db
      .select({ task: tasks })
      .from(taskSubscriptions)
      .innerJoin(tasks, eq(taskSubscriptions.task_id, tasks.id))
      .where(
        and(
          eq(taskSubscriptions.session_id, sessionId),
          inArray(tasks.status, [...REUSABLE_TASK_STATUSES]),
        ),
      )
      .orderBy(
        desc(tasks.updated_at),
        asc(tasks.id),
        asc(taskSubscriptions.id),
      )
      .all();

    const dedupedTasks: TaskRow[] = [];
    const seenTaskIds = new Set<string>();
    for (const row of rows) {
      if (seenTaskIds.has(row.task.id)) {
        continue;
      }
      seenTaskIds.add(row.task.id);
      dedupedTasks.push(taskWithLatestRunStatus(this._db, row.task));
      if (dedupedTasks.length === 5) {
        break;
      }
    }
    return dedupedTasks;
  }
}

function compareMaterializedContextPackItems(
  left: MaterializedContextPackItem,
  right: MaterializedContextPackItem,
): number {
  return (
    left.occurredAt - right.occurredAt ||
    left.item.displayOrder - right.item.displayOrder ||
    left.item.contextItemId.localeCompare(right.item.contextItemId)
  );
}

function isSessionLaunchContextPack(pack: ContextPackRow): boolean {
  return pack.kind === "session_launch" || pack.kind === "thread_launch" || pack.kind === "group_launch";
}

function isThreadHandoffLaunchPack(pack: ContextPackRow): boolean {
  if (pack.kind !== "thread_launch") {
    return false;
  }
  const metadata =
    typeof pack.metadataJson === "object" && pack.metadataJson !== null
      ? (pack.metadataJson as Record<string, unknown>)
      : {};
  return typeof metadata.sourceDecisionId === "string";
}

function contextItemRole(
  role: string,
): MainRunnerContextPackItem["role"] {
  switch (role) {
    case "seed":
    case "source":
    case "delta_context":
    case "launch_context":
    case "context":
      return role;
    default:
      return "context";
  }
}

function contextEntryIds(input: {
  readonly launchSeed: MainRunnerContextPack | undefined;
  readonly deltaContext: MainRunnerContextPack | undefined;
  readonly options: MainRunnerSessionContextBuildOptions;
}): readonly string[] {
  return contextTurnEntries(input).map((entry) => entry.entryId);
}

function contextTurnEntries(input: {
  readonly launchSeed: MainRunnerContextPack | undefined;
  readonly deltaContext: MainRunnerContextPack | undefined;
  readonly options: MainRunnerSessionContextBuildOptions;
}): readonly {
  readonly entryId: string;
  readonly role: "context" | "launch_context";
}[] {
  const excludeEntryIds = new Set(input.options.excludeEntryIds ?? []);
  return [
    ...entryIdsFromPack(input.launchSeed).map((entryId) => ({
      entryId,
      role: "launch_context" as const,
    })),
    ...entryIdsFromPack(input.deltaContext).map((entryId) => ({
      entryId,
      role: "context" as const,
    })),
  ].filter((entry) => !excludeEntryIds.has(entry.entryId));
}

function entryIdsFromPack(
  pack: MainRunnerContextPack | undefined,
): readonly string[] {
  if (pack === undefined) {
    return [];
  }
  return [
    ...new Set(
      pack.items.flatMap((item) =>
        item.entryId === null ? [] : [item.entryId],
      ),
    ),
  ];
}

export function renderMessageBlocksForRunner(
  blocks: readonly MessageContentBlock[],
): string {
  return blocks
    .flatMap((block) => renderMessageBlockForRunner(block))
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}

function renderMessageBlockForRunner(block: MessageContentBlock): string[] {
  switch (block.type) {
    case "text":
      return block.text.length > 0 ? [block.text] : [];
    case "image": {
      const target = block.url ?? block.fileId;
      if (target === undefined || target.length === 0) {
        return ["[image]"];
      }
      return [`![image](${target})`];
    }
    case "file": {
      const label = block.name ?? block.fileId ?? "file";
      return [`[file] ${label}`];
    }
    case "link":
      return [block.title ?? block.text ?? block.url];
    case "mention":
      return [block.label];
    case "card":
      return [block.text ?? block.title ?? ""];
  }
}
