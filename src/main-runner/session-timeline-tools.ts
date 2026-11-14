import type { DrizzleDB } from "@/data";
import { SessionTimelineReader } from "@/sessions/session-timeline-reader";
import type {
  MessageContentBlock,
  MessageContentKind,
  MessagePresentationKind,
  SessionMessageRole,
} from "@/sessions/types";

import { renderMessageBlocksForRunner } from "./context-builder";

const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_TIMELINE_LIMIT = 50;

export interface SessionTimelineToolEntry {
  readonly entryId: string;
  readonly entryKind: "message" | "reference";
  readonly messageId: string;
  readonly role: SessionMessageRole;
  readonly contentKind: MessageContentKind | undefined;
  readonly presentationKind: MessagePresentationKind | undefined;
  readonly content: readonly MessageContentBlock[];
  readonly text: string;
  readonly occurredAt: number | undefined;
}

export class SessionTimelineTools {
  private readonly _reader: SessionTimelineReader;
  private readonly _allowedSessionIds: Set<string> | undefined;

  constructor(
    db: DrizzleDB,
    options: { readonly allowedSessionIds?: readonly string[] } = {},
  ) {
    this._reader = new SessionTimelineReader(db);
    this._allowedSessionIds = new Set(options.allowedSessionIds ?? []);
  }

  readSessionTimeline(input: {
    readonly sessionId: string;
    readonly beforeEntryId?: string;
    readonly afterEntryId?: string;
    readonly limit?: number;
    readonly includeReferences?: boolean;
  }): { readonly entries: readonly SessionTimelineToolEntry[] } {
    this._assertSessionAllowed(input.sessionId);
    const limit = normalizeLimit(input.limit);
    const items = this._reader.listForSession(input.sessionId, {
      ...optionalString("beforeEntryId", input.beforeEntryId),
      ...optionalString("afterEntryId", input.afterEntryId),
    });
    const filtered = items
      .filter(
        (item) =>
          input.includeReferences !== false || item.entry.entryKind !== "reference",
      );
    const entries = limitTimelineItems(filtered, {
      limit,
      nearestBeforeCursor: input.beforeEntryId !== undefined,
    }).map((item) => toToolEntry(item));
    return { entries };
  }

  private _assertSessionAllowed(sessionId: string): void {
    if (!this._allowedSessionIds?.has(sessionId)) {
      throw new Error(`Session "${sessionId}" is not authorized for this runner.`);
    }
  }
}

function toToolEntry(
  item: ReturnType<SessionTimelineReader["listForSession"]>[number],
): SessionTimelineToolEntry {
  const content = item.message.contentJson ?? [];
  return {
    entryId: item.entry.id,
    entryKind: timelineEntryKind(item.entry.entryKind),
    messageId: item.message.id,
    role: item.message.role as SessionMessageRole,
    contentKind: item.message.contentKind,
    presentationKind: item.message.presentationKind,
    content,
    text: renderMessageBlocksForRunner(content),
    occurredAt: item.message.occurredAt,
  };
}

function timelineEntryKind(value: string): "message" | "reference" {
  return value === "reference" ? "reference" : "message";
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_TIMELINE_LIMIT;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }
  return Math.min(Math.floor(limit), MAX_TIMELINE_LIMIT);
}

function limitTimelineItems<T>(
  items: readonly T[],
  options: { readonly limit: number; readonly nearestBeforeCursor: boolean },
): readonly T[] {
  if (options.limit <= 0) {
    return [];
  }
  return options.nearestBeforeCursor
    ? items.slice(Math.max(0, items.length - options.limit))
    : items.slice(0, options.limit);
}

function optionalString<T extends string>(
  key: T,
  value: string | undefined,
): Record<T, string> {
  return value === undefined ? ({} as Record<T, string>) : { [key]: value } as Record<T, string>;
}
