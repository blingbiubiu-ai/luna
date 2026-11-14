import { asc, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { messages, sessionTimelineEntries } from "@/data/schema";

import type { MessageRow } from "./message-store";
import type { SessionTimelineEntryRow } from "./session-timeline-store";
import type {
  MessageContentBlock,
  MessageContentKind,
  MessagePresentationKind,
  SessionMessageKind,
  SessionMessageRole,
} from "./types";

export class SessionTimelineReader {
  constructor(private readonly _db: DrizzleDB) {}

  listForSession(
    sessionId: string,
    options: {
      readonly limit?: number;
      readonly beforeEntryId?: string;
      readonly afterEntryId?: string;
    } = {},
  ): Array<{ entry: SessionTimelineEntryRow; message: MessageRow }> {
    const rows = this._db
      .select({
        entry: sessionTimelineEntries,
        message: {
          id: messages.id,
          channelType: messages.channelType,
          channelId: messages.channelId,
          externalMessageId: messages.externalMessageId,
          senderIdentityId: messages.senderIdentityId,
          role: messages.role,
          contentKind: messages.contentKind,
          presentationKind: messages.presentationKind,
          providerMessageType: messages.providerMessageType,
          contentJson: messages.contentJson,
          occurredAt: messages.occurredAt,
          createdAt: messages.createdAt,
        },
      })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(eq(sessionTimelineEntries.sessionId, sessionId))
      .orderBy(
        asc(messages.occurredAt),
        asc(sessionTimelineEntries.createdAt),
        asc(sessionTimelineEntries.id),
      )
      .all();

    const afterIndex = cursorIndex(rows, options.afterEntryId);
    const beforeIndex = cursorIndex(rows, options.beforeEntryId);
    if (
      (options.afterEntryId !== undefined && afterIndex === undefined) ||
      (options.beforeEntryId !== undefined && beforeIndex === undefined)
    ) {
      return [];
    }

    const start = afterIndex === undefined ? 0 : afterIndex + 1;
    const end = beforeIndex === undefined ? rows.length : beforeIndex;
    if (start >= end) {
      return [];
    }
    const bounded = rows.slice(start, end);
    const limited = limitRows(
      bounded,
      options.limit === undefined
        ? { nearestBeforeCursor: options.beforeEntryId !== undefined }
        : {
            limit: options.limit,
            nearestBeforeCursor: options.beforeEntryId !== undefined,
          },
    );

    return limited.map((row) => ({
      entry: row.entry,
      message: toTimelineMessageRow(sessionId, row.message),
    }));
  }
}

function cursorIndex(
  rows: readonly { readonly entry: SessionTimelineEntryRow }[],
  entryId: string | undefined,
): number | undefined {
  if (entryId === undefined) {
    return undefined;
  }
  const index = rows.findIndex((row) => row.entry.id === entryId);
  return index < 0 ? undefined : index;
}

function limitRows<T>(
  rows: readonly T[],
  options: {
    readonly limit?: number;
    readonly nearestBeforeCursor: boolean;
  },
): readonly T[] {
  if (options.limit === undefined) {
    return rows;
  }
  if (options.limit <= 0) {
    return [];
  }
  return options.nearestBeforeCursor
    ? rows.slice(Math.max(0, rows.length - options.limit))
    : rows.slice(0, options.limit);
}

function toTimelineMessageRow(
  sessionId: string,
  row: {
    readonly id: string;
    readonly channelType: string;
    readonly channelId: string;
    readonly externalMessageId: string;
    readonly senderIdentityId: string | null;
    readonly role: string;
    readonly contentKind: string;
    readonly presentationKind: string;
    readonly providerMessageType: string | null;
    readonly contentJson: unknown;
    readonly occurredAt: number;
    readonly createdAt: number;
  },
): MessageRow {
  const role = asRole(row.role);
  const contentJson = asMessageContentBlocks(row.contentJson);
  const messageKind = defaultMessageKind(role);
  return {
    id: row.id,
    sessionId,
    channelType: row.channelType,
    channelId: row.channelId,
    externalMessageId: row.externalMessageId,
    channelMessageKey: row.externalMessageId,
    senderIdentityId: row.senderIdentityId,
    senderUserId: null,
    role,
    messageKind,
    contentKind: asContentKind(row.contentKind),
    presentationKind: asPresentationKind(row.presentationKind),
    providerMessageType: row.providerMessageType,
    contentJson,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    session_id: sessionId,
    channel_message_key: row.externalMessageId,
    sender_user_id: null,
    message_kind: messageKind,
    content_json: contentJson,
    created_at: row.occurredAt,
  };
}

function defaultMessageKind(role: SessionMessageRole): SessionMessageKind {
  return role === "user" ? "user_message" : "assistant_message";
}

function asMessageContentBlocks(value: unknown): readonly MessageContentBlock[] {
  return Array.isArray(value) ? (value as MessageContentBlock[]) : [];
}

function asRole(value: string): SessionMessageRole {
  return value === "assistant" ? "assistant" : "user";
}

function asContentKind(value: string): MessageContentKind {
  switch (value) {
    case "text":
    case "rich_text":
    case "image":
    case "file":
    case "mixed":
    case "card":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function asPresentationKind(value: string): MessagePresentationKind {
  switch (value) {
    case "plain":
    case "rich_markdown":
    case "image_gallery":
    case "file_attachment":
    case "status_card":
    case "task_result_card":
    case "provider_rich_card":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}
