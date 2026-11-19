import {and, eq, inArray} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {memoryInjectedEntries, memoryInjectionCursors, runnerContexts, users} from "@/data/schema";
import {config, createLogger} from "@/shared";

const logger = createLogger("agent-memory-injection");
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
 * - at the start of a conversation, what is always in effect: core entries and
 *   entries about the people present;
 * - on every turn, the few entries `message` brings to mind that this
 *   conversation has not been shown yet;
 * - on later turns, changes made elsewhere to entries it was shown, and to core
 *   and person entries.
 * Persona is not told here: it is part of the Runner instructions (`shadowSoul`).
 */
export function memoryInjection(db: DrizzleDB, invocation: MemoryInvocation, message?: string): MemoryInjection {
  const {runnerContextId} = invocation;
  let viewer;
  try { viewer = memoryAccess(db, invocation).viewer; }
  catch (error) {
    if (!(error instanceof AgentError) || error.code !== "memory_access_denied") throw error;
    // Without this, a broken access rule looks exactly like an Agent with no memory.
    logger.warn({agentId: invocation.agentId, shadowId: invocation.shadowId, runnerContextId}, "Agent memory withheld from Runner: access denied");
    return {text: undefined, commit: () => {}};
  }
  const sessionId = () => db.select().from(runnerContexts).where(eq(runnerContexts.id, runnerContextId)).get()?.runner_session_id ?? null;
  const cursor = db.select().from(memoryInjectionCursors).where(eq(memoryInjectionCursors.runnerContextId, runnerContextId)).get();
  const resumed = cursor !== undefined && cursor.runnerSessionId === sessionId();
  const store = new AgentMemoryStore(db);
  const through = store.latestSeq();
  const seen = new Set(resumed ? db.select().from(memoryInjectedEntries).where(eq(memoryInjectedEntries.runnerContextId, runnerContextId)).all().map(row => row.memoryId) : []);
  const shown: MemoryRecord[] = [];
  const sections: string[] = [];
  if (resumed) {
    const {changed} = store.changes(viewer, cursor.injectedThrough, runnerContextId);
    const visibleIds = new Set(changed.map(row => row.id));
    // People who joined after the conversation started: what is known about them was written earlier, so no change reports it.
    const newcomers = store.standing(viewer).filter(row => row.type === "person" && !seen.has(row.id) && !visibleIds.has(row.id));
    // Persona reaches the Runner through its instruction files, which it rereads every turn.
    const updated = [...changed.filter(row => row.type !== "persona" && (row.core || row.type === "person" || row.type === "chat" || seen.has(row.id))), ...newcomers];
    // An entry it was shown is gone when it was removed or forgotten, or when it is no longer visible here (e.g. made Shadow-private).
    const everywhere = store.changes({agentId: invocation.agentId, all: true}, cursor.injectedThrough, runnerContextId);
    const gone = [...everywhere.changed, ...everywhere.removed].filter(row => seen.has(row.id) && !visibleIds.has(row.id));
    if (updated.length || gone.length) sections.push([
      "## Agent memory updates",
      "Long-term memory you were shown changed since your last turn in this conversation. These lines replace what you were told before.",
      ...lines(db, updated),
      ...gone.map(row => `- removed [${row.id}] ${row.title}; do not rely on it any more.`),
    ].join("\n"));
    shown.push(...updated);
  } else {
    const rules = store.standing(viewer).filter(row => row.type !== "persona");
    if (rules.length) sections.push([
      "## Agent memory: always in effect",
      "Apply these throughout this conversation. Read a body with `luna memory get <id>` when you need its details.",
      ...lines(db, rules),
    ].join("\n"));
    shown.push(...rules);
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
      store.markUsed(recalled.map(row => row.id));
      if (shown.length) db.insert(memoryInjectedEntries).values(shown.map(row => ({runnerContextId, memoryId: row.id}))).onConflictDoNothing().run();
      db.insert(memoryInjectionCursors).values({runnerContextId, runnerSessionId: current, injectedThrough: through})
        .onConflictDoUpdate({target: memoryInjectionCursors.runnerContextId, set: {runnerSessionId: current, injectedThrough: through}}).run();
    },
  };
}

/** `- [id] (type) title: description (from NAME, DATE)`, attribution lets the reader weigh the source. */
function lines(db: DrizzleDB, rows: readonly MemoryRecord[]): string[] {
  const ids = [...new Set(rows.flatMap(row => row.originUserId ? [row.originUserId] : []))];
  const names = new Map(ids.length ? db.select({id: users.id, name: users.displayName}).from(users).where(inArray(users.id, ids)).all().map(user => [user.id, user.name]) : []);
  return rows.map(row => {
    const source = row.originUserId ? names.get(row.originUserId) ?? row.originUserId : row.originKind;
    return `- [${row.id}] (${row.type}) ${row.title}: ${row.description} (from ${source}, ${new Date(row.updatedAt).toISOString().slice(0, 10)})`;
  });
}
