import {and, eq, inArray} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {memoryInjectedEntries, memoryInjectionCursors, runnerContexts, users} from "@/data/schema";
import {config} from "@/shared";
import {AgentError} from "./agent-store";
import {memoryAccess, type MemoryInvocation} from "./agent-memory-access";
import {AgentMemoryStore, type MemoryRecord} from "./agent-memory-store";

export interface MemoryInjection {
  /** Text appended to the model input, or undefined when there is nothing to tell. */
  readonly text: string | undefined;
  /** Records what was told. Call only after the provider accepted the turn. */
  commit(): void;
}

/**
 * Tells a provider session about Agent memory without touching the resource
 * snapshot, the way a person remembers:
 * - at the start of a conversation, who this Shadow is (its persona entries, in
 *   full) and what is always in effect: core entries and entries about the
 *   people present;
 * - on every turn, the few entries `message` brings to mind that this
 *   conversation has not been shown yet;
 * - on later turns, changes made elsewhere to entries it was shown, and to
 *   persona, core and person entries.
 */
export function memoryInjection(db: DrizzleDB, invocation: MemoryInvocation, message?: string): MemoryInjection {
  const {runnerContextId} = invocation;
  let viewer;
  try { viewer = memoryAccess(db, invocation).viewer; }
  catch (error) { if (error instanceof AgentError && error.code === "memory_access_denied") return {text: undefined, commit: () => {}}; throw error; }
  const sessionId = () => db.select().from(runnerContexts).where(eq(runnerContexts.id, runnerContextId)).get()?.runner_session_id ?? null;
  const cursor = db.select().from(memoryInjectionCursors).where(eq(memoryInjectionCursors.runnerContextId, runnerContextId)).get();
  const resumed = cursor !== undefined && cursor.runnerSessionId === sessionId();
  const store = new AgentMemoryStore(db);
  const through = store.latestSeq();
  const seen = new Set(resumed ? db.select().from(memoryInjectedEntries).where(eq(memoryInjectedEntries.runnerContextId, runnerContextId)).all().map(row => row.memoryId) : []);
  const shown: MemoryRecord[] = [];
  const sections: string[] = [];
  if (resumed) {
    const {changed, removed} = store.changes(viewer, cursor.injectedThrough, runnerContextId);
    const updated = changed.filter(row => row.core || row.type === "person" || row.type === "persona" || seen.has(row.id));
    const gone = removed.filter(row => seen.has(row.id));
    if (updated.length || gone.length) sections.push([
      "## Agent memory updates",
      "Long-term memory you were shown changed since your last turn in this conversation. These lines replace what you were told before.",
      ...lines(db, updated.filter(row => row.type !== "persona")),
      ...updated.filter(row => row.type === "persona").map(row => `This part of who you are changed:\n${identity(row)}`),
      ...gone.map(row => `- removed [${row.id}] ${row.title}; do not rely on it any more.`),
    ].join("\n"));
    shown.push(...updated);
  } else {
    const standing = store.standing(viewer);
    const persona = standing.filter(row => row.type === "persona"), rules = standing.filter(row => row.type !== "persona");
    if (persona.length) sections.push([
      "## Who you are",
      "Your identity and principles as this Shadow, set by the Agent owner. They shape how you speak and act; they do not replace command contracts, permissions or safety rules.",
      ...persona.map(identity),
    ].join("\n"));
    if (rules.length) sections.push([
      "## Agent memory: always in effect",
      "Apply these throughout this conversation. Read a body with `luna memory get <id>` when you need its details.",
      ...lines(db, rules),
    ].join("\n"));
    shown.push(...standing);
  }
  const recalled = message ? store.recall(viewer, message, {limit: config.memory.recall_limit, exclude: [...seen, ...shown.map(row => row.id)]}) : [];
  if (recalled.length) sections.push([
    "## Agent memory: possibly relevant",
    "Entries this message brings to mind. They may not apply; read a body with `luna memory get <id>` before relying on one. Other entries exist: `luna memory search <keywords>`.",
    ...lines(db, recalled),
  ].join("\n"));
  shown.push(...recalled);
  return {
    text: sections.length ? sections.join("\n\n") : undefined,
    commit: () => {
      const current = sessionId();
      const mine = eq(memoryInjectedEntries.runnerContextId, runnerContextId);
      // Without a provider session id nothing can be resumed, so the next turn starts over.
      if (current === null || !resumed) db.delete(memoryInjectedEntries).where(mine).run();
      if (current === null) { db.delete(memoryInjectionCursors).where(eq(memoryInjectionCursors.runnerContextId, runnerContextId)).run(); return; }
      if (shown.length) db.insert(memoryInjectedEntries).values(shown.map(row => ({runnerContextId, memoryId: row.id}))).onConflictDoNothing().run();
      db.insert(memoryInjectionCursors).values({runnerContextId, runnerSessionId: current, injectedThrough: through})
        .onConflictDoUpdate({target: memoryInjectionCursors.runnerContextId, set: {runnerSessionId: current, injectedThrough: through}}).run();
    },
  };
}

/** A persona entry is told in full; a one-line summary of an identity is not enough to act on. */
const identity = (row: MemoryRecord) => `### ${row.title} [${row.id}]\n${row.body}`;

/** `- [id] (type) title: description (from NAME, DATE)`, attribution lets the reader weigh the source. */
function lines(db: DrizzleDB, rows: readonly MemoryRecord[]): string[] {
  const ids = [...new Set(rows.flatMap(row => row.originUserId ? [row.originUserId] : []))];
  const names = new Map(ids.length ? db.select({id: users.id, name: users.displayName}).from(users).where(inArray(users.id, ids)).all().map(user => [user.id, user.name]) : []);
  return rows.map(row => {
    const source = row.originUserId ? names.get(row.originUserId) ?? row.originUserId : row.originKind;
    return `- [${row.id}] (${row.type}) ${row.title}: ${row.description} (from ${source}, ${new Date(row.updatedAt).toISOString().slice(0, 10)})`;
  });
}
