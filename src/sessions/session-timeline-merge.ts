import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { messages, sessionTimelineEntries } from "@/data/schema";

/**
 * Moves timeline entries from an alias session to the canonical session.
 */
export function moveTimelineEntriesToCanonicalSession(
  db: DrizzleDB,
  sourceSessionId: string,
  canonicalSessionId: string,
): void {
  db.update(messages).set({ ownerSessionId: canonicalSessionId }).where(eq(messages.ownerSessionId, sourceSessionId)).run();
  const sourceRows = db
    .select()
    .from(sessionTimelineEntries)
    .where(eq(sessionTimelineEntries.sessionId, sourceSessionId))
    .all();

  for (const sourceRow of sourceRows) {
    const duplicate = db
      .select()
      .from(sessionTimelineEntries)
      .where(
        and(
          eq(sessionTimelineEntries.sessionId, canonicalSessionId),
          eq(sessionTimelineEntries.messageId, sourceRow.messageId),
          eq(sessionTimelineEntries.entryKind, sourceRow.entryKind),
        ),
      )
      .get();

    if (duplicate) {
      db.delete(sessionTimelineEntries)
        .where(eq(sessionTimelineEntries.id, sourceRow.id))
        .run();
      continue;
    }

    db.update(sessionTimelineEntries)
      .set({ sessionId: canonicalSessionId })
      .where(eq(sessionTimelineEntries.id, sourceRow.id))
      .run();
  }
}
