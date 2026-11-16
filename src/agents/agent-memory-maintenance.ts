import {and, eq, gt, isNull, sql} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {lunaAgents, memoryConsolidations, memoryReflectionCheckpoints, messages, runnerContexts, sessionCommands, sessions, users} from "@/data/schema";
import {AgentMemoryStore, type MemoryRecord} from "./agent-memory-store";
import {SessionStore} from "@/sessions/session-store";
import type {SessionCommandService} from "@/messaging/session-command-service";
import type {MemoryOriginKind} from "@/data/schema";

const REFLECTION_ORIGIN = "memory-reflection:";
const CONSOLIDATION_ORIGIN = "memory-consolidation:";
/** Sessions that went quiet longer ago than this are not reflected on, so enabling memory does not replay history. */
const REFLECTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RUN_EXPIRES_MS = 60 * 60 * 1000;

const REFLECTION_INSTRUCTION = `Memory reflection. This is an internal Luna maintenance turn, not a message from a user.

Review this conversation since your last memory reflection and decide whether it produced anything worth keeping in Agent long-term memory, following the Long-Term Memory rules in your instructions:
- a durable fact about a person in this conversation, their role or how they like to work;
- a correction or confirmation of how you should work;
- a decision, constraint or deadline that later conversations will need;
- know-how that would save effort next time, or a pointer to an external resource.

For each candidate run \`luna memory search\` first, then update the existing entry or add a new one. Most conversations produce nothing to save, and saving nothing is a correct result. Do not save what the memory index already says.

Do not send any message, do not create or change tasks, and do not mention this turn to anyone. End with LUNA_NOTHING_TO_SEND.`;

/** Why a session trigger exists, so memory written during it is attributed correctly. */
export function memoryOriginOfTrigger(db: DrizzleDB, triggerId: string): MemoryOriginKind {
  const origin = db.select({originId: sessionCommands.originId}).from(sessionCommands).where(eq(sessionCommands.id, triggerId)).get()?.originId;
  return origin?.startsWith(REFLECTION_ORIGIN) ? "reflection" : origin?.startsWith(CONSOLIDATION_ORIGIN) ? "consolidation" : "inline";
}

/**
 * Queues one silent reflection turn for each Main session whose latest human
 * message is older than `idleMs` and has not been reflected on. The turn runs
 * in the session's own provider context, so the conversation is not re-read.
 *
 * It runs as the Agent owner only when the owner is the only human who spoke;
 * otherwise as the latest other speaker, so what a member said never becomes a
 * trusted memory.
 */
export function scheduleMemoryReflections(db: DrizzleDB, commands: Pick<SessionCommandService, "accept">, idleMs: number, now = Date.now()): string[] {
  if (idleMs <= 0) return [];
  const rows = db.select({sessionId: sessions.id, ownerUserId: lunaAgents.ownerUserId, messageId: messages.id, senderUserId: messages.senderUserId, createdAt: messages.createdAt})
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.ownerSessionId))
    .innerJoin(lunaAgents, eq(lunaAgents.id, sessions.agent_id))
    .innerJoin(users, eq(users.id, messages.senderUserId))
    .leftJoin(memoryReflectionCheckpoints, eq(memoryReflectionCheckpoints.sessionId, sessions.id))
    .where(and(
      eq(sessions.status, "active"), eq(sessions.kind, "main"), eq(lunaAgents.status, "active"),
      eq(messages.role, "user"), isNull(messages.deletedAt), eq(users.kind, "human"), eq(users.status, "active"),
      gt(messages.createdAt, now - REFLECTION_LOOKBACK_MS),
      sql`${messages.createdAt} > coalesce(${memoryReflectionCheckpoints.reflectedThrough}, 0)`,
    )).orderBy(messages.createdAt).all();
  const bySession = new Map<string, typeof rows>();
  for (const row of rows) bySession.set(row.sessionId, [...bySession.get(row.sessionId) ?? [], row]);
  const queued: string[] = [];
  for (const [sessionId, unreflected] of bySession) {
    const latest = unreflected.at(-1)!;
    if (now - latest.createdAt < idleMs) continue;
    const actor = unreflected.findLast(row => row.senderUserId !== latest.ownerUserId)?.senderUserId ?? latest.ownerUserId;
    try {
      const command = commands.accept({userId: actor, sourceSessionId: sessionId, originId: `${REFLECTION_ORIGIN}${latest.messageId}`},
        sessionId, "session.invoke", "reflect", {content: REFLECTION_INSTRUCTION, purpose: "notification"}, {expiresAt: now + RUN_EXPIRES_MS});
      queued.push(command.id);
    } catch (error) {
      // An unavailable session or actor must not block the others; the checkpoint still advances so it is not retried every tick.
      console.warn("memory reflection was not queued", {sessionId, error: String(error)});
    }
    db.insert(memoryReflectionCheckpoints).values({sessionId, reflectedThrough: latest.createdAt, updatedAt: now})
      .onConflictDoUpdate({target: memoryReflectionCheckpoints.sessionId, set: {reflectedThrough: latest.createdAt, updatedAt: now}}).run();
  }
  return queued;
}

/** Changed entries handed to one consolidation turn; the rest follow in the next turn. */
const CONSOLIDATION_BATCH = 100;
const CONSOLIDATION_BACKLOG_RETRY_MS = 10 * 60 * 1000;
/**
 * Share of the shorter entry's terms that must appear in the other for an
 * existing entry to be shown next to a changed one. Deliberately loose: the
 * model reads the bodies and decides, and a missed candidate is never merged.
 */
const RELATED_OVERLAP = 0.4;
const RELATED_LIMIT = 4;

const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const describe = (row: MemoryRecord) => `[${row.id}] (${[row.type, row.trusted ? "trusted" : "untrusted", `origin ${row.originKind}`, `revision ${row.revision}`,
  `updated ${day(row.updatedAt)}`, ...(row.core ? ["core"] : []), ...(row.visibility === "shadow" ? ["Shadow-private"] : []),
  ...(row.expiresAt ? [`expires ${day(row.expiresAt)}`] : [])].join(", ")}) ${row.title}: ${row.description}`;

const consolidationInstruction = (today: string, groups: readonly {entry: MemoryRecord; related: readonly MemoryRecord[]}[]) => `Memory consolidation. This is an internal Luna maintenance turn, not a message from a user. Today is ${today}.

The numbered entries below were added or changed since the last consolidation. Under each are existing entries, of any type, whose wording resembles it. The numbered entries may also duplicate each other. In this turn \`luna memory\` reaches every active entry of this Agent, including entries private to one Shadow and entries about people. Read bodies with \`luna memory get <id>\` before deciding.

${groups.map(({entry, related}, index) => [`${index + 1}. ${describe(entry)}`, ...related.map(row => `   - similar: ${describe(row)}`)].join("\n")).join("\n")}

For each numbered entry:
- Duplicate of another entry: two entries are duplicates when they state the same fact, even under different titles, wording or types, and even when one also carries extra context. Read both bodies. Keep the one whose type fits the fact best and that is most complete; with \`luna memory update\` make its title, description and body say everything either entry said, so nothing is lost; then retire the other with \`luna memory delete <id> --expected-revision N --superseded-by <kept id>\`. If an entry holds this fact plus a separate fact that lives in a third entry, remove the repeated part from it instead of retiring it.
- Contradicts a similar entry: a trusted entry wins over an untrusted one; between equals the newer wins. Retire the loser the same way.
- A \`project\` entry that states when it stops mattering but has no expiry: set it with \`luna memory update <id> --expected-revision N --expires YYYY-MM-DD\`. Luna forgets expired entries by itself.
- An entry of origin \`migration\` that holds several facts: add one correctly typed entry per fact, then delete the original.
- Otherwise leave it alone.

Do not invent facts or change what an entry means. Keep each entry's subject and visibility, never turn a Shadow-private entry into a shared one, and do not change which entries are core. Changing nothing is a correct result.

Do not send any message and do not create or change tasks. End with LUNA_NOTHING_TO_SEND.`;

/**
 * Queues a consolidation turn for each Agent whose memory was changed by
 * something other than consolidation since its last run, at most once per
 * `intervalMs`. The turn is handed only those changed entries, each with the
 * existing entries it resembles, so its size follows the day's changes rather
 * than the size of the memory. It runs as the Agent owner in a dedicated
 * Dashboard session of the default Shadow, with a fresh provider context.
 */
export function scheduleMemoryConsolidations(db: DrizzleDB, commands: Pick<SessionCommandService, "accept">, intervalMs: number, now = Date.now()): string[] {
  if (intervalMs <= 0) return [];
  const due = db.select({agent: lunaAgents, state: memoryConsolidations}).from(lunaAgents)
    .leftJoin(memoryConsolidations, eq(memoryConsolidations.agentId, lunaAgents.id))
    .where(and(eq(lunaAgents.status, "active"), sql`coalesce(${memoryConsolidations.ranAt}, 0) <= ${now - intervalMs}`)).all();
  const store = new AgentMemoryStore(db);
  const queued: string[] = [];
  for (const {agent, state} of due) {
    const changed = store.changedSince(agent.id, state?.changeSeq ?? 0, CONSOLIDATION_BATCH + 1);
    if (!changed.length) continue;
    const batch = changed.slice(0, CONSOLIDATION_BATCH);
    const viewer = {agentId: agent.id, all: true as const};
    const groups = batch.map(entry => ({entry, related: store.similar(viewer, entry, {limit: RELATED_LIMIT, anyType: true}).filter(candidate => candidate.overlap >= RELATED_OVERLAP).map(candidate => candidate.row)}));
    try {
      const sessionStore = new SessionStore(db);
      let session = state ? sessionStore.getById(state.sessionId) : undefined;
      if (session?.status !== "active") {
        session = sessionStore.createLocalSession(agent.ownerUserId, {agentId: agent.id, shadowId: agent.defaultShadowId});
        db.update(sessions).set({title: "记忆整理"}).where(eq(sessions.id, session.id)).run();
      }
      // Each run starts from an empty provider context; earlier runs' entries must not pile up in it.
      db.update(runnerContexts).set({runner_session_id: null}).where(and(eq(runnerContexts.owner_type, "session"), eq(runnerContexts.owner_id, session.id))).run();
      const command = commands.accept({userId: agent.ownerUserId, sourceSessionId: session.id, originId: `${CONSOLIDATION_ORIGIN}${agent.id}:${now}`},
        session.id, "session.invoke", "consolidate", {content: consolidationInstruction(day(now), groups), purpose: "notification"}, {expiresAt: now + RUN_EXPIRES_MS});
      queued.push(command.id);
      // With a backlog left, the next batch does not wait a whole interval.
      const ranAt = changed.length > batch.length ? now - intervalMs + CONSOLIDATION_BACKLOG_RETRY_MS : now;
      const covered = batch.at(-1)!.changeSeq;
      db.insert(memoryConsolidations).values({agentId: agent.id, sessionId: session.id, changeSeq: covered, ranAt})
        .onConflictDoUpdate({target: memoryConsolidations.agentId, set: {sessionId: session.id, changeSeq: covered, ranAt}}).run();
    } catch (error) {
      console.warn("memory consolidation was not queued", {agentId: agent.id, error: String(error)});
    }
  }
  return queued;
}

export interface MemoryMaintenanceSettings {
  /** Idle time before a session is reflected on; 0 disables reflection. */
  reflectionIdleMs: number;
  /** Minimum time between consolidation runs of one Agent; 0 disables consolidation. */
  consolidationIntervalMs: number;
  /** Time after which an unused non-core entry is archived; 0 keeps unused entries. Expired entries are always archived. */
  forgetUnusedMs: number;
}

/** One pass of everything Service does to memory by itself: forget, then queue reflection and consolidation. */
export function maintainMemory(db: DrizzleDB, commands: Pick<SessionCommandService, "accept">, settings: MemoryMaintenanceSettings, now = Date.now()): void {
  new AgentMemoryStore(db).forget(settings.forgetUnusedMs, now);
  scheduleMemoryReflections(db, commands, settings.reflectionIdleMs, now);
  scheduleMemoryConsolidations(db, commands, settings.consolidationIntervalMs, now);
}
