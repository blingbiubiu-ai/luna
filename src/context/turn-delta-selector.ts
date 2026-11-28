import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ContextPackStore, type CreateContextPackItemInput } from "./context-pack-store";
import type { DrizzleDB } from "@/data";
import {
  contextPackItems,
  contextPacks,
  messages,
  notificationAttempts,
  runnerContextSeedRecords,
  runnerInvocations,
  runnerJobs,
  sessionCommands,
  sessionRunnerAttempts,
  sessionTimelineEntries,
  sessionTriggers,
  sessionTurnEntries,
  sessionTurns,
  type MemoryOriginKind,
} from "@/data/schema";
import { SELF_ROUTINE_ORIGINS } from "@/agents/self-routines/types";
import type { ResolvedRunnerContext } from "@/runners/runner-context-store";
import type { MessageAuthoredBy } from "@/messaging/session-command-service";

const RECENT_TIMELINE_SCAN_LIMIT = 50;
const DEFAULT_COLD_RECENT_LIMIT = 30;
const MAX_OUT_OF_BAND_MESSAGES = 10;
const MAX_OUT_OF_BAND_TOTAL_CHARS = 6000;
const MAX_OUT_OF_BAND_ITEM_CHARS = 1500;
const FALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type OutOfBandReason =
  | "out_of_band:cross_session"
  | "out_of_band:schedule"
  | "out_of_band:routine"
  | "out_of_band:service";

export interface OutOfBandCandidate {
  readonly entry: typeof sessionTimelineEntries.$inferSelect;
  readonly message: typeof messages.$inferSelect;
  readonly command: typeof sessionCommands.$inferSelect | undefined;
  readonly reason: OutOfBandReason;
  readonly via: "request" | "message" | "schedule" | "routine" | "service";
}

export interface EnsureTurnDeltaPackInput {
  readonly db: DrizzleDB;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runnerContext: ResolvedRunnerContext;
  readonly turnFlavor: "user_messages" | "session_trigger" | "task_result";
  readonly memoryOrigin?: MemoryOriginKind | undefined;
  readonly excludeEntryIds?: ReadonlySet<string> | undefined;
  readonly launchSeedEntryIds?: ReadonlySet<string> | undefined;
  readonly now?: number | undefined;
}

export interface SelectOutOfBandCandidatesInput {
  readonly db: DrizzleDB;
  readonly sessionId: string;
  readonly runnerContext: ResolvedRunnerContext;
  readonly currentInvocationId?: string | undefined;
  readonly excludeEntryIds?: ReadonlySet<string> | undefined;
  readonly now?: number | undefined;
}

/**
 * Classifies whether an assistant message row was authored outside this session's
 * own Runner turns (e.g. cross-session asks/sends, scheduled reminders, routines,
 * or Service diagnostics), and derives its origin label.
 */
export function classifyOutOfBandAssistantMessage(
  db: DrizzleDB,
  sessionId: string,
  entry: typeof sessionTimelineEntries.$inferSelect,
  message: typeof messages.$inferSelect,
  commandCache?: Map<string, typeof sessionCommands.$inferSelect | null>,
): OutOfBandCandidate | undefined {
  if (message.role !== "assistant" || message.deletedAt !== null) return undefined;
  if (
    message.presentationKind === "status_card" ||
    message.presentationKind === "task_result_card"
  ) {
    return undefined;
  }

  const raw = (message.rawPayloadJson ?? null) as Record<string, unknown> | null;
  if (raw?.origin === "session_trigger" || raw?.origin === "task_result_event") {
    return undefined;
  }

  const commandId = extractCommandId(message.externalMessageId, raw);
  if (!commandId) return undefined;

  let command = commandCache?.get(commandId);
  if (command === undefined) {
    command =
      db
        .select()
        .from(sessionCommands)
        .where(eq(sessionCommands.id, commandId))
        .get() ?? null;
    commandCache?.set(commandId, command);
  }
  if (!command) {
    // Legacy command-backed message whose session_commands row is missing: rely on rawPayload.
    if (raw?.deliveryStatus && raw.deliveryStatus !== "sent") return undefined;
    const rawSource = typeof raw?.sourceSessionId === "string" ? raw.sourceSessionId : undefined;
    if (rawSource && rawSource !== sessionId) {
      return { entry, message, command: undefined, reason: "out_of_band:cross_session", via: "message" };
    }
    return undefined;
  }

  // Only surface messages that have actually been delivered (or settled on local channels).
  if (command.status !== "sent") return undefined;

  const authoredBy = resolveAuthoredBy(db, sessionId, command);
  if (authoredBy === "runner") return undefined;

  const { reason, via } = classifyReasonAndVia(sessionId, command, authoredBy);
  return { entry, message, command, reason, via };
}

function extractCommandId(
  channelMessageKey: string | null,
  raw: Record<string, unknown> | null,
): string | undefined {
  if (channelMessageKey?.startsWith("command:")) {
    return channelMessageKey.slice("command:".length);
  }
  return typeof raw?.commandId === "string" ? raw.commandId : undefined;
}

function resolveAuthoredBy(
  db: DrizzleDB,
  sessionId: string,
  command: typeof sessionCommands.$inferSelect,
): MessageAuthoredBy {
  const explicit = command.payload?.authoredBy;
  if (explicit === "runner" || explicit === "cross_session" || explicit === "service") {
    return explicit;
  }
  if (command.sourceSessionId !== sessionId) {
    return "cross_session";
  }
  if (
    command.dedupeKey.endsWith(":service-final-answer")
  ) {
    return "runner";
  }
  if (
    command.dedupeKey.endsWith(":service-execution-error") ||
    command.originId.startsWith("schedule:") ||
    command.originId.startsWith("schedule-failure:") ||
    command.originId.startsWith(SELF_ROUTINE_ORIGINS.reflection) ||
    command.originId.startsWith(SELF_ROUTINE_ORIGINS.consolidation) ||
    command.originId.startsWith(SELF_ROUTINE_ORIGINS.heartbeat) ||
    command.originId.startsWith(SELF_ROUTINE_ORIGINS.request_expiry)
  ) {
    return "service";
  }
  const runnerInvocation = db
    .select({ id: runnerInvocations.id })
    .from(runnerInvocations)
    .where(
      and(
        eq(runnerInvocations.originId, command.originId),
        eq(runnerInvocations.sessionId, sessionId),
        eq(runnerInvocations.runnerKind, "main"),
      ),
    )
    .limit(1)
    .get();
  if (runnerInvocation) {
    return "runner";
  }
  // In unit tests without ExecutionRuntime, `runner_invocations` may be empty while `originId`
  // is a session turn id or `task-result:<runId>:<sessionId>` from a Main Runner turn.
  if (command.originId.startsWith("task-result:")) {
    return "runner";
  }
  const turn = db
    .select({ id: sessionTurns.id })
    .from(sessionTurns)
    .where(
      and(
        eq(sessionTurns.id, command.originId),
        eq(sessionTurns.session_id, sessionId),
      ),
    )
    .limit(1)
    .get();
  if (turn) {
    return "runner";
  }
  return "service";
}

function classifyReasonAndVia(
  sessionId: string,
  command: typeof sessionCommands.$inferSelect,
  authoredBy: Exclude<MessageAuthoredBy, "runner">,
): { readonly reason: OutOfBandReason; readonly via: OutOfBandCandidate["via"] } {
  const dedupeSuffix = command.dedupeKey.slice(
    `${command.sourceSessionId}:${command.originId}:`.length,
  );
  if (
    dedupeSuffix.startsWith("request-card:") ||
    dedupeSuffix.startsWith("request:") ||
    dedupeSuffix.startsWith("ask:")
  ) {
    return {
      reason:
        command.sourceSessionId !== sessionId
          ? "out_of_band:cross_session"
          : "out_of_band:service",
      via: "request",
    };
  }
  if (
    command.originId.startsWith("schedule:") ||
    command.originId.startsWith("schedule-failure:") ||
    dedupeSuffix === "occurrence"
  ) {
    return { reason: "out_of_band:schedule", via: "schedule" };
  }
  if (
    command.originId.startsWith(SELF_ROUTINE_ORIGINS.reflection) ||
    command.originId.startsWith(SELF_ROUTINE_ORIGINS.consolidation) ||
    command.originId.startsWith(SELF_ROUTINE_ORIGINS.heartbeat) ||
    command.originId.startsWith(SELF_ROUTINE_ORIGINS.request_expiry)
  ) {
    return { reason: "out_of_band:routine", via: "routine" };
  }
  if (authoredBy === "cross_session" || command.sourceSessionId !== sessionId) {
    return { reason: "out_of_band:cross_session", via: "message" };
  }
  return { reason: "out_of_band:service", via: "service" };
}

/**
 * Computes timeline entry IDs that have already been delivered to `runnerContext`'s
 * current provider session (via completed turns, settled delta context packs, or a
 * provider CLI that reported its session before interruption).
 */
export function deliveredEntryIdsForContext(
  db: DrizzleDB,
  sessionId: string,
  runnerContext: ResolvedRunnerContext,
  currentInvocationId?: string,
): { readonly entryIds: Set<string>; readonly lowerBoundMs: number | undefined } {
  const entryIds = new Set<string>();

  // 1. Entries attached to any completed session turn.
  const turnRows = db
    .select({ entryId: sessionTurnEntries.entry_id })
    .from(sessionTurnEntries)
    .innerJoin(sessionTurns, eq(sessionTurns.id, sessionTurnEntries.turn_id))
    .where(
      and(
        eq(sessionTurnEntries.session_id, sessionId),
        eq(sessionTurns.status, "completed"),
        sql`${sessionTurnEntries.role} IN ('trigger', 'coalesced_input', 'context', 'launch_context', 'output')`,
      ),
    )
    .all();
  for (const row of turnRows) {
    entryIds.add(row.entryId);
  }

  // 2. Seed baseline for the current runner context: anything recorded in its latest seed
  //    or occurring before that seed is already covered by the provider session's launch.
  const latestSeed = db
    .select()
    .from(runnerContextSeedRecords)
    .where(
      and(
        eq(runnerContextSeedRecords.runnerContextId, runnerContext.id),
        eq(runnerContextSeedRecords.ownerType, "session"),
        eq(runnerContextSeedRecords.ownerId, sessionId),
      ),
    )
    .orderBy(desc(runnerContextSeedRecords.createdAt), desc(runnerContextSeedRecords.id))
    .limit(1)
    .get();
  if (latestSeed && Array.isArray(latestSeed.seedEntryIdsJson)) {
    for (const id of latestSeed.seedEntryIdsJson) {
      if (typeof id === "string") entryIds.add(id);
    }
  }

  // 3. Delta packs (`turn_delta` / `group_activation`) belonging to invocations whose turn
  //    already delivered input to the provider session (completed turn, settled trigger/attempt,
  //    or provider CLI reported `sessionId`).
  const candidatePacks = db
    .select()
    .from(contextPacks)
    .where(
      and(
        eq(contextPacks.ownerType, "session"),
        eq(contextPacks.ownerId, sessionId),
        inArray(contextPacks.kind, ["turn_delta", "group_activation"]),
      ),
    )
    .all();

  for (const pack of candidatePacks) {
    const invId = pack.createdForInvocationId;
    if (!invId || invId === currentInvocationId) continue;
    if (latestSeed && pack.createdAt < latestSeed.createdAt) continue;
    if (!wasDeltaPackDelivered(db, sessionId, runnerContext, invId)) continue;
    const items = db
      .select({
        itemKind: contextPackItems.itemKind,
        itemId: contextPackItems.itemId,
        sourceEntryId: contextPackItems.sourceEntryId,
      })
      .from(contextPackItems)
      .where(eq(contextPackItems.contextPackId, pack.id))
      .all();
    for (const item of items) {
      const eId = item.itemKind === "timeline_entry" ? item.itemId : item.sourceEntryId;
      if (eId) entryIds.add(eId);
    }
  }

  return { entryIds, lowerBoundMs: latestSeed?.createdAt };
}

function wasDeltaPackDelivered(
  db: DrizzleDB,
  sessionId: string,
  runnerContext: ResolvedRunnerContext,
  invocationOwnerId: string,
): boolean {
  // Completed session turn (inbound user turn or session_trigger turn).
  const turn = db
    .select({ status: sessionTurns.status })
    .from(sessionTurns)
    .where(eq(sessionTurns.id, invocationOwnerId))
    .get();
  if (turn?.status === "completed") return true;

  // Parsed runner attempt on the current provider session.
  if (runnerContext.runner_session_id !== null) {
    const parsedAttempt = db
      .select({ id: sessionRunnerAttempts.id })
      .from(sessionRunnerAttempts)
      .where(
        and(
          eq(sessionRunnerAttempts.turnId, invocationOwnerId),
          eq(sessionRunnerAttempts.runnerContextId, runnerContext.id),
          eq(sessionRunnerAttempts.runnerSessionId, runnerContext.runner_session_id),
          eq(sessionRunnerAttempts.status, "parsed"),
        ),
      )
      .limit(1)
      .get();
    if (parsedAttempt) return true;
  }

  // Settled task_result notification attempt or completed session_trigger row.
  const notif = db
    .select({ status: notificationAttempts.status })
    .from(notificationAttempts)
    .where(eq(notificationAttempts.id, invocationOwnerId))
    .get();
  if (notif && (notif.status === "sent" || notif.status === "skipped")) {
    return true;
  }
  const trigger = db
    .select({ status: sessionTriggers.status })
    .from(sessionTriggers)
    .where(eq(sessionTriggers.id, invocationOwnerId))
    .get();
  if (trigger?.status === "completed") return true;

  // Interrupted turn where the provider CLI had already reported its session id.
  const jobs = db
    .select({ state: runnerJobs.providerState })
    .from(runnerJobs)
    .innerJoin(runnerInvocations, eq(runnerInvocations.id, runnerJobs.invocationId))
    .where(
      and(
        eq(runnerInvocations.sessionId, sessionId),
        eq(runnerInvocations.originId, invocationOwnerId),
      ),
    )
    .all();
  return jobs.some(
    job => typeof (job.state as { sessionId?: unknown } | null)?.sessionId === "string",
  );
}

/**
 * Selects unseen out-of-band assistant messages for a resumed Main Runner session,
 * bounded by count (`10`) and character budget (`6000` total).
 */
export function selectOutOfBandCandidates(
  input: SelectOutOfBandCandidatesInput,
): { readonly selected: readonly OutOfBandCandidate[]; readonly omittedCount: number } {
  const now = input.now ?? Date.now();
  const { entryIds: deliveredEntryIds, lowerBoundMs } = deliveredEntryIdsForContext(
    input.db,
    input.sessionId,
    input.runnerContext,
    input.currentInvocationId,
  );
  const cutoffMs = lowerBoundMs ?? now - FALLBACK_LOOKBACK_MS;
  const commandCache = new Map<string, typeof sessionCommands.$inferSelect | null>();

  const rows = input.db
    .select({ entry: sessionTimelineEntries, message: messages })
    .from(sessionTimelineEntries)
    .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .where(
      and(
        eq(sessionTimelineEntries.sessionId, input.sessionId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(sessionTimelineEntries.createdAt), desc(sessionTimelineEntries.id))
    .limit(RECENT_TIMELINE_SCAN_LIMIT)
    .all()
    .reverse();

  const eligible: OutOfBandCandidate[] = [];
  for (const row of rows) {
    if (input.excludeEntryIds?.has(row.entry.id)) continue;
    if (deliveredEntryIds.has(row.entry.id)) continue;
    if (row.message.occurredAt < cutoffMs && row.entry.createdAt < cutoffMs) continue;
    const classified = classifyOutOfBandAssistantMessage(
      input.db,
      input.sessionId,
      row.entry,
      row.message,
      commandCache,
    );
    if (classified) {
      eligible.push(classified);
    }
  }

  if (eligible.length === 0) {
    return { selected: [], omittedCount: 0 };
  }

  // Keep the newest items within count and character budgets, then restore chronological order.
  const keptReversed: OutOfBandCandidate[] = [];
  let totalChars = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    if (keptReversed.length >= MAX_OUT_OF_BAND_MESSAGES) break;
    const candidate = eligible[i]!;
    const estChars = Math.min(
      estimateMessageChars(candidate.message),
      MAX_OUT_OF_BAND_ITEM_CHARS,
    );
    if (keptReversed.length > 0 && totalChars + estChars > MAX_OUT_OF_BAND_TOTAL_CHARS) {
      break;
    }
    totalChars += estChars;
    keptReversed.push(candidate);
  }

  const selected = keptReversed.reverse();
  return {
    selected,
    omittedCount: Math.max(0, eligible.length - selected.length),
  };
}

function estimateMessageChars(message: typeof messages.$inferSelect): number {
  if (!Array.isArray(message.contentJson)) return 0;
  let total = 0;
  for (const block of message.contentJson as readonly Record<string, unknown>[]) {
    if (typeof block?.text === "string") total += block.text.length;
  }
  return total;
}

export function outOfBandPackItemInput(
  sessionId: string,
  candidate: OutOfBandCandidate,
  displayOrder?: number,
): CreateContextPackItemInput {
  const command = candidate.command;
  return {
    itemKind: "timeline_entry",
    itemId: candidate.entry.id,
    sourceSessionId: sessionId,
    sourceEntryId: candidate.entry.id,
    sourceMessageId: candidate.message.id,
    sourceIdentityId: candidate.message.senderIdentityId ?? null,
    role: "delta_context",
    reason: candidate.reason,
    ...(displayOrder !== undefined ? { displayOrder } : {}),
    metadataJson: {
      via: candidate.via,
      ...(command
        ? {
            commandId: command.id,
            originSessionId: command.sourceSessionId,
            correlationId: command.correlationId,
          }
        : {}),
      createdAt: candidate.message.createdAt,
    },
  };
}

/**
 * Ensures a `turn_delta` context pack for a Main Runner turn when unseen context exists:
 * - On `session_trigger` turns, preserves existing cold-launch recent window and resumed
 *   unaddressed user-message selection, plus unseen out-of-band assistant messages.
 * - On `user_messages` (when no `group_activation` pack owns delta) and `task_result` turns,
 *   attaches unseen out-of-band assistant messages on resumed provider sessions (cold launches
 *   rely on `launchSeed`).
 */
export function ensureTurnDeltaPack(input: EnsureTurnDeltaPackInput): string | undefined {
  const { db, sessionId, invocationId, runnerContext, turnFlavor } = input;
  if (turnFlavor === "session_trigger") {
    if (input.memoryOrigin === "consolidation") return undefined;
    if (input.memoryOrigin === "reflection" && runnerContext.runner_session_id !== null) {
      return undefined;
    }
  }

  const packs = new ContextPackStore(db);
  const existing = packs
    .listPacksForOwner("session", sessionId)
    .find(pack => pack.kind === "turn_delta" && pack.createdForInvocationId === invocationId);
  if (existing) return existing.id;

  const hasSession = runnerContext.runner_session_id !== null;

  const launchSeedEntryIds = input.launchSeedEntryIds ?? new Set<string>();

  if (!hasSession && turnFlavor === "session_trigger") {
    const recentCold = db
      .select({ entry: sessionTimelineEntries, message: messages })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
      .where(and(eq(sessionTimelineEntries.sessionId, sessionId), isNull(messages.deletedAt)))
      .orderBy(desc(sessionTimelineEntries.createdAt), desc(sessionTimelineEntries.id))
      .limit(DEFAULT_COLD_RECENT_LIMIT)
      .all()
      .reverse()
      .filter(row => {
        if (launchSeedEntryIds.has(row.entry.id)) return false;
        if (input.excludeEntryIds?.has(row.entry.id)) return false;
        const raw = row.message.rawPayloadJson as Record<string, unknown> | null;
        if ((raw?.deliveryStatus && raw.deliveryStatus !== "sent") || raw?.origin === "session_trigger") {
          return false;
        }
        return true;
      });

    if (recentCold.length === 0) return undefined;
    const pack = packs.createPack({
      ownerType: "session",
      ownerId: sessionId,
      kind: "turn_delta",
      selectionStrategy: "trigger_recent_context",
      createdForInvocationId: invocationId,
    });
    const commandCache = new Map<string, typeof sessionCommands.$inferSelect | null>();
    packs.addItems(
      pack.id,
      recentCold.map((row, index) => {
        const oob = classifyOutOfBandAssistantMessage(
          db,
          sessionId,
          row.entry,
          row.message,
          commandCache,
        );
        if (oob) {
          return outOfBandPackItemInput(sessionId, oob, index);
        }
        return {
          itemKind: "timeline_entry",
          itemId: row.entry.id,
          sourceSessionId: sessionId,
          sourceEntryId: row.entry.id,
          sourceMessageId: row.message.id,
          role: "delta_context",
          reason: "trigger_recent_context",
          displayOrder: index,
        };
      }),
    );
    return pack.id;
  }

  // Resumed provider session (`runner_session_id !== null`) or seedless cold `user_messages` / `task_result` turn.
  const combinedExcludes =
    launchSeedEntryIds.size > 0
      ? new Set([...(input.excludeEntryIds ?? []), ...launchSeedEntryIds])
      : input.excludeEntryIds;
  const outOfBand = selectOutOfBandCandidates({
    db,
    sessionId,
    runnerContext,
    currentInvocationId: invocationId,
    excludeEntryIds: combinedExcludes,
    now: input.now,
  });

  const mergedItems: Array<{
    readonly occurredAt: number;
    readonly entryCreatedAt: number;
    readonly item: CreateContextPackItemInput;
  }> = outOfBand.selected.map(candidate => ({
    occurredAt: candidate.message.occurredAt,
    entryCreatedAt: candidate.entry.createdAt,
    item: outOfBandPackItemInput(sessionId, candidate),
  }));

  if (turnFlavor === "session_trigger") {
    const lastAttemptStartedAt = db
      .select({ startedAt: sessionRunnerAttempts.startedAt })
      .from(sessionRunnerAttempts)
      .where(
        and(
          eq(sessionRunnerAttempts.sessionId, sessionId),
          eq(sessionRunnerAttempts.runnerContextId, runnerContext.id),
          eq(sessionRunnerAttempts.runnerSessionId, runnerContext.runner_session_id!),
          eq(sessionRunnerAttempts.status, "parsed"),
        ),
      )
      .orderBy(desc(sessionRunnerAttempts.startedAt))
      .get()?.startedAt;

    const { entryIds: deliveredEntryIds } = deliveredEntryIdsForContext(
      db,
      sessionId,
      runnerContext,
      invocationId,
    );

    const recentUserRows = db
      .select({ entry: sessionTimelineEntries, message: messages })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
      .where(and(eq(sessionTimelineEntries.sessionId, sessionId), isNull(messages.deletedAt)))
      .orderBy(desc(sessionTimelineEntries.createdAt), desc(sessionTimelineEntries.id))
      .limit(DEFAULT_COLD_RECENT_LIMIT)
      .all()
      .reverse()
      .filter(row => {
        if (row.message.role === "assistant") return false;
        if (input.excludeEntryIds?.has(row.entry.id)) return false;
        if (deliveredEntryIds.has(row.entry.id)) return false;
        const raw = row.message.rawPayloadJson as Record<string, unknown> | null;
        if ((raw?.deliveryStatus && raw.deliveryStatus !== "sent") || raw?.origin === "session_trigger") {
          return false;
        }
        return lastAttemptStartedAt === undefined || row.entry.createdAt >= lastAttemptStartedAt;
      });

    const seenEntryIds = new Set(outOfBand.selected.map(c => c.entry.id));
    for (const row of recentUserRows) {
      if (seenEntryIds.has(row.entry.id)) continue;
      mergedItems.push({
        occurredAt: row.message.occurredAt,
        entryCreatedAt: row.entry.createdAt,
        item: {
          itemKind: "timeline_entry",
          itemId: row.entry.id,
          sourceSessionId: sessionId,
          sourceEntryId: row.entry.id,
          sourceMessageId: row.message.id,
          role: "delta_context",
          reason: "trigger_recent_context",
        },
      });
    }
  }

  if (mergedItems.length === 0) return undefined;

  mergedItems.sort(
    (a, b) => a.occurredAt - b.occurredAt || a.entryCreatedAt - b.entryCreatedAt,
  );

  const strategy =
    turnFlavor === "session_trigger"
      ? "trigger_recent_context"
      : "out_of_band_delta";
  const pack = packs.createPack({
    ownerType: "session",
    ownerId: sessionId,
    kind: "turn_delta",
    selectionStrategy: strategy,
    createdForInvocationId: invocationId,
    ...(outOfBand.omittedCount > 0
      ? { metadataJson: { omittedOutOfBandCount: outOfBand.omittedCount } }
      : {}),
  });
  packs.addItems(
    pack.id,
    mergedItems.map((entry, index) => ({
      ...entry.item,
      displayOrder: index,
    })),
  );
  return pack.id;
}

export const MAX_OUT_OF_BAND_RENDER_ITEM_CHARS = MAX_OUT_OF_BAND_ITEM_CHARS;
