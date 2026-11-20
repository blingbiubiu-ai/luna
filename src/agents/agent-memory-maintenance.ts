import {and, desc, eq, or, sql} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {agentMemories, lunaAgents, memoryConsolidations, memoryReflectionCheckpoints, runnerContexts, sessionCommands, sessions} from "@/data/schema";
import {AgentMemoryStore, type MemoryRecord} from "./agent-memory-store";
import {SessionStore} from "@/sessions/session-store";
import {AgentStore} from "./agent-store";
import type {SessionCommand, SessionCommandService} from "@/messaging/session-command-service";
import type {MemoryOriginKind} from "@/data/schema";

const REFLECTION_ORIGIN = "memory-reflection:";
const CONSOLIDATION_ORIGIN = "memory-consolidation:";
/** Sessions that went quiet longer ago than this are not reflected on, so enabling memory does not replay history. */
const REFLECTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RUN_EXPIRES_MS = 60 * 60 * 1000;

/**
 * The reflection instruction. `previous` is this conversation's latest episode, which the reflection extends
 * when what happened since is how it turned out, such as a Task it started that has now finished.
 */
const reflectionInstruction = (previous: Pick<MemoryRecord, "id" | "revision" | "title" | "description"> | undefined,
  known: readonly MemoryRecord[] = []) => `Memory reflection. This is an internal Luna maintenance turn, not a message from a user.

Review this conversation since your last memory reflection and decide whether it produced anything worth keeping in Agent long-term memory, following the Long-Term Memory rules in your instructions:
- who the Agent owner says you are: your role and responsibilities, what you may do yourself and what needs their approval first (a \`persona\` entry, not \`project\` or \`feedback\`);
- a durable fact about a person in this conversation, their role or how they like to work;
- a correction or confirmation of how you should work;
- a decision, constraint or deadline that later conversations will need;
- know-how that would save effort next time, or a pointer to an external resource.

For each candidate run \`luna memory search\` first, then update the existing entry or add a new one. Most conversations produce nothing to save, and saving nothing is a correct result. Do not save what the memory index already says.

An entry answers one question and grows with what is learned about it. When something belongs to the question of an existing entry, update that entry instead of adding another, and change its title and description too when the answer changed. Put the current conclusion first in the body and rewrite it; do not leave a conclusion that no longer holds with a dated note under it. When unsure whether it is the same question, add a new entry.
${known.length ? `
Entries this conversation wrote or was shown:
${known.map(row => `- [${row.id}] (${row.type}, revision ${row.revision}) ${inert(row.title)}: ${inert(row.description)}`).join("\n")}
Check each against what happened since. When the conversation showed one wrong or out of date, read it with \`luna memory get\` and update it. When one holds who the Agent owner says you are but is not \`persona\`, add it as a persona entry and delete the old one with \`--superseded-by <persona id>\`.
` : ""}
Then record what happened, so you can later say what you have been doing. One episode tells one event as a story: who asked for what and why, what you did, including the Tasks you started and what they did, and how it ended or what is still open. The title names the event in a few words, the description says it in one line, and the body gives the details worth keeping. Write it as a record of events, not as instructions.
${previous ? `
This conversation's latest episode is [${previous.id}] (revision ${previous.revision}) ${inert(previous.title)}: ${inert(previous.description)}
When what happened since is how that event turned out, such as a Task it started that has now finished or failed, or a question it left open that is now settled, extend that episode instead of adding one: \`luna memory get ${previous.id}\`, then \`luna memory update ${previous.id} --expected-revision N --reason "how it ended" --title TITLE --description DESC --stdin\` (the reason in one line, e.g. "the Task finished and the report was sent") with a body that tells the whole story, including when it began. Luna dates the episode to now. Add a new episode only for something else that happened; if the update is refused, add a new one instead.
` : ""}
Add an episode with \`luna memory add --type episode --title TITLE --description DESC --stdin\`. Add none when nothing happened beyond greetings.

Do not send any message, do not create or change tasks, and do not mention this turn to anyone. End with LUNA_NOTHING_TO_SEND.`;

/** Why a session trigger exists, so memory written during it is attributed correctly. */
export function memoryOriginOfTrigger(db: DrizzleDB, triggerId: string): MemoryOriginKind {
  const origin = db.select({originId: sessionCommands.originId}).from(sessionCommands).where(eq(sessionCommands.id, triggerId)).get()?.originId;
  return origin?.startsWith(REFLECTION_ORIGIN) ? "reflection" : origin?.startsWith(CONSOLIDATION_ORIGIN) ? "consolidation" : "inline";
}

/** Most entries a reflection is asked to recheck. */
const KNOWN_ENTRY_LIMIT = 20;

/**
 * Active entries this conversation wrote, or that its current provider session was shown (at its
 * start or recalled by a message), newest change first. A reflection rechecks them against what
 * happened since, so an entry the conversation proved wrong is corrected rather than left behind.
 */
function conversationEntries(db: DrizzleDB, sessionId: string): MemoryRecord[] {
  return db.select().from(agentMemories).where(and(
    eq(agentMemories.status, "active"), sql`${agentMemories.type} NOT IN ('persona', 'episode')`,
    or(eq(agentMemories.originSessionId, sessionId), sql`${agentMemories.id} IN (SELECT e.memory_id FROM memory_injected_entries e
      JOIN runner_contexts r ON r.id = e.runner_context_id WHERE r.owner_type = 'session' AND r.owner_id = ${sessionId})`),
  )).orderBy(desc(agentMemories.updatedAt)).limit(KNOWN_ENTRY_LIMIT).all();
}

/** Queued or running work in a session: inbound messages not yet handled, a running turn or a pending Service-queued turn. */
function sessionBusy(db: DrizzleDB, sessionId: string): boolean {
  return Boolean(db.get(sql`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM session_inbox WHERE session_id = ${sessionId} AND status IN ('pending', 'claimed', 'processing'))
    OR EXISTS (SELECT 1 FROM session_turns WHERE session_id = ${sessionId} AND status = 'running')
    OR EXISTS (SELECT 1 FROM session_commands WHERE session_id = ${sessionId} AND kind = 'session.invoke' AND status IN ('pending', 'running'))`));
}

/**
 * Memory text is shown to a Runner inside a Service-queued instruction. A
 * Service instruction's `artifact:` references are authorized as context and
 * allowlisted for download, so memory text must never form one: an untrusted
 * entry could otherwise hand its reader an Artifact or stop the turn from
 * being queued at all.
 */
const inert = (text: string) => text.replace(/artifact:/g, "artifact\u2236");

/**
 * Queues one silent reflection turn for each Main or Work session whose latest
 * reflectable human message or handled Task result is older than `idleMs` and
 * has not been reflected on. A message is reflectable only when a completed Main Runner turn took it
 * in, as its input or as context; group chatter nobody addressed to the bot,
 * history backfill and memory maintenance turns never start a reflection. The
 * turn runs in the session's own provider context, so the conversation is not
 * re-read. A session with queued or running work waits for the next pass.
 *
 * It runs as the Agent owner only when the owner is the only human who spoke;
 * otherwise as the latest other speaker, so what a member said never becomes a
 * trusted memory.
 */
export function scheduleMemoryReflections(db: DrizzleDB, commands: Pick<SessionCommandService, "accept">, idleMs: number, now = Date.now()): string[] {
  if (idleMs <= 0) return [];
  const rows = db.all<{sessionId: string; ownerUserId: string; messageId: string; senderUserId: string; createdAt: number}>(sql`
    SELECT m.id AS messageId, s.id AS sessionId, m.sender_user_id AS senderUserId, m.created_at AS createdAt, ou.id AS ownerUserId
    FROM messages m
    JOIN sessions s ON s.id = m.owner_session_id
    JOIN luna_agents a ON a.id = s.agent_id
    JOIN users ou ON ou.agent_id = a.id AND ou.account_id = a.owner_account_id
    JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN memory_reflection_checkpoints c ON c.session_id = s.id
    WHERE s.status = 'active' AND s.kind IN ('main', 'work') AND a.status = 'active'
      AND m.role = 'user' AND m.deleted_at IS NULL AND u.kind = 'human' AND u.status = 'active'
      AND m.created_at > ${now - REFLECTION_LOOKBACK_MS} AND m.created_at > coalesce(c.reflected_through, 0)
      AND (
        EXISTS (SELECT 1 FROM session_timeline_entries te
          JOIN session_turn_entries ste ON ste.entry_id = te.id
          JOIN session_turns t ON t.id = ste.turn_id
          WHERE te.message_id = m.id AND t.session_id = s.id AND t.turn_kind = 'execution' AND t.status = 'completed'
            AND ste.role IN ('trigger', 'coalesced_input', 'context', 'launch_context'))
        OR EXISTS (SELECT 1 FROM context_pack_items i
          JOIN context_packs p ON p.id = i.context_pack_id
          JOIN session_turns t ON t.id = p.created_for_invocation_id
          LEFT JOIN session_commands sc ON sc.id = t.id
          WHERE i.source_message_id = m.id AND p.owner_type = 'session' AND p.owner_id = s.id
            AND t.session_id = s.id AND t.status = 'completed'
            AND (sc.origin_id IS NULL OR (sc.origin_id NOT LIKE ${`${REFLECTION_ORIGIN}%`} AND sc.origin_id NOT LIKE ${`${CONSOLIDATION_ORIGIN}%`})))
      )
    ORDER BY m.created_at`);
  // A Task result handled in the session is part of its story too; the Task's creator stands for who asked.
  const results = db.all<{sessionId: string; ownerUserId: string; messageId: string; senderUserId: string; createdAt: number}>(sql`
    SELECT tr.id AS messageId, s.id AS sessionId, coalesce(cu.id, ou.id) AS senderUserId, tr.updated_at AS createdAt, ou.id AS ownerUserId
    FROM session_triggers tr
    JOIN sessions s ON s.id = tr.session_id
    JOIN luna_agents a ON a.id = s.agent_id
    JOIN users ou ON ou.agent_id = a.id AND ou.account_id = a.owner_account_id
    LEFT JOIN tasks tk ON tk.id = json_extract(tr.payload_json, '$.result.taskId')
    LEFT JOIN users cu ON cu.id = tk.creator_user_id AND cu.kind = 'human' AND cu.status = 'active'
    LEFT JOIN memory_reflection_checkpoints c ON c.session_id = s.id
    WHERE tr.kind = 'task_result' AND tr.status = 'completed'
      AND s.status = 'active' AND s.kind IN ('main', 'work') AND a.status = 'active'
      AND tr.updated_at > ${now - REFLECTION_LOOKBACK_MS} AND tr.updated_at > coalesce(c.reflected_through, 0)`);
  const bySession = new Map<string, typeof rows>();
  for (const row of [...rows, ...results].sort((x, y) => x.createdAt - y.createdAt)) bySession.set(row.sessionId, [...bySession.get(row.sessionId) ?? [], row]);
  const queued: string[] = [];
  for (const [sessionId, unreflected] of bySession) {
    const latest = unreflected.at(-1)!;
    if (now - latest.createdAt < idleMs || sessionBusy(db, sessionId)) continue;
    const actor = unreflected.findLast(row => row.senderUserId !== latest.ownerUserId)?.senderUserId ?? latest.ownerUserId;
    try {
      const previous = db.select({id: agentMemories.id, revision: agentMemories.revision, title: agentMemories.title, description: agentMemories.description})
        .from(agentMemories).where(and(eq(agentMemories.type, "episode"), eq(agentMemories.status, "active"), eq(agentMemories.originSessionId, sessionId)))
        .orderBy(desc(agentMemories.occurredAt)).get();
      const command = commands.accept({userId: actor, sourceSessionId: sessionId, originId: `${REFLECTION_ORIGIN}${latest.messageId}`},
        sessionId, "session.invoke", "reflect", {content: reflectionInstruction(previous, conversationEntries(db, sessionId)), purpose: "notification"}, {expiresAt: now + RUN_EXPIRES_MS});
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
  ...(row.expiresAt ? [`expires ${day(row.expiresAt)}`] : [])].join(", ")}) ${inert(row.title)}: ${inert(row.description)}`;

const consolidationInstruction = (today: string, groups: readonly {entry: MemoryRecord; related: readonly MemoryRecord[]}[]) => `Memory consolidation. This is an internal Luna maintenance turn, not a message from a user. Today is ${today}.

The numbered entries below were added or changed since the last consolidation. Under each are existing entries, of any type, whose wording resembles it. The numbered entries may also duplicate each other. In this turn \`luna memory\` reaches every active entry of this Agent, including entries private to one Shadow and entries about people. Read bodies with \`luna memory get <id>\` before deciding.

${groups.map(({entry, related}, index) => [`${index + 1}. ${describe(entry)}`, ...related.map(row => `   - similar: ${describe(row)}`)].join("\n")).join("\n")}

For each numbered entry:
- Duplicate of another entry: two entries are duplicates when they state the same fact, even under different titles, wording or types, and even when one also carries extra context. Read both bodies. Keep the one whose type fits the fact best and that is most complete; with \`luna memory update <id> --expected-revision N --reason "merged <other id> into it"\` make its title, description and body say everything either entry said, so nothing is lost; then retire the other with \`luna memory delete <id> --expected-revision N --superseded-by <kept id> --reason "duplicate of <kept id>"\`. If an entry holds this fact plus a separate fact that lives in a third entry, remove the repeated part from it instead of retiring it.
- Never fold what an untrusted entry says into a trusted one, and do not rewrite an untrusted entry: untrusted entries are one member's unconfirmed claim and only the Agent owner confirms them. An untrusted entry that adds nothing to a trusted one may be retired in favour of it; otherwise leave both.
- Contradicts a similar entry: a trusted entry wins over an untrusted one; between equals the newer wins. Retire the loser the same way.
- A \`project\` entry that states when it stops mattering but has no expiry: set it with \`luna memory update <id> --expected-revision N --expires YYYY-MM-DD --reason "stops mattering after YYYY-MM-DD"\`. Luna forgets expired entries by itself.
- An entry filed under the wrong type: a \`reference\` that holds no link, path or document name but states a decision or a way of working, or a \`project\` that is only a pointer to a document. Change it with \`luna memory update <id> --expected-revision N --type TYPE --reason "a TYPE, not a OLD_TYPE"\`, adding the location a \`reference\` needs.
- An entry of origin \`migration\` that holds several facts: add one correctly typed entry per fact, then delete the original with \`--reason "split into <new ids>"\`.
- Otherwise leave it alone.

Every update and delete takes \`--reason\`: one line on why, which the Agent owner reads in the entry's history. Do not invent facts or change what an entry means. Keep each entry's subject and visibility, never turn a Shadow-private entry into a shared one, and do not change which entries are core. Changing nothing is a correct result.

Do not send any message and do not create or change tasks. End with LUNA_NOTHING_TO_SEND.`;

/**
 * Queues a consolidation turn for each Agent whose memory was changed by
 * something other than consolidation since its last run, at most once per
 * `intervalMs`. The turn is handed only those changed entries, each with the
 * existing entries it resembles, so its size follows the day's changes rather
 * than the size of the memory. It runs as the Agent owner in a dedicated
 * Dashboard session of the default Shadow, with a fresh provider context.
 *
 * Only one run of an Agent is outstanding at a time. A run that did not
 * complete (failed, expired, cancelled or interrupted) is handed the same
 * changes again on its next turn instead of skipping them.
 */
export function scheduleMemoryConsolidations(db: DrizzleDB, commands: Pick<SessionCommandService, "accept">, intervalMs: number, now = Date.now()): string[] {
  if (intervalMs <= 0) return [];
  const due = db.select({agent: lunaAgents, state: memoryConsolidations}).from(lunaAgents)
    .leftJoin(memoryConsolidations, eq(memoryConsolidations.agentId, lunaAgents.id))
    .where(and(eq(lunaAgents.status, "active"), sql`coalesce(${memoryConsolidations.ranAt}, 0) <= ${now - intervalMs}`)).all();
  const store = new AgentMemoryStore(db);
  const queued: string[] = [];
  for (const {agent, state} of due) {
    const previous = state?.commandId ? db.select({status: sessionCommands.status}).from(sessionCommands).where(eq(sessionCommands.id, state.commandId)).get()?.status : undefined;
    if (previous === "pending" || previous === "running") continue;
    const after = previous !== undefined && previous !== "completed" ? state!.coveredFrom : state?.changeSeq ?? 0;
    const changed = store.changedSince(agent.id, after, CONSOLIDATION_BATCH + 1);
    if (!changed.length) continue;
    const batch = changed.slice(0, CONSOLIDATION_BATCH);
    const viewer = {agentId: agent.id, all: true as const};
    const groups = batch.map(entry => ({entry, related: store.similar(viewer, entry, {limit: RELATED_LIMIT, anyType: true}).filter(candidate => candidate.overlap >= RELATED_OVERLAP).map(candidate => candidate.row)}));
    try {
      const ownerUserId = new AgentStore(db).ownerUserId(agent.id);
      const sessionStore = new SessionStore(db);
      let session = state ? sessionStore.getById(state.sessionId) : undefined;
      if (session?.status !== "active") {
        session = sessionStore.createLocalSession(ownerUserId, {agentId: agent.id, shadowId: agent.defaultShadowId});
        db.update(sessions).set({title: "记忆整理"}).where(eq(sessions.id, session.id)).run();
        // Record the session before queueing, so a turn that cannot be queued does not leave a new session behind on every pass.
        db.insert(memoryConsolidations).values({agentId: agent.id, sessionId: session.id, changeSeq: state?.changeSeq ?? 0, coveredFrom: state?.coveredFrom ?? 0, commandId: state?.commandId ?? null, ranAt: state?.ranAt ?? 0})
          .onConflictDoUpdate({target: memoryConsolidations.agentId, set: {sessionId: session.id}}).run();
      }
      const command = commands.accept({userId: ownerUserId, sourceSessionId: session.id, originId: `${CONSOLIDATION_ORIGIN}${agent.id}:${now}`},
        session.id, "session.invoke", "consolidate", {content: consolidationInstruction(day(now), groups), purpose: "notification"}, {expiresAt: now + RUN_EXPIRES_MS});
      queued.push(command.id);
      // With a backlog left, the next batch does not wait a whole interval.
      const ranAt = changed.length > batch.length ? now - intervalMs + CONSOLIDATION_BACKLOG_RETRY_MS : now;
      const covered = batch.at(-1)!.changeSeq;
      db.insert(memoryConsolidations).values({agentId: agent.id, sessionId: session.id, changeSeq: covered, coveredFrom: after, commandId: command.id, ranAt})
        .onConflictDoUpdate({target: memoryConsolidations.agentId, set: {sessionId: session.id, changeSeq: covered, coveredFrom: after, commandId: command.id, ranAt}}).run();
    } catch (error) {
      console.warn("memory consolidation was not queued", {agentId: agent.id, error: String(error)});
    }
  }
  return queued;
}

/**
 * Each consolidation run starts from an empty provider context, so earlier
 * runs' entries do not pile up in it. Cleared when the run starts rather than
 * when it is queued, so a run waiting in the queue cannot hand its context to
 * the next one. A recovered run keeps its provider session.
 */
export function prepareMemoryConsolidationRun(db: DrizzleDB, command: Pick<SessionCommand, "id" | "sessionId">, recovering: boolean): void {
  if (recovering || memoryOriginOfTrigger(db, command.id) !== "consolidation") return;
  db.update(runnerContexts).set({runner_session_id: null}).where(and(eq(runnerContexts.owner_type, "session"), eq(runnerContexts.owner_id, command.sessionId))).run();
}

export interface MemoryMaintenanceSettings {
  /** Idle time before a session is reflected on; 0 disables reflection. */
  reflectionIdleMs: number;
  /** Minimum time between consolidation runs of one Agent; 0 disables consolidation. */
  consolidationIntervalMs: number;
  /** Time after which an unused non-core entry is archived; 0 keeps unused entries. Expired entries are always archived. */
  forgetUnusedMs: number;
  /** Age after which an episode nobody read since is archived; 0 or unset keeps episodes. */
  episodeRetentionMs?: number;
}

/** One pass of everything Service does to memory by itself: forget, then queue reflection and consolidation. */
export function maintainMemory(db: DrizzleDB, commands: Pick<SessionCommandService, "accept">, settings: MemoryMaintenanceSettings, now = Date.now()): void {
  new AgentMemoryStore(db).forget(settings.forgetUnusedMs, now, settings.episodeRetentionMs ?? 0);
  scheduleMemoryReflections(db, commands, settings.reflectionIdleMs, now);
  scheduleMemoryConsolidations(db, commands, settings.consolidationIntervalMs, now);
}
