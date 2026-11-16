import {randomUUID} from "node:crypto";
import {and, asc, desc, eq, inArray, like, lte, notInArray, or, sql, type SQL} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {
  agentMemories, agentMemoryRevisions, MEMORY_TYPES,
  type MemoryChangeKind, type MemoryOriginKind, type MemoryStatus, type MemoryType,
} from "@/data/schema";
import {config} from "@/shared";
import {AgentError} from "./agent-store";

export type MemoryRecord = typeof agentMemories.$inferSelect;
export type MemoryVisibility = "agent" | "shadow";
export type MemorySummary = Pick<MemoryRecord, "id" | "type" | "title" | "description" | "subjectUserId" | "visibility" | "originKind" | "originUserId" | "trusted" | "revision" | "status" | "core" | "expiresAt" | "updatedAt">;

/** Who is reading. `all` is the Agent owner or Service-launched consolidation. */
export type MemoryViewer =
  | {agentId: string; all: true}
  | {agentId: string; all?: false; shadowId: string; participants: readonly string[]};

/** Who is writing. Callers derive this from an invocation or an authorized owner, never from request input. */
export interface MemoryWriter {
  agentId: string;
  kind: MemoryOriginKind;
  trusted: boolean;
  userId: string | null;
  shadowId: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  /** Runner context that makes the change, when a Runner writes. */
  contextId?: string | null;
  /** The change is made for the Agent owner; required to touch persona entries. */
  owner?: boolean;
}
interface MemoryLimits { core: number; shadowCore: number; persona: number }

interface MemoryFields {
  type: MemoryType;
  title: string;
  description: string;
  body: string;
  subjectUserId: string | null;
  visibility: MemoryVisibility;
  core: boolean;
  expiresAt: number | null;
}
type Optional<T> = {[K in keyof T]?: T[K] | undefined};
export type MemoryInput = Pick<MemoryFields, "type" | "title" | "description" | "body"> & Optional<Omit<MemoryFields, "type" | "title" | "description" | "body">>;
type Db = Pick<DrizzleDB, "select" | "insert" | "update" | "run" | "transaction">;

export class MemoryConflictError extends AgentError {
  constructor(readonly currentRevision: number) { super("memory_revision_conflict", 409); }
}
/** The new entry says what an existing one already says; update a candidate or add with `force`. */
export class MemoryDuplicateError extends AgentError {
  constructor(readonly candidates: readonly MemoryRecord[]) { super("memory_duplicate", 409); }
}

const LIMITS = {title: 120, description: 200, body: 8 * 1024} as const;
/** Types that change how the Agent works; only trusted writers may create or produce them. */
const BEHAVIOR_TYPES: readonly MemoryType[] = ["feedback", "procedure"];
/** Index order: what must not be missed comes first. */
const TYPE_PRIORITY: Record<MemoryType, number> = {persona: -1, person: 0, feedback: 1, procedure: 1, project: 2, reference: 3};
/** Share of title and description terms two entries have in common above which they count as the same fact. */
const DUPLICATE_SIMILARITY = 0.6;
const PERSON_STANDING_LIMIT = 20;
const MATCH_TERM_LIMIT = 256;
/** Statuses whose entries keep search terms: active ones and forgotten ones, which an archive search finds. */
const SEARCHABLE: MemoryStatus[] = ["active", "archived"];
const DAY_MS = 24 * 60 * 60 * 1000;

const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff";
const TERM_RUNS = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, "gu");
const CJK_START = new RegExp(`^[${CJK}]`);

/**
 * Search terms of a text: words for spaced scripts, overlapping two-character
 * pieces for Chinese and Japanese, where most words are two characters long
 * and sentences carry no spaces.
 */
export function memoryTerms(text: string): string[] {
  const terms: string[] = [];
  for (const run of text.toLowerCase().match(TERM_RUNS) ?? []) {
    if (!CJK_START.test(run) || run.length === 1) { terms.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}
const summaryTerms = (entry: Pick<MemoryRecord, "title" | "description">) => new Set(memoryTerms(`${entry.title} ${entry.description}`));

export class AgentMemoryStore {
  private readonly limits: MemoryLimits;
  constructor(private readonly db: Db, limits: Partial<MemoryLimits> = {}) {
    this.limits = {core: config.memory.core_limit, shadowCore: config.memory.shadow_core_limit, persona: config.memory.persona_limit, ...limits};
  }

  /** Visible active entries in index order; `omitted` counts those the limit left out. */
  index(viewer: MemoryViewer, options: Optional<{type: MemoryType; limit: number}> = {}): {entries: MemoryRecord[]; omitted: number} {
    const rows = this.db.select().from(agentMemories).where(and(
      this.visible(viewer),
      options.type ? eq(agentMemories.type, options.type) : undefined,
    )).orderBy(desc(agentMemories.updatedAt), agentMemories.id).all()
      .sort((a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type]);
    const entries = rows.slice(0, options.limit ?? rows.length);
    return {entries, omitted: rows.length - entries.length};
  }

  /** What every conversation is told at its start: the Shadow's persona, core entries, then entries about the people present. */
  standing(viewer: MemoryViewer): MemoryRecord[] {
    const rows = this.db.select().from(agentMemories)
      .where(and(this.visible(viewer), or(eq(agentMemories.core, true), inArray(agentMemories.type, ["person", "persona"]))))
      .orderBy(desc(agentMemories.updatedAt), agentMemories.id).all();
    return [...rows.filter(row => row.type === "persona").reverse(), ...rows.filter(row => row.core),
      ...rows.filter(row => row.type === "person").slice(0, PERSON_STANDING_LIMIT)];
  }

  /** Explicit search over title, description and body; `archived` searches forgotten entries instead of active ones. */
  search(viewer: MemoryViewer, query: string, options: Optional<{type: MemoryType; subjectUserId: string; limit: number; archived: boolean}> = {}): MemoryRecord[] {
    if (!memoryTerms(query).length) throw new AgentError("memory_query_required", 400);
    return this.match(viewer, query, "title description body", options.archived ? ["archived"] : ["active"], and(
      options.type ? eq(agentMemories.type, options.type) : undefined,
      options.subjectUserId ? eq(agentMemories.subjectUserId, options.subjectUserId) : undefined,
    )).slice(0, options.limit ?? 10);
  }

  /**
   * Active entries whose title or description shares at least two terms with a
   * free text such as a user message (one when the text has a single term).
   */
  recall(viewer: MemoryViewer, text: string, options: {limit: number; exclude?: readonly string[] | undefined}): MemoryRecord[] {
    const terms = new Set(memoryTerms(text));
    if (!terms.size || options.limit <= 0) return [];
    const needed = Math.min(2, terms.size);
    return this.match(viewer, text, "title description", ["active"], and(sql`${agentMemories.type} <> 'persona'`,
      options.exclude?.length ? notInArray(agentMemories.id, [...options.exclude]) : undefined))
      .filter(row => { let shared = 0; for (const term of summaryTerms(row)) if (terms.has(term)) shared++; return shared >= needed; })
      .slice(0, options.limit);
  }

  /**
   * Active entries that most resemble an entry. `similarity` is the share of
   * all terms the two have in common; `overlap` is the share of the shorter
   * one's terms found in the other, which also catches a short entry restated
   * inside a longer one. By default only the same type is compared; with
   * `anyType` every type is, except that `person` entries are only ever
   * compared with entries about the same person and `persona` entries with
   * other persona entries.
   */
  similar(viewer: MemoryViewer, entry: Pick<MemoryRecord, "type" | "title" | "description" | "subjectUserId"> & {id?: string},
    options: {limit?: number; anyType?: boolean} = {}): {row: MemoryRecord; similarity: number; overlap: number}[] {
    const terms = summaryTerms(entry);
    return this.match(viewer, `${entry.title} ${entry.description}`, "title description", ["active"], and(
      entry.type === "person" ? and(eq(agentMemories.type, "person"), eq(agentMemories.subjectUserId, entry.subjectUserId ?? ""))
        : options.anyType && entry.type !== "persona" ? sql`${agentMemories.type} NOT IN ('person', 'persona')` : eq(agentMemories.type, entry.type),
      entry.id ? sql`${agentMemories.id} <> ${entry.id}` : undefined,
    )).map(row => {
      const other = summaryTerms(row);
      let shared = 0; for (const term of terms) if (other.has(term)) shared++;
      return {row, similarity: shared / (terms.size + other.size - shared || 1), overlap: shared / (Math.min(terms.size, other.size) || 1)};
    }).sort((a, b) => b.overlap - a.overlap).slice(0, options.limit ?? 5);
  }

  /** Sequence number of the most recent memory change. */
  latestSeq(): number {
    return this.db.select({seq: sql<number>`coalesce(max(${agentMemories.changeSeq}), 0)`}).from(agentMemories).get()!.seq;
  }

  /** What changed for this viewer after a sequence number, leaving out a Runner context's own writes. */
  changes(viewer: MemoryViewer, after: number, exceptContextId: string | null): {changed: MemoryRecord[]; removed: MemoryRecord[]} {
    const rows = this.db.select().from(agentMemories).where(and(
      this.visible(viewer, "any"),
      sql`${agentMemories.changeSeq} > ${after}`,
      exceptContextId ? sql`${agentMemories.updatedContextId} IS NOT ${exceptContextId}` : undefined,
    )).orderBy(desc(agentMemories.updatedAt), agentMemories.id).all();
    return {changed: rows.filter(row => row.status === "active"), removed: rows.filter(row => row.status !== "active")};
  }

  /** Active entries, persona aside, last changed after a sequence number by something other than consolidation, oldest change first. */
  changedSince(agentId: string, after: number, limit: number): MemoryRecord[] {
    return this.db.select({row: agentMemories}).from(agentMemories)
      .innerJoin(agentMemoryRevisions, and(eq(agentMemoryRevisions.memoryId, agentMemories.id), eq(agentMemoryRevisions.revision, agentMemories.revision)))
      .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.status, "active"), sql`${agentMemories.type} <> 'persona'`,
        sql`${agentMemories.changeSeq} > ${after}`, sql`${agentMemoryRevisions.changeKind} <> 'consolidation'`))
      .orderBy(asc(agentMemories.changeSeq)).limit(limit).all().map(result => result.row);
  }

  /** An active or archived entry. */
  get(viewer: MemoryViewer, id: string): MemoryRecord {
    const row = this.db.select().from(agentMemories).where(and(eq(agentMemories.id, id), this.visible(viewer, ["active", "archived"]))).get();
    if (!row) throw new AgentError("memory_not_found", 404);
    return row;
  }

  /** Reads an entry for use by a Runner; reading an active entry keeps it from being forgotten. */
  use(viewer: MemoryViewer, id: string, now = Date.now()): MemoryRecord {
    const row = this.get(viewer, id);
    if (row.status !== "active") return row;
    this.db.update(agentMemories).set({lastUsedAt: now}).where(eq(agentMemories.id, id)).run();
    return {...row, lastUsedAt: now};
  }

  /**
   * Being recalled into a conversation by what was said there is use, like a
   * read: it restarts the forgetting clock. Standing injection is not.
   */
  markUsed(ids: readonly string[], now = Date.now()): void {
    if (ids.length) this.db.update(agentMemories).set({lastUsedAt: now}).where(and(inArray(agentMemories.id, [...ids]), eq(agentMemories.status, "active"))).run();
  }

  /** With `duplicatesFor`, an entry that repeats one this viewer can see is rejected unless `force` is set. */
  add(writer: MemoryWriter, input: MemoryInput, options: {duplicatesFor?: MemoryViewer; force?: boolean | undefined} = {}): MemoryRecord {
    const fields = this.validate(writer, {
      type: input.type, title: input.title, description: input.description, body: input.body,
      subjectUserId: input.subjectUserId ?? null, visibility: input.visibility ?? (input.type === "persona" ? "shadow" : "agent"), core: input.core ?? false, expiresAt: input.expiresAt ?? null,
    }, writer.shadowId);
    const now = Date.now();
    return this.db.transaction(tx => {
      const store = new AgentMemoryStore(tx, this.limits);
      if (options.duplicatesFor && !options.force && fields.type !== "persona") {
        const duplicates = store.similar(options.duplicatesFor, fields).filter(candidate => candidate.similarity >= DUPLICATE_SIMILARITY);
        if (duplicates.length) throw new MemoryDuplicateError(duplicates.map(candidate => candidate.row));
      }
      if (fields.core) store.requireCoreRoom(writer.agentId, fields.visibility === "shadow" ? writer.shadowId : null);
      if (fields.type === "persona") store.requirePersonaRoom(writer.agentId, writer.shadowId!);
      const row: MemoryRecord = {
        id: randomUUID(), agentId: writer.agentId, ...fields,
        originKind: writer.kind, originShadowId: writer.shadowId, originSessionId: writer.sessionId ?? null,
        originTaskId: writer.taskId ?? null, originUserId: writer.userId, updatedContextId: writer.contextId ?? null, trusted: writer.trusted,
        revision: 1, changeSeq: store.latestSeq() + 1, status: "active", supersededBy: null, lastUsedAt: now, createdAt: now, updatedAt: now,
      };
      tx.insert(agentMemories).values(row).run();
      indexTerms(tx, row);
      record(tx, row, writer.kind, writer.userId, writer.shadowId, now);
      return row;
    });
  }

  update(writer: MemoryWriter, viewer: MemoryViewer, id: string, input: Optional<MemoryFields> & {expectedRevision: number}): MemoryRecord {
    return this.change(writer, viewer, id, input.expectedRevision, current => {
      // A forgotten entry is brought back with restore first; editing it in place would leave the edit archived.
      if (current.status !== "active") throw new AgentError("memory_not_active", 409);
      // A persona entry is a different kind of thing; it is never made from, or turned into, an ordinary entry.
      if (input.type !== undefined && input.type !== current.type && (input.type === "persona" || current.type === "persona")) throw new AgentError("invalid_memory_type", 400);
      return this.validate(writer, {
      type: input.type ?? current.type,
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      body: input.body ?? current.body,
      subjectUserId: input.subjectUserId === undefined ? current.subjectUserId : input.subjectUserId,
      visibility: input.visibility ?? current.visibility,
      core: input.core ?? current.core,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    }, current.originShadowId);
    });
  }

  /** Soft delete; `supersededBy` records the entry that replaced this one, when a merge retired it. */
  remove(writer: MemoryWriter, viewer: MemoryViewer, id: string, expectedRevision: number, supersededBy?: string): MemoryRecord {
    if (supersededBy === id) throw new AgentError("invalid_memory_superseded_by", 400);
    if (supersededBy !== undefined && this.get(viewer, supersededBy).status !== "active") throw new AgentError("memory_not_found", 404);
    return this.change(writer, viewer, id, expectedRevision, () => ({status: "deleted" as const, supersededBy: supersededBy ?? null}));
  }

  /**
   * A trusted writer vouches for an untrusted entry as it stands, which makes
   * it an ordinary shared entry. Consolidation cannot.
   */
  confirm(writer: MemoryWriter, viewer: MemoryViewer, id: string, expectedRevision: number): MemoryRecord {
    if (!writer.trusted || writer.kind === "consolidation") throw new AgentError("memory_write_forbidden", 403);
    return this.change(writer, viewer, id, expectedRevision, current => {
      if (current.status !== "active") throw new AgentError("memory_not_active", 409);
      if (current.trusted) throw new AgentError("memory_already_trusted", 409);
      return {};
    }, false, true);
  }

  /** Brings a forgotten entry back; an expiry that has passed is dropped so it is not forgotten again at once. */
  restore(writer: MemoryWriter, viewer: MemoryViewer, id: string, expectedRevision: number): MemoryRecord {
    return this.change(writer, viewer, id, expectedRevision, current => {
      if (current.status !== "archived") throw new AgentError("memory_not_archived", 409);
      return {status: "active" as const, expiresAt: current.expiresAt !== null && current.expiresAt <= Date.now() ? null : current.expiresAt};
    });
  }

  /**
   * Archives active entries whose expiry has passed and, when `unusedMs` is
   * positive, non-core entries nobody read or changed for that long.
   */
  forget(unusedMs: number, now = Date.now()): number {
    return this.db.transaction(tx => {
      const due = tx.select().from(agentMemories).where(and(eq(agentMemories.status, "active"), or(
        lte(agentMemories.expiresAt, now),
        unusedMs > 0 ? and(eq(agentMemories.core, false), sql`${agentMemories.type} <> 'persona'`, lte(agentMemories.lastUsedAt, now - unusedMs)) : undefined,
      ))).all();
      for (const current of due) {
        const row: MemoryRecord = {...current, status: "archived", updatedContextId: null, revision: current.revision + 1,
          changeSeq: new AgentMemoryStore(tx, this.limits).latestSeq() + 1, updatedAt: now};
        tx.update(agentMemories).set(row).where(eq(agentMemories.id, row.id)).run();
        record(tx, row, "forgetting", null, null, now);
      }
      return due.length;
    });
  }

  /** Indexes searchable entries that have no search terms yet, such as those imported by the migration. */
  reindex(): number {
    const missing = this.db.select().from(agentMemories)
      .where(and(inArray(agentMemories.status, SEARCHABLE), sql`${agentMemories.id} NOT IN (SELECT memory_id FROM agent_memory_terms)`)).all();
    for (const row of missing) indexTerms(this.db, row);
    return missing.length;
  }

  /** Owner view: every entry of the Agent, including deleted and archived ones. */
  listAll(agentId: string): MemoryRecord[] {
    return this.db.select().from(agentMemories).where(eq(agentMemories.agentId, agentId))
      .orderBy(desc(agentMemories.updatedAt), agentMemories.id).all();
  }

  /** Owner view, one filtered page at a time; `query` is a substring of title, description or body. */
  page(agentId: string, options: Optional<{status: MemoryStatus; type: MemoryType; originKind: MemoryOriginKind; originShadowId: string; core: boolean; trusted: boolean;
    query: string; sort: "updatedAt" | "createdAt"; limit: number; offset: number}> = {}): {entries: MemoryRecord[]; total: number} {
    const pattern = options.query?.trim() ? `%${options.query.trim().replace(/[\\%_]/g, "\\$&")}%` : undefined;
    const where = and(
      eq(agentMemories.agentId, agentId),
      options.status ? eq(agentMemories.status, options.status) : undefined,
      options.type ? eq(agentMemories.type, options.type) : undefined,
      options.originKind ? eq(agentMemories.originKind, options.originKind) : undefined,
      options.originShadowId ? eq(agentMemories.originShadowId, options.originShadowId) : undefined,
      options.core === undefined ? undefined : eq(agentMemories.core, options.core),
      options.trusted === undefined ? undefined : eq(agentMemories.trusted, options.trusted),
      pattern ? or(...[agentMemories.title, agentMemories.description, agentMemories.body].map(column => sql`${like(column, pattern)} ESCAPE '\\'`)) : undefined,
    );
    const total = this.db.select({n: sql<number>`count(*)`}).from(agentMemories).where(where).get()!.n;
    const entries = this.db.select().from(agentMemories).where(where)
      .orderBy(desc(options.sort === "createdAt" ? agentMemories.createdAt : agentMemories.updatedAt), agentMemories.id)
      .limit(options.limit ?? 50).offset(options.offset ?? 0).all();
    return {entries, total};
  }

  history(agentId: string, id: string) {
    this.owned(agentId, id);
    return this.db.select().from(agentMemoryRevisions).where(eq(agentMemoryRevisions.memoryId, id))
      .orderBy(desc(agentMemoryRevisions.revision)).all();
  }

  /** Writes a past state as a new revision; history is never rewritten. */
  revert(writer: MemoryWriter, id: string, revision: number, expectedRevision: number): MemoryRecord {
    this.owned(writer.agentId, id);
    const past = this.db.select().from(agentMemoryRevisions)
      .where(and(eq(agentMemoryRevisions.memoryId, id), eq(agentMemoryRevisions.revision, revision))).get();
    if (!past) throw new AgentError("memory_revision_not_found", 404);
    const snapshot = past.snapshot;
    // Like restore, an active state whose expiry has passed would be forgotten again within a minute.
    const expiresAt = snapshot.status === "active" && snapshot.expiresAt !== null && snapshot.expiresAt <= Date.now() ? null : snapshot.expiresAt;
    return this.change(writer, {agentId: writer.agentId, all: true}, id, expectedRevision, current => ({
      ...this.validate(writer, {
        type: snapshot.type, title: snapshot.title, description: snapshot.description, body: snapshot.body,
        subjectUserId: snapshot.subjectUserId, visibility: snapshot.visibility, core: snapshot.core, expiresAt,
      }, current.originShadowId),
      status: snapshot.status, supersededBy: snapshot.supersededBy,
    }), true);
  }

  private change(writer: MemoryWriter, viewer: MemoryViewer, id: string, expectedRevision: number,
    next: (current: MemoryRecord) => Partial<MemoryRecord>, anyStatus = false, confirms = false): MemoryRecord {
    return this.db.transaction(tx => {
      const store = new AgentMemoryStore(tx, this.limits);
      const current = anyStatus ? store.owned(writer.agentId, id) : store.get(viewer, id);
      if (current.revision !== expectedRevision) throw new MemoryConflictError(current.revision);
      if ((current.trusted && !writer.trusted) || (current.type === "persona" && !writer.owner)) throw new AgentError("memory_protected", 403);
      // An untrusted writer changes only what they wrote themselves; otherwise one member could rewrite or retire another's facts under the original attribution.
      if (!writer.trusted && (current.originUserId === null || current.originUserId !== writer.userId)) throw new AgentError("memory_protected", 403);
      const now = Date.now();
      const row: MemoryRecord = {...current, ...next(current), updatedContextId: writer.contextId ?? null,
        revision: current.revision + 1, changeSeq: store.latestSeq() + 1, updatedAt: now};
      // An untrusted entry becomes trusted only when a trusted writer vouches for it: by rewriting what it says, by
      // making it a core rule, or explicitly. Maintenance never does: consolidation setting an expiry, or a restore
      // from the archive, must not hand a member's claim to every conversation. (Untrusted writers cannot touch
      // trusted entries, so trust is never lost here.)
      const rewritten = row.type !== current.type || row.title !== current.title || row.description !== current.description
        || row.body !== current.body || row.subjectUserId !== current.subjectUserId;
      row.trusted = current.trusted || (writer.trusted && writer.kind !== "consolidation" && (confirms || rewritten || (row.core && !current.core)));
      // A change is a use: whatever is active after it starts a fresh forgetting clock.
      if (row.status === "active") row.lastUsedAt = now;
      // An entry needs room when it becomes an active core entry or moves between the shared and a Shadow's own allowance.
      if (row.core && row.status === "active" && !(current.core && current.status === "active" && corePool(current) === corePool(row))) store.requireCoreRoom(writer.agentId, corePool(row));
      if (row.type === "persona" && row.status === "active" && current.status !== "active") store.requirePersonaRoom(writer.agentId, row.originShadowId!);
      tx.update(agentMemories).set(row).where(eq(agentMemories.id, id)).run();
      // Deleted entries are never searched; their terms come back if a revision restores them.
      if (!SEARCHABLE.includes(row.status)) deleteTerms(tx, row.id);
      else if (!SEARCHABLE.includes(current.status) || row.title !== current.title || row.description !== current.description || row.body !== current.body) indexTerms(tx, row);
      record(tx, row, writer.kind, writer.userId, writer.shadowId, now);
      return row;
    });
  }

  /** Entries matching any term of a text, best first: term rarity and field weight, with a mild preference for recent entries. */
  private match(viewer: MemoryViewer, text: string, columns: string, statuses: readonly MemoryStatus[], filter: SQL | undefined): MemoryRecord[] {
    // Chinese text yields about one term per character, so a low cap would drop the end of a long message.
    const terms = [...new Set(memoryTerms(text))].slice(0, MATCH_TERM_LIMIT);
    if (!terms.length) return [];
    const expression = `{${columns}}: (${terms.map(term => `"${term}"`).join(" OR ")})`;
    const now = Date.now();
    return this.db.select({row: agentMemories, rank: sql<number>`bm25(agent_memory_terms, 0, 5, 3, 1)`}).from(agentMemories)
      .innerJoin(sql`agent_memory_terms`, sql`agent_memory_terms.memory_id = ${agentMemories.id}`)
      .where(and(sql`agent_memory_terms MATCH ${expression}`, this.visible(viewer, statuses), filter))
      .orderBy(sql`bm25(agent_memory_terms, 0, 5, 3, 1)`).limit(60).all()
      .map(({row, rank}) => ({row, score: -rank * (1 + 0.3 * Math.exp(-(now - row.updatedAt) / (90 * DAY_MS)))}))
      .sort((a, b) => b.score - a.score || b.row.updatedAt - a.row.updatedAt).map(entry => entry.row);
  }

  /** Active core entries in one allowance: the Agent's shared one (`shadowId` null) or a Shadow's own. */
  coreUsed(agentId: string, shadowId: string | null): number {
    return this.db.select({n: sql<number>`count(*)`}).from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.status, "active"), eq(agentMemories.core, true),
        shadowId === null ? eq(agentMemories.visibility, "agent") : and(eq(agentMemories.visibility, "shadow"), eq(agentMemories.originShadowId, shadowId)))).get()!.n;
  }

  /**
   * Shared core entries are told to every Shadow and count against the Agent's
   * allowance; a Shadow-private core entry is told only to that Shadow and
   * counts against its own, so one Shadow's rules cannot crowd out another's.
   */
  private requireCoreRoom(agentId: string, shadowId: string | null): void {
    if (this.coreUsed(agentId, shadowId) >= (shadowId === null ? this.limits.core : this.limits.shadowCore)) throw new AgentError("memory_core_full", 409);
  }

  private requirePersonaRoom(agentId: string, shadowId: string): void {
    const used = this.db.select({n: sql<number>`count(*)`}).from(agentMemories).where(and(eq(agentMemories.agentId, agentId),
      eq(agentMemories.status, "active"), eq(agentMemories.type, "persona"), eq(agentMemories.originShadowId, shadowId))).get()!.n;
    if (used >= this.limits.persona) throw new AgentError("memory_persona_full", 409);
  }

  private owned(agentId: string, id: string): MemoryRecord {
    const row = this.db.select().from(agentMemories).where(and(eq(agentMemories.id, id), eq(agentMemories.agentId, agentId))).get();
    if (!row) throw new AgentError("memory_not_found", 404);
    return row;
  }

  private visible(viewer: MemoryViewer, statuses: readonly MemoryStatus[] | "any" = ["active"]): SQL {
    const scope = [eq(agentMemories.agentId, viewer.agentId), statuses === "any" ? undefined : inArray(agentMemories.status, [...statuses])];
    if (viewer.all) return and(...scope)!;
    return and(...scope,
      or(eq(agentMemories.visibility, "agent"), eq(agentMemories.originShadowId, viewer.shadowId)),
      or(sql`${agentMemories.type} <> 'person'`,
        viewer.participants.length ? inArray(agentMemories.subjectUserId, [...viewer.participants]) : sql`0`),
      // What an untrusted writer said reaches only conversations its author takes part in, so it cannot steer anyone else's.
      or(eq(agentMemories.trusted, true),
        viewer.participants.length ? inArray(agentMemories.originUserId, [...viewer.participants]) : sql`0`),
    )!;
  }

  private validate(writer: MemoryWriter, input: MemoryFields, originShadowId: string | null): MemoryFields {
    if (!MEMORY_TYPES.includes(input.type)) throw new AgentError("invalid_memory_type", 400);
    const title = input.title.trim(), description = input.description.trim().replace(/\s+/g, " "), body = input.body.trim();
    if (!title || title.length > LIMITS.title) throw new AgentError("invalid_memory_title", 400);
    if (!description || description.length > LIMITS.description) throw new AgentError("invalid_memory_description", 400);
    if (!body || Buffer.byteLength(body) > LIMITS.body) throw new AgentError("invalid_memory_body", 400);
    if (input.visibility !== "agent" && !(input.visibility === "shadow" && originShadowId)) throw new AgentError("invalid_memory_visibility", 400);
    if ((input.type === "person") !== Boolean(input.subjectUserId)) throw new AgentError("invalid_memory_subject", 400);
    if (input.core && (input.type === "person" || input.type === "persona")) throw new AgentError("invalid_memory_core", 400);
    if (input.type === "persona") {
      // Identity outlives the conversation that set it, so only the Agent owner may have it written.
      if (!writer.owner) throw new AgentError("memory_write_forbidden", 403);
      if (input.visibility !== "shadow" || input.expiresAt !== null) throw new AgentError("invalid_memory_persona", 400);
    }
    if (input.expiresAt !== null && !(Number.isSafeInteger(input.expiresAt) && input.expiresAt > 0)) throw new AgentError("invalid_memory_expiry", 400);
    if (!writer.trusted) {
      if (BEHAVIOR_TYPES.includes(input.type) || input.core) throw new AgentError("memory_write_forbidden", 403);
      if (input.type === "person" && input.subjectUserId !== writer.userId) throw new AgentError("memory_write_forbidden", 403);
    }
    return {type: input.type, title, description, body, subjectUserId: input.subjectUserId || null, visibility: input.visibility, core: input.core, expiresAt: input.expiresAt};
  }
}

const corePool = (row: Pick<MemoryRecord, "visibility" | "originShadowId">) => row.visibility === "shadow" ? row.originShadowId : null;

/** Replaces the search terms of one entry. */
function indexTerms(tx: Pick<DrizzleDB, "run">, row: Pick<MemoryRecord, "id" | "title" | "description" | "body">): void {
  const terms = (text: string) => memoryTerms(text).join(" ");
  tx.run(sql`DELETE FROM agent_memory_terms WHERE agent_memory_terms MATCH ${`memory_id:"${row.id}"`}`);
  tx.run(sql`INSERT INTO agent_memory_terms (memory_id, title, description, body) VALUES (${row.id}, ${terms(row.title)}, ${terms(row.description)}, ${terms(row.body)})`);
}

function deleteTerms(tx: Pick<DrizzleDB, "run">, id: string): void {
  tx.run(sql`DELETE FROM agent_memory_terms WHERE agent_memory_terms MATCH ${`memory_id:"${id}"`}`);
}

function record(tx: Pick<DrizzleDB, "insert">, row: MemoryRecord, kind: MemoryChangeKind, userId: string | null, shadowId: string | null, now: number): void {
  const {type, title, description, body, subjectUserId, visibility, status, supersededBy, trusted, core, expiresAt} = row;
  tx.insert(agentMemoryRevisions).values({
    memoryId: row.id, revision: row.revision,
    snapshot: {type, title, description, body, subjectUserId, visibility, status, supersededBy, trusted, core, expiresAt},
    changeKind: kind, changedByUserId: userId, changedByShadowId: shadowId, createdAt: now,
  }).run();
}

export function memorySummary(row: MemoryRecord): MemorySummary {
  const {id, type, title, description, subjectUserId, visibility, originKind, originUserId, trusted, revision, status, core, expiresAt, updatedAt} = row;
  return {id, type, title, description, subjectUserId, visibility, originKind, originUserId, trusted, revision, status, core, expiresAt, updatedAt};
}
