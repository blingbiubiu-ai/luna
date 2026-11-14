import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { messages, sessions, sessionTimelineEntries } from "@/data/schema";
import { uuid } from "@/shared";

export type SessionTimelineEntryRow =
  typeof sessionTimelineEntries.$inferSelect;

let lastEntryCreatedAt = 0;

export class SessionTimelineStore {
  constructor(private readonly _db: DrizzleDB) {}

  appendMessage(input: {
    readonly sessionId: string;
    readonly messageId: string;
  }): SessionTimelineEntryRow {
    const message = this._db.select().from(messages).where(eq(messages.id, input.messageId)).get();
    if (message && (message.deletedAt !== null || (message.ownerSessionId !== null && message.ownerSessionId !== input.sessionId))) {
      return this.appendReference(input);
    }
    const existingMessage = this._findExisting({
      ...input,
      entryKind: "message",
    });
    if (existingMessage !== undefined) {
      return existingMessage;
    }
    const existingReference = this._findExisting({
      ...input,
      entryKind: "reference",
    });
    if (existingReference !== undefined) {
      this._db
        .update(sessionTimelineEntries)
        .set({ entryKind: "message" })
        .where(eq(sessionTimelineEntries.id, existingReference.id))
        .run();
      return this._findExisting({ ...input, entryKind: "message" }) ?? {
        ...existingReference,
        entryKind: "message",
      };
    }
    return this._append({ ...input, entryKind: "message" });
  }

  appendReference(input: {
    readonly sessionId: string;
    readonly messageId: string;
  }): SessionTimelineEntryRow {
    const message=this._db.select().from(messages).where(eq(messages.id,input.messageId)).get();
    const target=this._db.select().from(sessions).where(eq(sessions.id,input.sessionId)).get();
    if(!target||!message||target.agent_id!==message.agentId||target.shadow_id!==message.shadowId||target.binding_id!==message.bindingId)throw new Error("message_reference_scope_mismatch");
    const existingMessage = this._findExisting({...input,entryKind:"message"});
    if(existingMessage)return existingMessage;
    return this._append({ ...input, entryKind: "reference" });
  }

  private _append(input: {
    readonly sessionId: string;
    readonly messageId: string;
    readonly entryKind: "message" | "reference";
  }): SessionTimelineEntryRow {
    const row = {
      id: uuid(),
      sessionId: input.sessionId,
      messageId: input.messageId,
      entryKind: input.entryKind,
      createdAt: nextEntryCreatedAt(),
    };

    this._db
      .insert(sessionTimelineEntries)
      .values(row)
      .onConflictDoNothing({
        target: [
          sessionTimelineEntries.sessionId,
          sessionTimelineEntries.messageId,
          sessionTimelineEntries.entryKind,
        ],
      })
      .run();

    const existing = this._findExisting(input);
    if (existing === undefined) {
      throw new Error(
        `Timeline entry for session "${input.sessionId}" and message "${input.messageId}" was not found after append.`,
      );
    }
    return existing;
  }

  private _findExisting(input: {
    readonly sessionId: string;
    readonly messageId: string;
    readonly entryKind: "message" | "reference";
  }): SessionTimelineEntryRow | undefined {
    return this._db
      .select()
      .from(sessionTimelineEntries)
      .where(
        and(
          eq(sessionTimelineEntries.sessionId, input.sessionId),
          eq(sessionTimelineEntries.messageId, input.messageId),
          eq(sessionTimelineEntries.entryKind, input.entryKind),
        ),
      )
      .get();
  }
}

function nextEntryCreatedAt(): number {
  const now = Date.now();
  const createdAt = Math.max(now, lastEntryCreatedAt + 1);
  lastEntryCreatedAt = createdAt;
  return createdAt;
}
