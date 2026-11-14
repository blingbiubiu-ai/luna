import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { sessionStates } from "@/data/schema";

import type { SessionClarificationState } from "./types";

/**
 * Persists and reads Session State Store records for session Main Runner.
 */
export class SessionStateStore {
  constructor(private readonly _db: DrizzleDB) {}

  getClarification(id: string): SessionClarificationState | undefined {
    const row = this._db
      .select()
      .from(sessionStates)
      .where(eq(sessionStates.session_id, id))
      .get();
    return (row?.clarification_json ??
      undefined) as SessionClarificationState | undefined;
  }

  saveClarification(id: string, value: SessionClarificationState): void {
    const now = Date.now();
    this._db
      .insert(sessionStates)
      .values({
        session_id: id,
        clarification_json: value,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: sessionStates.session_id,
        set: { clarification_json: value, updated_at: now },
      })
      .run();
  }

  clearClarification(id: string): void {
    this._db
      .update(sessionStates)
      .set({ clarification_json: null, updated_at: Date.now() })
      .where(eq(sessionStates.session_id, id))
      .run();
  }
}
