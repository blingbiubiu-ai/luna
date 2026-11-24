import { and, asc, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { messages, sessions, sessionTimelineEntries } from "@/data/schema";
import type { ActivationContextMessage } from "@/main-runner/types";
import { MessageStore } from "@/sessions/message-store";
import { SessionTimelineReader } from "@/sessions/session-timeline-reader";
import { SessionTimelineStore } from "@/sessions/session-timeline-store";

import {
  ContextPackStore,
  type ContextPackRow,
  type CreateContextPackItemInput,
} from "./context-pack-store";
import {
  outOfBandPackItemInput,
  type OutOfBandCandidate,
} from "./turn-delta-selector";

type TimelineItem = ReturnType<SessionTimelineReader["listForSession"]>[number];

interface SelectedLaunchMessage {
  readonly source: "thread" | "root";
  readonly item: TimelineItem;
  readonly reason:
    | "thread launch recent thread context"
    | "thread launch root supplemental context"
    | "thread anchor message";
}

export class LaunchContextBuilder {
  private readonly _contextPacks: ContextPackStore;
  private readonly _timelineReader: SessionTimelineReader;
  private readonly _timelineStore: SessionTimelineStore;

  constructor(private readonly _db: DrizzleDB) {
    this._contextPacks = new ContextPackStore(_db);
    this._timelineReader = new SessionTimelineReader(_db);
    this._timelineStore = new SessionTimelineStore(_db);
  }

  buildForSessionRelaunch(input: {
    readonly sessionId: string;
    readonly createdForInvocationId: string;
    readonly triggerEntryId: string;
    readonly triggerMessageId: string;
    readonly excludeEntryIds: readonly string[];
    readonly maxMessages: number;
    readonly maxChars: number;
  }): ContextPackRow | undefined {
    const existing = this._contextPacks
      .listPacksForOwner("session", input.sessionId)
      .find(
        (pack) =>
          pack.kind === "session_launch" &&
          pack.createdForInvocationId === input.createdForInvocationId,
      );
    if (existing !== undefined) {
      return existing;
    }

    const excludedEntryIds = new Set(input.excludeEntryIds);
    const selected = selectSessionRelaunchMessages({
      items: this._timelineReader
        .listForSession(input.sessionId)
        .filter((item) => !excludedEntryIds.has(item.entry.id)),
      maxMessages: input.maxMessages,
      maxChars: input.maxChars,
    });
    if (selected.length === 0) {
      return undefined;
    }

    const pack = this._contextPacks.createPack({
      ownerType: "session",
      ownerId: input.sessionId,
      kind: "session_launch",
      selectionStrategy: "deterministic_window",
      triggerEntryId: input.triggerEntryId,
      triggerMessageId: input.triggerMessageId,
      createdForInvocationId: input.createdForInvocationId,
    });
    this._contextPacks.addItems(
      pack.id,
      selected.map((item, displayOrder) => ({
        itemKind: "timeline_entry",
        itemId: item.entry.id,
        sourceSessionId: input.sessionId,
        sourceEntryId: item.entry.id,
        sourceMessageId: item.message.id,
        sourceIdentityId: item.message.senderIdentityId ?? null,
        role: "seed",
        reason: "session relaunch recent context",
        displayOrder,
      })),
    );
    return pack;
  }

  buildForGroupActivation(input: {
    readonly sessionId: string;
    readonly activationEntryId: string;
    readonly activationMessageId: string;
    readonly contextMessages: readonly ActivationContextMessage[];
    readonly outOfBandCandidates?: readonly OutOfBandCandidate[];
    readonly omittedOutOfBandCount?: number;
    readonly createdForInvocationId?: string | null;
  }): ContextPackRow {
    const existing = this._contextPacks
      .listPacksForOwner("session", input.sessionId)
      .find(
        (pack) =>
          pack.kind === "group_activation" &&
          pack.triggerEntryId === input.activationEntryId &&
          pack.triggerMessageId === input.activationMessageId &&
          pack.createdForInvocationId === (input.createdForInvocationId ?? null),
      );
    if (existing !== undefined) {
      return existing;
    }

    const pack = this._contextPacks.createPack({
      ownerType: "session",
      ownerId: input.sessionId,
      kind: "group_activation",
      selectionStrategy: "deterministic_window",
      triggerEntryId: input.activationEntryId,
      triggerMessageId: input.activationMessageId,
      createdForInvocationId: input.createdForInvocationId ?? null,
      ...(input.omittedOutOfBandCount && input.omittedOutOfBandCount > 0
        ? { metadataJson: { omittedOutOfBandCount: input.omittedOutOfBandCount } }
        : {}),
    });
    const seenMessageIds = new Set<string>();
    const combined: Array<{
      readonly occurredAt: number;
      readonly item: CreateContextPackItemInput;
    }> = [];
    for (const message of input.contextMessages) {
      seenMessageIds.add(message.messageId);
      const source = this._findTimelineMessageSource({
        sessionId: input.sessionId,
        messageId: message.messageId,
      });
      combined.push({
        occurredAt: message.createdAt,
        item: {
          itemKind: source ? "timeline_entry" : "message",
          itemId: source?.entryId ?? message.messageId,
          sourceSessionId: input.sessionId,
          sourceEntryId: source?.entryId ?? null,
          sourceMessageId: message.messageId,
          sourceIdentityId: source?.senderIdentityId ?? null,
          role: "delta_context",
          reason: "group activation context",
          metadataJson: {
            ...(message.channelMessageKey !== undefined
              ? { channelMessageKey: message.channelMessageKey }
              : {}),
            ...(message.senderUserId !== undefined
              ? { senderUserId: message.senderUserId }
              : {}),
            createdAt: message.createdAt,
          },
        },
      });
    }
    for (const candidate of input.outOfBandCandidates ?? []) {
      if (seenMessageIds.has(candidate.message.id)) continue;
      seenMessageIds.add(candidate.message.id);
      combined.push({
        occurredAt: candidate.message.occurredAt,
        item: outOfBandPackItemInput(input.sessionId, candidate),
      });
    }
    combined.sort((a, b) => a.occurredAt - b.occurredAt);
    this._contextPacks.addItems(
      pack.id,
      combined.map((entry, index) => ({
        ...entry.item,
        displayOrder: index,
      })),
    );
    return pack;
  }

  buildForThreadSession(input: {
    readonly threadSessionId: string;
    readonly rootSessionId: string;
    readonly anchorExternalMessageId: string;
    readonly maxMessages: number;
    readonly maxChars: number;
  }): ContextPackRow | undefined {
    const root=this._db.select().from(sessions).where(eq(sessions.id,input.rootSessionId)).get();
    const thread=this._db.select().from(sessions).where(eq(sessions.id,input.threadSessionId)).get();
    if(!root||!thread||root.agent_id!==thread.agent_id||root.shadow_id!==thread.shadow_id||root.binding_id!==thread.binding_id)throw new Error("thread_context_scope_mismatch");
    const rootItems = this._timelineReader.listForSession(input.rootSessionId);
    const anchorIndex = rootItems.findIndex(
      (item) => item.message.externalMessageId === input.anchorExternalMessageId,
    );
    if (anchorIndex < 0) {
      return undefined;
    }

    const anchorItem = rootItems[anchorIndex];
    if (anchorItem === undefined) {
      return undefined;
    }

    const existing = this._contextPacks
      .listPacksForOwner("session", input.threadSessionId)
      .find(
        (pack) =>
          pack.kind === "thread_launch" &&
          pack.triggerMessageId === anchorItem.message.id,
      );
    if (existing !== undefined) {
      return existing;
    }

    const threadItems = this._timelineReader
      .listForSession(input.threadSessionId)
      .filter((item) => item.entry.entryKind === "message");
    const selected = selectThreadLaunchMessages({
      threadItems,
      rootItems: rootItems.slice(0, anchorIndex + 1),
      maxMessages: input.maxMessages,
      maxChars: input.maxChars,
      anchorMessageId: anchorItem.message.id,
    });
    if (selected.length === 0) {
      return undefined;
    }

    const threadEntries = selected.map((item) => ({
      selected: item,
      threadEntry:
        item.source === "root"
          ? this._timelineStore.appendReference({
              sessionId: input.threadSessionId,
              messageId: item.item.message.id,
            })
          : item.item.entry,
    }));
    const anchorReference = threadEntries.find(
      (item) => item.selected.item.message.id === anchorItem.message.id,
    );
    const pack = this._contextPacks.createPack({
      ownerType: "session",
      ownerId: input.threadSessionId,
      kind: "thread_launch",
      selectionStrategy: "deterministic_window",
      triggerEntryId: anchorReference?.threadEntry.id ?? null,
      triggerMessageId: anchorItem.message.id,
    });
    this._contextPacks.addItems(
      pack.id,
      threadEntries.map((item, index) => ({
        itemKind: "timeline_entry",
        itemId: item.threadEntry.id,
        sourceSessionId:
          item.selected.source === "root"
            ? input.rootSessionId
            : input.threadSessionId,
        sourceEntryId: item.selected.item.entry.id,
        sourceMessageId: item.selected.item.message.id,
        sourceIdentityId: item.selected.item.message.senderIdentityId ?? null,
        role: "seed",
        reason: item.selected.reason,
        displayOrder: index,
        metadataJson: {
          sourceExternalMessageId: item.selected.item.message.externalMessageId,
        },
      })),
    );
    return pack;
  }

  buildForThreadSessionFromSurface(input: {
    readonly threadSessionId: string;
    readonly channelType: string;
    readonly channelId: string;
    readonly anchorExternalMessageId: string;
    readonly maxMessages: number;
    readonly maxChars: number;
  }): ContextPackRow | undefined {
    const anchorMessage = new MessageStore(this._db).findByExternalMessageId({sessionId:input.threadSessionId,
      channelType: input.channelType,
      channelId: input.channelId,
      externalMessageId: input.anchorExternalMessageId,
    });
    if (anchorMessage?.session_id === undefined) {
      return undefined;
    }
    return this.buildForThreadSession({
      threadSessionId: input.threadSessionId,
      rootSessionId: anchorMessage.session_id,
      anchorExternalMessageId: input.anchorExternalMessageId,
      maxMessages: input.maxMessages,
      maxChars: input.maxChars,
    });
  }

  private _findTimelineMessageSource(input: {
    readonly sessionId: string;
    readonly messageId: string;
  }): {
    readonly entryId: string;
    readonly senderIdentityId: string | null;
  } | undefined {
    return this._db
      .select({
        entryId: sessionTimelineEntries.id,
        senderIdentityId: messages.senderIdentityId,
      })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(
        and(
          eq(sessionTimelineEntries.sessionId, input.sessionId),
          eq(sessionTimelineEntries.messageId, input.messageId),
        ),
      )
      .orderBy(asc(sessionTimelineEntries.createdAt), asc(sessionTimelineEntries.id))
      .get();
  }
}

export function selectThreadLaunchMessages(input: {
  readonly threadItems: readonly TimelineItem[];
  readonly rootItems: readonly TimelineItem[];
  readonly maxMessages: number;
  readonly maxChars: number;
  readonly anchorMessageId: string;
}): readonly SelectedLaunchMessage[] {
  if (input.maxMessages <= 0 || input.maxChars <= 0) {
    return [];
  }

  const selectedThread: SelectedLaunchMessage[] = [];
  const selectedRoot: SelectedLaunchMessage[] = [];
  const selectedMessageIds = new Set<string>();
  let selectedChars = 0;

  for (let index = input.threadItems.length - 1; index >= 0; index -= 1) {
    if (selectedThread.length + selectedRoot.length >= input.maxMessages) {
      break;
    }
    const item = input.threadItems[index];
    if (item === undefined) {
      continue;
    }
    const text = timelineItemText(item);
    if (text.length === 0 || selectedChars + text.length > input.maxChars) {
      continue;
    }
    selectedThread.push({
      source: "thread",
      item,
      reason: "thread launch recent thread context",
    });
    selectedMessageIds.add(item.message.id);
    selectedChars += text.length;
  }

  for (let index = input.rootItems.length - 1; index >= 0; index -= 1) {
    if (selectedThread.length + selectedRoot.length >= input.maxMessages) {
      break;
    }
    const item = input.rootItems[index];
    if (item === undefined) {
      continue;
    }
    if (selectedMessageIds.has(item.message.id)) {
      continue;
    }
    const text = timelineItemText(item);
    if (text.length === 0 || selectedChars + text.length > input.maxChars) {
      continue;
    }
    selectedRoot.push({
      source: "root",
      item,
      reason:
        item.message.id === input.anchorMessageId
          ? "thread anchor message"
          : "thread launch root supplemental context",
    });
    selectedMessageIds.add(item.message.id);
    selectedChars += text.length;
  }

  return [...selectedThread.reverse(), ...selectedRoot.reverse()];
}

export function selectSessionRelaunchMessages(input: {
  readonly items: readonly TimelineItem[];
  readonly maxMessages: number;
  readonly maxChars: number;
}): readonly TimelineItem[] {
  if (input.maxMessages <= 0 || input.maxChars <= 0) {
    return [];
  }

  const selected: TimelineItem[] = [];
  let selectedChars = 0;
  for (let index = input.items.length - 1; index >= 0; index -= 1) {
    if (selected.length >= input.maxMessages) {
      break;
    }
    const item = input.items[index];
    if (item === undefined) {
      continue;
    }
    const text = timelineItemText(item);
    if (text.length === 0 || selectedChars + text.length > input.maxChars) {
      continue;
    }
    selected.push(item);
    selectedChars += text.length;
  }
  return selected.reverse();
}

function timelineItemText(item: TimelineItem): string {
  const content = Array.isArray(item.message.contentJson)
    ? item.message.contentJson
    : [];
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}
