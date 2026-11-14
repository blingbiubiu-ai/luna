import {ContextPackScope} from "./context-pack-scope";
import {TaskScopeResolver} from "@/agents/task-scope";
import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, inArray } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  contextPackItems,
  contextPacks,
  messages,
  runnerContextSeedRecords,
  sessionTimelineEntries,
  sessionTurnEntries,
} from "@/data/schema";
import { uuid } from "@/shared";

export type ContextOwnerType = "session" | "task";
export type ContextPackKind =
  | "session_launch"
  | "thread_launch"
  | "group_launch"
  | "group_activation"
  | "turn_delta"
  | "task_launch"
  | "task_update"
  | "runner_recovery"
  | "session_trigger";

export type ContextPackRow = typeof contextPacks.$inferSelect;
export type ContextPackItemRow = typeof contextPackItems.$inferSelect;
export type RunnerContextSeedRecordRow =
  typeof runnerContextSeedRecords.$inferSelect;

export interface CreateContextPackInput {
  readonly ownerType: ContextOwnerType;
  readonly ownerId: string;
  readonly kind: ContextPackKind;
  readonly selectionStrategy: string;
  readonly triggerEntryId?: string | null;
  readonly triggerMessageId?: string | null;
  readonly createdForInvocationId?: string | null;
  readonly createdAt?: number;
  readonly metadataJson?: unknown;
}

export interface CreateContextPackItemInput {
  readonly itemKind: string;
  readonly itemId: string;
  readonly sourceSessionId?: string | null;
  readonly sourceEntryId?: string | null;
  readonly sourceMessageId?: string | null;
  readonly sourceIdentityId?: string | null;
  readonly role: string;
  readonly reason: string;
  readonly displayOrder?: number;
  readonly metadataJson?: unknown;
}

export interface RecordRunnerSeedInput {
  readonly runnerContextId: string;
  readonly ownerType: ContextOwnerType;
  readonly ownerId: string;
  readonly seedContextPackId: string;
  readonly seedHash: string;
  readonly seedEntryIdsJson: readonly string[];
  readonly seedContextItemIdsJson: readonly string[];
  readonly createdAt?: number;
}

const TASK_SOURCE_PACK_KINDS = ["task_launch", "task_update"] as const;
let lastContextPackCreatedAt = 0;

export type TaskSourceContextPackKind = (typeof TASK_SOURCE_PACK_KINDS)[number];
export type TaskSourceContextItemRole = "source";

export interface TaskSourceContextItem {
  readonly id: string;
  readonly contextPackId: string;
  readonly taskId: string;
  readonly contextPackKind: TaskSourceContextPackKind;
  readonly sourceSessionId: string;
  readonly sourceEntryId: string | null;
  readonly sourceMessageId: string;
  readonly sourceIdentityId: string | null;
  readonly role: TaskSourceContextItemRole;
  readonly reason: string;
  readonly displayOrder: number;
  readonly createdAt: number;
}

export interface AppendTaskSourceItemInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly sourceEntryId?: string | null;
  readonly sourceTurnEntryId?: string | null;
  readonly userId?: string | null;
  readonly createdAt?: number;
}

export class ContextPackStore {
  constructor(private readonly db: DrizzleDB) {}

  createPack(input: CreateContextPackInput): ContextPackRow {
    new ContextPackScope(this.db).create(input);
    const row: typeof contextPacks.$inferInsert = {
      id: uuid(),
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      kind: input.kind,
      selectionStrategy: input.selectionStrategy,
      triggerEntryId: input.triggerEntryId ?? null,
      triggerMessageId: input.triggerMessageId ?? null,
      createdForInvocationId: input.createdForInvocationId ?? null,
      createdAt: input.createdAt ?? nextContextPackCreatedAt(),
      metadataJson: input.metadataJson ?? null,
    };

    this.db.insert(contextPacks).values(row).run();
    return this.requirePack(row.id);
  }

  addItems(
    packId: string,
    items: readonly CreateContextPackItemInput[],
  ): ContextPackItemRow[] {
    return this.db.transaction(tx=>new ContextPackStore(tx as unknown as DrizzleDB).addValidatedItems(packId,items));
  }

  private addValidatedItems(packId:string,items:readonly CreateContextPackItemInput[]):ContextPackItemRow[]{
    new ContextPackScope(this.db).items(packId,items);
    const existingItems = this.listItemsForPack(packId);
    let nextDefaultDisplayOrder =
      existingItems.reduce(
        (maxDisplayOrder, item) =>
          Math.max(maxDisplayOrder, item.displayOrder),
        -1,
      ) + 1;

    for (const item of items) {
      const existing = this.findContextPackItem(
        packId,
        item.itemKind,
        item.itemId,
        item.role,
      );
      const displayOrder =
        item.displayOrder ?? existing?.displayOrder ?? nextDefaultDisplayOrder;
      nextDefaultDisplayOrder = Math.max(
        nextDefaultDisplayOrder,
        displayOrder + 1,
      );

      const row: typeof contextPackItems.$inferInsert = {
        id: uuid(),
        contextPackId: packId,
        itemKind: item.itemKind,
        itemId: item.itemId,
        sourceSessionId: item.sourceSessionId ?? null,
        sourceEntryId: item.sourceEntryId ?? null,
        sourceMessageId: item.sourceMessageId ?? null,
        sourceIdentityId: item.sourceIdentityId ?? null,
        role: item.role,
        reason: item.reason,
        displayOrder,
        metadataJson: item.metadataJson ?? null,
      };

      if (existing !== undefined) {
        this.assertSameContextPackItem(existing, row);
        continue;
      }

      this.db
        .insert(contextPackItems)
        .values(row)
        .onConflictDoNothing({
          target: [
            contextPackItems.contextPackId,
            contextPackItems.itemKind,
            contextPackItems.itemId,
            contextPackItems.role,
          ],
        })
        .run();

      const insertedOrExisting = this.findContextPackItem(
        packId,
        item.itemKind,
        item.itemId,
        item.role,
      );
      if (insertedOrExisting === undefined) {
        throw new Error(
          `Context pack item for context pack "${packId}", item "${item.itemKind}:${item.itemId}", and role "${item.role}" was not found after add.`,
        );
      }
      this.assertSameContextPackItem(insertedOrExisting, row);
    }

    return this.listItemsForPack(packId);
  }

  listPacksForOwner(
    ownerType: ContextOwnerType,
    ownerId: string,
  ): ContextPackRow[] {
    return this.db
      .select()
      .from(contextPacks)
      .where(
        and(eq(contextPacks.ownerType, ownerType), eq(contextPacks.ownerId, ownerId)),
      )
      .orderBy(asc(contextPacks.createdAt), asc(contextPacks.id))
      .all();
  }

  listItemsForPack(packId: string): ContextPackItemRow[] {
    return this.db
      .select()
      .from(contextPackItems)
      .where(eq(contextPackItems.contextPackId, packId))
      .orderBy(asc(contextPackItems.displayOrder), asc(contextPackItems.id))
      .all();
  }

  findTaskIdForSourceMessage(messageId: string): string | undefined {
    return this.db
      .select({ taskId: contextPacks.ownerId })
      .from(contextPackItems)
      .innerJoin(
        contextPacks,
        eq(contextPacks.id, contextPackItems.contextPackId),
      )
      .where(
        and(
          eq(contextPacks.ownerType, "task"),
          inArray(contextPacks.kind, TASK_SOURCE_PACK_KINDS),
          eq(contextPackItems.role, "source"),
          eq(contextPackItems.sourceMessageId, messageId),
        ),
      )
      .orderBy(
        asc(contextPacks.createdAt),
        asc(contextPacks.id),
        asc(contextPackItems.displayOrder),
        asc(contextPackItems.id),
      )
      .get()?.taskId;
  }

  listTaskSourceItems(): TaskSourceContextItem[] {
    return this.db
      .select({ pack: contextPacks, item: contextPackItems })
      .from(contextPackItems)
      .innerJoin(
        contextPacks,
        eq(contextPacks.id, contextPackItems.contextPackId),
      )
      .where(
        and(
          eq(contextPacks.ownerType, "task"),
          inArray(contextPacks.kind, TASK_SOURCE_PACK_KINDS),
          eq(contextPackItems.role, "source"),
        ),
      )
      .orderBy(
        asc(contextPacks.createdAt),
        asc(contextPacks.id),
        asc(contextPackItems.displayOrder),
        asc(contextPackItems.id),
      )
      .all()
      .flatMap((row) => {
        if (
          row.item.sourceSessionId === null ||
          row.item.sourceMessageId === null
        ) {
          return [];
        }
        return [
          {
            id: row.item.id,
            contextPackId: row.pack.id,
            taskId: row.pack.ownerId,
            contextPackKind: row.pack.kind as TaskSourceContextPackKind,
            sourceSessionId: row.item.sourceSessionId,
            sourceEntryId: row.item.sourceEntryId,
            sourceMessageId: row.item.sourceMessageId,
            sourceIdentityId: row.item.sourceIdentityId,
            role: "source",
            reason: row.item.reason,
            displayOrder: row.item.displayOrder,
            createdAt: row.pack.createdAt,
          },
        ];
      });
  }

  hasTaskSourceForSession(input: {
    readonly taskId: string;
    readonly sessionId: string;
  }): boolean {
    return this.db
      .select({ id: contextPackItems.id })
      .from(contextPackItems)
      .innerJoin(
        contextPacks,
        eq(contextPacks.id, contextPackItems.contextPackId),
      )
      .where(
        and(
          eq(contextPacks.ownerType, "task"),
          eq(contextPacks.ownerId, input.taskId),
          inArray(contextPacks.kind, TASK_SOURCE_PACK_KINDS),
          eq(contextPackItems.role, "source"),
          eq(contextPackItems.sourceSessionId, input.sessionId),
        ),
      )
      .orderBy(
        asc(contextPacks.createdAt),
        asc(contextPacks.id),
        asc(contextPackItems.displayOrder),
        asc(contextPackItems.id),
      )
      .get() !== undefined;
  }

  appendTaskSourceItem(
    input: AppendTaskSourceItemInput,
  ): TaskSourceContextItem {
    const scopes=new TaskScopeResolver(this.db),scope=scopes.task(input.taskId);
    scopes.assertSame(scope,scopes.session(input.sessionId));
    const message=this.db.select().from(messages).where(eq(messages.id,input.messageId)).get();
    if(!message?.ownerSessionId)throw new Error("task_source_message_scope_required");
    scopes.assertSame(scope,scopes.session(message.ownerSessionId));
    const existing = this.findTaskSourceItemForMessage(
      input.taskId,
      input.messageId,
    );
    if (existing !== undefined) {
      this.appendTaskLaunchContextItems({
        packId: existing.contextPackId,
        sessionId: input.sessionId,
        sourceEntryId: existing.sourceEntryId,
        sourceTurnEntryId: input.sourceTurnEntryId ?? existing.sourceEntryId,
        sourceMessageId: input.messageId,
      });
      const sourceIdentityId = this.sourceIdentityIdForMessage(input.messageId);
      if (
        sourceIdentityId !== null &&
        existing.sourceIdentityId !== sourceIdentityId
      ) {
        this.db
          .update(contextPackItems)
          .set({ sourceIdentityId })
          .where(eq(contextPackItems.id, existing.id))
          .run();
        return this.requireTaskSourceItem(existing.id);
      }
      return existing;
    }

    const now = input.createdAt ?? Date.now();
    const sourceEntryId = input.sourceEntryId ??
      this.db
        .select({ id: sessionTimelineEntries.id })
        .from(sessionTimelineEntries)
        .where(
          and(
            eq(sessionTimelineEntries.sessionId, input.sessionId),
            eq(sessionTimelineEntries.messageId, input.messageId),
          ),
        )
        .get()?.id ?? null;
    const pack = this.findReusableTaskLaunchPack(input.taskId) ??
      this.createPack({
        ownerType: "task",
        ownerId: input.taskId,
        kind: "task_launch",
        selectionStrategy: "source_turn",
        triggerEntryId: sourceEntryId,
        triggerMessageId: input.messageId,
        createdForInvocationId: null,
        createdAt: now,
        metadataJson: null,
      });

    this.appendTaskLaunchContextItems({
      packId: pack.id,
      sessionId: input.sessionId,
      sourceEntryId,
      sourceTurnEntryId: input.sourceTurnEntryId ?? sourceEntryId,
      sourceMessageId: input.messageId,
    });
    const sourceIdentityId = this.sourceIdentityIdForMessage(input.messageId);
    const [item] = this.addItems(pack.id, [
      {
        itemKind: "message",
        itemId: input.messageId,
        sourceSessionId: input.sessionId,
        sourceEntryId,
        sourceMessageId: input.messageId,
        sourceIdentityId,
        role: "source",
        reason: "task source message",
        metadataJson: null,
      },
    ]).filter(
      (candidate) =>
        candidate.itemId === input.messageId && candidate.role === "source",
    );
    if (item === undefined) {
      throw new Error(
        `Task source item for task "${input.taskId}" and message "${input.messageId}" was not found after append.`,
      );
    }
    return this.requireTaskSourceItem(item.id);
  }

  private sourceIdentityIdForMessage(messageId: string): string | null {
    return (
      this.db
        .select({ senderIdentityId: messages.senderIdentityId })
        .from(messages)
        .where(eq(messages.id, messageId))
        .get()?.senderIdentityId ?? null
    );
  }

  private appendTaskLaunchContextItems(input: {
    readonly packId: string;
    readonly sessionId: string;
    readonly sourceEntryId: string | null;
    readonly sourceTurnEntryId: string | null;
    readonly sourceMessageId: string;
  }): void {
    const contextEntryId = input.sourceTurnEntryId ?? input.sourceEntryId;
    const turnEntries = contextEntryId === null
      ? []
      : uniqueTaskSourceTurnEntries(
          this.taskSourceTurnEntries(contextEntryId),
        ).filter((entry) => hasTaskLaunchInputRole(entry.turnRoles));
    const contextItems = turnEntries
      .filter(
        (entry) =>
          entry.entryId !== input.sourceEntryId &&
          entry.entryId !== contextEntryId,
      )
      .map((entry) => ({
        itemKind: "timeline_entry",
        itemId: entry.entryId,
        sourceSessionId: entry.sessionId,
        sourceEntryId: entry.entryId,
        sourceMessageId: entry.messageId,
        sourceIdentityId: entry.senderIdentityId,
        role: "launch_context",
        reason: "source turn context",
        metadataJson: {
          turnId: entry.turnId,
          turnRole: entry.turnRole,
          turnRoles: entry.turnRoles,
        },
      }));
    const attachmentItems = turnEntries
      .filter((entry) => hasAttachmentContent(entry.contentJson))
      .map((entry) => ({
        itemKind: "message",
        itemId: entry.messageId,
        sourceSessionId: entry.sessionId,
        sourceEntryId: entry.entryId,
        sourceMessageId: entry.messageId,
        sourceIdentityId: entry.senderIdentityId,
        role: "attachment",
        reason:
          entry.messageId === input.sourceMessageId
            ? "source message attachment"
            : "source turn attachment",
        metadataJson: {
          turnId: entry.turnId,
          turnRole: entry.turnRole,
          turnRoles: entry.turnRoles,
        },
      }));
    this.appendThreadLaunchContextItems(input);
    this.addMissingItems(input.packId, [...contextItems, ...attachmentItems]);
  }

  private appendThreadLaunchContextItems(input: {
    readonly packId: string;
    readonly sessionId: string;
    readonly sourceEntryId: string | null;
  }): void {
    if (input.sourceEntryId === null) {
      return;
    }
    const launchItems = this.listPacksForOwner("session", input.sessionId)
      .filter(
        (pack) =>
          pack.kind === "thread_launch" &&
          pack.triggerEntryId === input.sourceEntryId,
      )
      .flatMap((pack) =>
        this.listItemsForPack(pack.id)
          .filter((item) => item.role === "launch_context")
          .map((item) => ({
            ...item,
            sourcePackId: pack.id,
          })),
      );
    if (launchItems.length === 0) {
      return;
    }

    const contextItems = launchItems.map((item) => ({
      itemKind: item.itemKind,
      itemId: item.itemId,
      sourceSessionId: item.sourceSessionId,
      sourceEntryId: item.sourceEntryId,
      sourceMessageId: item.sourceMessageId,
      sourceIdentityId: item.sourceIdentityId,
      role: "launch_context",
      reason: "thread handoff launch context",
      metadataJson: {
        sourceContextPackId: item.sourcePackId,
        sourceContextItemId: item.id,
        sourceRole: item.role,
        sourceReason: item.reason,
      },
    }));
    const attachmentItems = launchItems
      .filter((item) => this.hasAttachmentForContextItem(item))
      .map((item) => ({
        itemKind: "message",
        itemId: item.sourceMessageId ?? item.itemId,
        sourceSessionId: item.sourceSessionId,
        sourceEntryId: item.sourceEntryId,
        sourceMessageId: item.sourceMessageId,
        sourceIdentityId: item.sourceIdentityId,
        role: "attachment",
        reason: "thread handoff launch attachment",
        metadataJson: {
          sourceContextPackId: item.sourcePackId,
          sourceContextItemId: item.id,
          sourceRole: item.role,
          sourceReason: item.reason,
        },
      }));

    this.addItems(input.packId, [...contextItems, ...attachmentItems]);
  }

  private addMissingItems(
    packId: string,
    items: readonly CreateContextPackItemInput[],
  ): ContextPackItemRow[] {
    return this.addItems(
      packId,
      items.filter(
        (item) =>
          this.findContextPackItem(
            packId,
            item.itemKind,
            item.itemId,
            item.role,
          ) === undefined,
      ),
    );
  }

  private hasAttachmentForContextItem(
    item: ContextPackItemRow & { readonly sourcePackId: string },
  ): boolean {
    const messageId = item.sourceMessageId ??
      (item.itemKind === "message" ? item.itemId : null);
    if (messageId === null) {
      return false;
    }
    const message = this.db
      .select({ contentJson: messages.contentJson })
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();
    return hasAttachmentContent(message?.contentJson);
  }

  private taskSourceTurnEntries(sourceEntryId: string): {
    readonly turnId: string;
    readonly turnRole: string;
    readonly entryId: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly senderIdentityId: string | null;
    readonly contentJson: unknown;
    readonly turnRoles?: readonly string[];
  }[] {
    const turnId = this.db
      .select({ turnId: sessionTurnEntries.turn_id })
      .from(sessionTurnEntries)
      .where(eq(sessionTurnEntries.entry_id, sourceEntryId))
      .orderBy(asc(sessionTurnEntries.created_at), asc(sessionTurnEntries.id))
      .get()?.turnId;
    if (turnId === undefined) {
      return [];
    }
    return this.db
      .select({
        turnId: sessionTurnEntries.turn_id,
        turnRole: sessionTurnEntries.role,
        entryId: sessionTimelineEntries.id,
        sessionId: sessionTimelineEntries.sessionId,
        messageId: sessionTimelineEntries.messageId,
        senderIdentityId: messages.senderIdentityId,
        contentJson: messages.contentJson,
      })
      .from(sessionTurnEntries)
      .innerJoin(
        sessionTimelineEntries,
        eq(sessionTimelineEntries.id, sessionTurnEntries.entry_id),
      )
      .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
      .where(eq(sessionTurnEntries.turn_id, turnId))
      .orderBy(
        asc(sessionTurnEntries.created_at),
        asc(sessionTimelineEntries.createdAt),
        asc(sessionTurnEntries.id),
      )
      .all();
  }

  moveSourceSessionReferences(
    sourceSessionId: string,
    canonicalSessionId: string,
  ): void {
    new ContextPackScope(this.db).move(sourceSessionId,canonicalSessionId);
    this.db
      .update(contextPackItems)
      .set({ sourceSessionId: canonicalSessionId })
      .where(eq(contextPackItems.sourceSessionId, sourceSessionId))
      .run();
  }

  moveOwnerPacksToCanonicalSession(
    sourceSessionId: string,
    canonicalSessionId: string,
  ): void {
    new ContextPackScope(this.db).move(sourceSessionId,canonicalSessionId);
    this.db
      .update(contextPacks)
      .set({ ownerId: canonicalSessionId })
      .where(
        and(
          eq(contextPacks.ownerType, "session"),
          eq(contextPacks.ownerId, sourceSessionId),
        ),
      )
      .run();
  }

  linkedSessionIdsForTask(taskId: string): string[] {
    const sessionIds: string[] = [];
    const seen = new Set<string>();
    const rows = this.db
      .select({ sourceSessionId: contextPackItems.sourceSessionId })
      .from(contextPackItems)
      .innerJoin(
        contextPacks,
        eq(contextPacks.id, contextPackItems.contextPackId),
      )
      .where(
        and(
          eq(contextPacks.ownerType, "task"),
          eq(contextPacks.ownerId, taskId),
          inArray(contextPacks.kind, TASK_SOURCE_PACK_KINDS),
          eq(contextPackItems.role, "source"),
        ),
      )
      .orderBy(
        asc(contextPacks.createdAt),
        asc(contextPacks.id),
        asc(contextPackItems.displayOrder),
        asc(contextPackItems.id),
      )
      .all();

    for (const row of rows) {
      if (row.sourceSessionId === null || seen.has(row.sourceSessionId)) {
        continue;
      }
      seen.add(row.sourceSessionId);
      sessionIds.push(row.sourceSessionId);
    }
    return sessionIds;
  }

  recordSeed(input: RecordRunnerSeedInput): RunnerContextSeedRecordRow {
    new ContextPackScope(this.db).seed(input);
    const row: typeof runnerContextSeedRecords.$inferInsert = {
      id: uuid(),
      runnerContextId: input.runnerContextId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      seedContextPackId: input.seedContextPackId,
      seedHash: input.seedHash,
      seedEntryIdsJson: [...input.seedEntryIdsJson],
      seedContextItemIdsJson: [...input.seedContextItemIdsJson],
      createdAt: input.createdAt ?? Date.now(),
    };

    const existing = this.findRunnerSeedRecord(
      input.runnerContextId,
      input.seedContextPackId,
    );
    if (existing !== undefined) {
      this.assertSameRunnerSeedRecord(existing, row);
      return existing;
    }

    this.db
      .insert(runnerContextSeedRecords)
      .values(row)
      .onConflictDoNothing({
        target: [
          runnerContextSeedRecords.runnerContextId,
          runnerContextSeedRecords.seedContextPackId,
        ],
      })
      .run();

    const insertedOrExisting = this.findRunnerSeedRecord(
      input.runnerContextId,
      input.seedContextPackId,
    );
    if (insertedOrExisting === undefined) {
      throw new Error(
        `Runner context seed record for runner context "${input.runnerContextId}" and context pack "${input.seedContextPackId}" was not found after record.`,
      );
    }
    this.assertSameRunnerSeedRecord(insertedOrExisting, row);
    return insertedOrExisting;
  }

  listSeedRecords(
    ownerType: ContextOwnerType,
    ownerId: string,
  ): RunnerContextSeedRecordRow[] {
    return this.db
      .select()
      .from(runnerContextSeedRecords)
      .where(
        and(
          eq(runnerContextSeedRecords.ownerType, ownerType),
          eq(runnerContextSeedRecords.ownerId, ownerId),
        ),
      )
      .orderBy(
        asc(runnerContextSeedRecords.createdAt),
        asc(runnerContextSeedRecords.id),
      )
      .all();
  }

  private requirePack(id: string): ContextPackRow {
    const row = this.db
      .select()
      .from(contextPacks)
      .where(eq(contextPacks.id, id))
      .get();
    if (row === undefined) {
      throw new Error(`Context pack "${id}" was not found after create.`);
    }
    return row;
  }

  private requireTaskSourceItem(itemId: string): TaskSourceContextItem {
    const row = this.listTaskSourceItems().find((item) => item.id === itemId);
    if (row === undefined) {
      throw new Error(`Task source context item "${itemId}" was not found.`);
    }
    return row;
  }

  private findTaskSourceItemForMessage(
    taskId: string,
    messageId: string,
  ): TaskSourceContextItem | undefined {
    const row = this.db
      .select({ id: contextPackItems.id })
      .from(contextPackItems)
      .innerJoin(
        contextPacks,
        eq(contextPacks.id, contextPackItems.contextPackId),
      )
      .where(
        and(
          eq(contextPacks.ownerType, "task"),
          eq(contextPacks.ownerId, taskId),
          inArray(contextPacks.kind, TASK_SOURCE_PACK_KINDS),
          eq(contextPackItems.role, "source"),
          eq(contextPackItems.sourceMessageId, messageId),
        ),
      )
      .orderBy(
        asc(contextPacks.createdAt),
        asc(contextPacks.id),
        asc(contextPackItems.displayOrder),
        asc(contextPackItems.id),
      )
      .get();
    return row === undefined ? undefined : this.requireTaskSourceItem(row.id);
  }

  private findReusableTaskLaunchPack(taskId: string): ContextPackRow | undefined {
    return this.db
      .select()
      .from(contextPacks)
      .where(
        and(
          eq(contextPacks.ownerType, "task"),
          eq(contextPacks.ownerId, taskId),
          eq(contextPacks.kind, "task_launch"),
        ),
      )
      .orderBy(asc(contextPacks.createdAt), asc(contextPacks.id))
      .get();
  }

  private findContextPackItem(
    packId: string,
    itemKind: string,
    itemId: string,
    role: string,
  ): ContextPackItemRow | undefined {
    return this.db
      .select()
      .from(contextPackItems)
      .where(
        and(
          eq(contextPackItems.contextPackId, packId),
          eq(contextPackItems.itemKind, itemKind),
          eq(contextPackItems.itemId, itemId),
          eq(contextPackItems.role, role),
        ),
      )
      .get();
  }

  private assertSameContextPackItem(
    existing: ContextPackItemRow,
    input: typeof contextPackItems.$inferInsert,
  ): void {
    if (
      existing.sourceEntryId !== input.sourceEntryId ||
      existing.sourceMessageId !== input.sourceMessageId ||
      existing.sourceSessionId !== input.sourceSessionId ||
      existing.sourceIdentityId !== input.sourceIdentityId ||
      existing.reason !== input.reason ||
      existing.displayOrder !== input.displayOrder ||
      !isDeepStrictEqual(existing.metadataJson, input.metadataJson)
    ) {
      throw new Error(
        `Conflicting context pack item for context pack "${input.contextPackId}", item "${input.itemKind}:${input.itemId}", and role "${input.role}".`,
      );
    }
  }

  private findRunnerSeedRecord(
    runnerContextId: string,
    seedContextPackId: string,
  ): RunnerContextSeedRecordRow | undefined {
    return this.db
      .select()
      .from(runnerContextSeedRecords)
      .where(
        and(
          eq(runnerContextSeedRecords.runnerContextId, runnerContextId),
          eq(runnerContextSeedRecords.seedContextPackId, seedContextPackId),
        ),
      )
      .get();
  }

  private assertSameRunnerSeedRecord(
    existing: RunnerContextSeedRecordRow,
    input: typeof runnerContextSeedRecords.$inferInsert,
  ): void {
    if (
      existing.seedHash !== input.seedHash ||
      !isDeepStrictEqual(existing.seedEntryIdsJson, input.seedEntryIdsJson) ||
      !isDeepStrictEqual(
        existing.seedContextItemIdsJson,
        input.seedContextItemIdsJson,
      ) ||
      existing.ownerType !== input.ownerType ||
      existing.ownerId !== input.ownerId
    ) {
      throw new Error(
        `Conflicting runner context seed record for runner context "${input.runnerContextId}" and context pack "${input.seedContextPackId}".`,
      );
    }
  }
}

function nextContextPackCreatedAt(): number {
  const now = Date.now();
  const createdAt = Math.max(now, lastContextPackCreatedAt + 1);
  lastContextPackCreatedAt = createdAt;
  return createdAt;
}

function hasAttachmentContent(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      ("type" in block) &&
      (block.type === "image" || block.type === "file"),
  );
}

function uniqueTaskSourceTurnEntries(
  entries: readonly {
    readonly turnId: string;
    readonly turnRole: string;
    readonly entryId: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly senderIdentityId: string | null;
    readonly contentJson: unknown;
  }[],
): {
  readonly turnId: string;
  readonly turnRole: string;
  readonly turnRoles: readonly string[];
  readonly entryId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly senderIdentityId: string | null;
  readonly contentJson: unknown;
}[] {
  const byEntryId = new Map<
    string,
    {
      turnId: string;
      turnRole: string;
      turnRoles: string[];
      entryId: string;
      sessionId: string;
      messageId: string;
      senderIdentityId: string | null;
      contentJson: unknown;
    }
  >();
  for (const entry of entries) {
    const existing = byEntryId.get(entry.entryId);
    if (existing === undefined) {
      byEntryId.set(entry.entryId, {
        ...entry,
        turnRoles: [entry.turnRole],
      });
      continue;
    }
    if (!existing.turnRoles.includes(entry.turnRole)) {
      existing.turnRoles.push(entry.turnRole);
    }
    if (
      !isTaskLaunchInputTurnRole(existing.turnRole) &&
      isTaskLaunchInputTurnRole(entry.turnRole)
    ) {
      existing.turnRole = entry.turnRole;
    }
  }
  return Array.from(byEntryId.values());
}

function hasTaskLaunchInputRole(roles: readonly string[]): boolean {
  return roles.some((role) => isTaskLaunchInputTurnRole(role));
}

function isTaskLaunchInputTurnRole(role: string): boolean {
  return (
    role === "trigger" ||
    role === "coalesced_input" ||
    role === "context" ||
    role === "launch_context"
  );
}
