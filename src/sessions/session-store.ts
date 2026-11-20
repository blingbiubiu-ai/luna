import { AgentError, AgentStore, type AgentScope } from "@/agents/agent-store";
import { BotBindingStore } from "@/agents/bot-binding-store";
import { sessionConfigForAgent } from "@/agents/agent-settings-store";
import { and, eq, isNull, ne } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  channelConfigs,
  directRecipients,
  sessionChannelBindings,
  users,
  sessionSurfaceAliases,
  sessions,
  userIdentityLinks,
  runnerContexts,
  timelineEvents,
} from "@/data/schema";
import { ContextPackStore, LaunchContextBuilder } from "@/context";
import { createSessionRunnerPaths } from "@/runners/runner-context-store";
import { moveTaskSubscriptionsToCanonicalSession } from "@/tasks/task-subscription-merge";
import { DEFAULT_SESSION_CONFIG, uuid } from "@/shared";

import { MessageStore } from "./message-store";
import { moveTimelineEntriesToCanonicalSession } from "./session-timeline-merge";
import { SessionTimelineStore } from "./session-timeline-store";
import type { ResolveSessionSurfaceInput } from "./types";

/**
 * Persisted row type for session persistence records.
 */
export type SessionRow = typeof sessions.$inferSelect;
type SessionSurfaceAliasRow = typeof sessionSurfaceAliases.$inferSelect;

/**
 * Persists and reads Session Store records for session persistence.
 */
export class SessionStore {
  constructor(private readonly _db: DrizzleDB) {}

  /** Create a local conversation without any external surface or delivery binding. */
  createLocalSession(createdByUserId: string, scope: AgentScope): SessionRow {
    const shadow = new AgentStore(this._db).requireScope(createdByUserId, scope);
    const now = Date.now();
    const row: SessionRow = {
      id: uuid(), agent_id: scope.agentId, shadow_id: scope.shadowId, binding_id: null, channel_type: "dashboard", channel_id: "luna-dashboard",
      surface_key: null, group_id: null, thread_key: null, root_message_key: null,
      parent_session_id: null, title: "Dashboard 对话", bot_user_id: shadow.replyUserId,
      status: "active", kind: "main", created_by_user_id: createdByUserId,
      created_at: now, updated_at: now, last_activity_at: now,
    };
    this._db.insert(sessions).values(row).run();
    return row;
  }

  /** Business replies must have an explicit, active Luna identity before persistence. */
  requireReplyUserId(sessionId: string): string {
    const session = this.getById(sessionId);
    if (!session || session.status !== "active") throw new Error("Session is unavailable");
    const agents = new AgentStore(this._db), shadow = agents.shadow(session.shadow_id);
    if (shadow.agentId !== session.agent_id || shadow.status !== "active" || agents.get(session.agent_id).status !== "active") throw new AgentError("shadow_disabled",409);
    if (session.binding_id !== null) this.requireChannelScope(session, session.channel_id);
    if (session.bot_user_id !== shadow.replyUserId) throw new AgentError("session_reply_identity_mismatch",409);
    const user = this._db.select().from(users).where(eq(users.id, shadow.replyUserId)).get();
    if (!user || user.status !== "active" || user.kind !== "shadow") throw new Error("Shadow reply identity is unavailable");
    return user.id;
  }

  bindBotUser(sessionId: string, userId: string): void {
    if (this.requireReplyUserId(sessionId) !== userId) throw new AgentError("session_reply_identity_mismatch",409);
  }

  /** A historical session cannot send through a replacement binding. */
  requireChannelScope(session: SessionRow, channelId: string): void {
    const binding = new BotBindingStore(this._db).requireActive(channelId);
    if (session.binding_id !== binding.id || session.agent_id !== binding.agentId || session.shadow_id !== binding.shadowId)
      throw new AgentError("session_binding_mismatch",409);
    const channel = this._db.select().from(channelConfigs).where(eq(channelConfigs.id, channelId)).get();
    if (!channel?.enabled) throw new AgentError("channel_disabled", 409);
  }

  resolveByChannelSurface(
    input: ResolveSessionSurfaceInput,
  ): SessionRow {
    return this._db.transaction((tx) => {
      const store = new SessionStore(tx as unknown as DrizzleDB);
      const row = store._resolveByChannelSurface(tx as unknown as DrizzleDB, input);
      if (input.channelType !== "dashboard") store.saveChannelBinding(row.id, input);
      return row;
    });
  }

  saveChannelBinding(sessionId: string, input: ResolveSessionSurfaceInput): void {
    if (input.channelType === "dashboard") throw new Error("Dashboard is not a delivery channel");
    const session = this.getById(sessionId);
    if (!session) throw new AgentError("session_not_found",404);
    this.requireChannelScope(session,input.channelId);
    const existing = this._db.select().from(sessionChannelBindings).where(and(eq(sessionChannelBindings.sessionId,sessionId),eq(sessionChannelBindings.channelId,input.channelId))).get();
    const rootMessageId = input.rootMessageId ?? (existing?.threadId === (input.threadId ?? null) ? existing.rootMessageId : null);
    this._db.insert(sessionChannelBindings).values({ id: `binding:${sessionId}:${input.channelId}`, sessionId,
      channelType: input.channelType, channelId: input.channelId, surfaceId: input.groupId ?? input.channelId,
      threadId: input.threadId ?? null, rootMessageId,
    }).onConflictDoUpdate({ target: [sessionChannelBindings.sessionId, sessionChannelBindings.channelId], set: {
      surfaceId: input.groupId ?? input.channelId, threadId: input.threadId ?? null, rootMessageId,
    } }).run();
  }

  channelBindings(sessionId: string) {
    const session = this.getById(sessionId);
    if (!session || session.status === "deleted") throw new Error("Session is unavailable");
    const rows = this._db.select().from(sessionChannelBindings).where(eq(sessionChannelBindings.sessionId, sessionId)).all();
    return rows;
  }

  /** Attach another channel surface without changing the session's original delivery target. */
  bindChannelSurface(sessionId: string, input: ResolveSessionSurfaceInput): void {
    this._db.transaction(tx => {
      const db = tx as unknown as DrizzleDB;
      const session = this._resolveById(db, sessionId);
      if (!session || session.status !== "active") throw new Error("Session is unavailable");
      new SessionStore(db).saveChannelBinding(sessionId, input);
      const aliases = this._createSurfaceAliases(input);
      for (const alias of aliases) {
        const existing = this._resolveByAliases(db, [alias]);
        if (existing && existing.session_id !== sessionId) throw new Error("Channel surface already bound");
        db.insert(sessionSurfaceAliases).values({ alias_key: alias, session_id: sessionId, created_at: Date.now() }).onConflictDoNothing().run();
      }
    });
  }

  // Bind a provisional direct recipient session without inventing a provider chat ID.
  bindDirectSurface(sessionId: string, channelId: string, surfaceId: string): SessionRow {
    return this._db.transaction(tx => {
      const db = tx as unknown as DrizzleDB;
      const row = this._resolveById(db, sessionId);
      if (!row || row.channel_type !== "feishu" || row.channel_id !== channelId || row.thread_key)
        throw new Error("Invalid direct recipient session");
      new SessionStore(db).requireChannelScope(row,channelId);
      const input = { channelType: "feishu", channelId, groupId: surfaceId };
      const key = this._createSurfaceKey(input);
      const existing = this._resolveByAliases(db, this._createSurfaceAliases(input));
      if (existing && existing.session_id !== sessionId)
        throw new Error("Provider conversation already belongs to another session");
      const previous = db.select().from(directRecipients).where(eq(directRecipients.sessionId, sessionId)).all();
      if (previous.some(r => r.surfaceId && r.surfaceId !== surfaceId))
        throw new Error("Provider conversation changed for recipient");
      db.update(sessions).set({ group_id: surfaceId, surface_key: key, updated_at: Date.now() }).where(eq(sessions.id, sessionId)).run();
      db.insert(sessionSurfaceAliases).values({ alias_key: key, session_id: sessionId, created_at: Date.now() }).onConflictDoNothing().run();
      new SessionStore(db).saveChannelBinding(sessionId, input);
      db.update(directRecipients).set({ surfaceId }).where(eq(directRecipients.sessionId, sessionId)).run();
      return this._resolveById(db, sessionId)!;
    });
  }

  bindInboundDirectRecipient(message: import("@/channels").NormalizedInboundMessage): void {
    if (message.channel.type !== "feishu" || message.surface.kind !== "p2p" || message.thread) return;
    const binding=new BotBindingStore(this._db).requireActive(message.channel.id);
    const claims = message.sender.identityClaims?.filter(claim => claim.namespace === "feishu" && claim.confidence === "verified");
    if (!claims?.length) return;
    const matches = this._db.select({ recipient: directRecipients, claim: userIdentityLinks }).from(directRecipients)
      .innerJoin(sessions, eq(sessions.id, directRecipients.sessionId))
      .innerJoin(userIdentityLinks, eq(userIdentityLinks.id, directRecipients.claimId))
      .where(and(eq(directRecipients.channelId, message.channel.id), eq(sessions.binding_id, binding.id),
        eq(sessions.status, "active"), isNull(directRecipients.surfaceId))).all()
      .filter(({recipient, claim}) => claims.some(evidence => evidence.kind === recipient.idType && evidence.value === recipient.recipientId
        && evidence.scope === claim.identityScope && evidence.namespace === claim.identityNamespace));
    const sessionIds = [...new Set(matches.map(({recipient}) => recipient.sessionId))];
    if (sessionIds.length === 1) this.bindDirectSurface(sessionIds[0]!, message.channel.id, message.surface.externalId);
    else if (sessionIds.length > 1) throw new Error("Ambiguous direct recipient bindings");
  }

  getById(sessionId: string): SessionRow | undefined {
    return this._resolveById(this._db, sessionId);
  }

  /**
   * Creates a Work Session (kind='work') bound to a Feishu thread.
   * Reuses resolveByChannelSurface with kind='work'.
   */
  createWorkSession(input: {
    readonly channelType: ResolveSessionSurfaceInput["channelType"];
    readonly channelId: string;
    readonly groupId?: string;
    readonly threadId?: string;
    readonly rootMessageId?: string;
  }): SessionRow {
    return this.resolveByChannelSurface({
      channelType: input.channelType,
      channelId: input.channelId,
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.rootMessageId !== undefined ? { rootMessageId: input.rootMessageId } : {}),
      kind: "work",
    });
  }

  private _resolveByChannelSurface(
    db: DrizzleDB,
    input: ResolveSessionSurfaceInput,
  ): SessionRow {
    if (input.channelType === "dashboard") throw new AgentError("explicit_dashboard_scope_required",400);
    const binding = new BotBindingStore(db).requireActive(input.channelId);
    const channel=db.select().from(channelConfigs).where(eq(channelConfigs.id,input.channelId)).get();
    if(channel?.type!==input.channelType)throw new AgentError("channel_type_mismatch",409);
    const shadow = new AgentStore(db).shadow(binding.shadowId);
    const aliases = this._createSurfaceAliases(input);
    const surfaceKey = this._createSurfaceKey(input);
    const aliasRow = this._resolveByAliases(db, aliases);
    if (aliasRow) {
      const session = this._resolveById(db, aliasRow.session_id);
      if (session) {
        return this._ensureAliasesAndBackfill(db, session, input, aliases);
      }
    }

    const surfaceRow = this._resolveBySurfaceKey(db, surfaceKey);
    if (surfaceRow) {
      return this._ensureAliasesAndBackfill(db, surfaceRow, input, aliases);
    }

    if (input.threadId !== undefined) {
      const threadRow = this._resolveByThread(db, input);
      if (threadRow) {
        return this._ensureAliasesAndBackfill(db, threadRow, input, aliases);
      }
    }

    const row = db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.binding_id, new BotBindingStore(db).requireActive(input.channelId).id),
          ne(sessions.status, "deleted"),
          eq(sessions.channel_type, input.channelType),
          eq(sessions.channel_id, input.channelId),
          this._nullableEq(sessions.group_id, input.groupId),
          this._nullableEq(sessions.thread_key, input.threadId),
          this._nullableEq(sessions.root_message_key, input.rootMessageId),
        ),
      )
      .get();

    if (row) {
      return this._ensureAliasesAndBackfill(db, row, input, aliases);
    }

    const now = Date.now();
    const id = uuid();
    const claimAlias = aliases[0] ?? surfaceKey;
    db.insert(sessionSurfaceAliases)
      .values({
        alias_key: claimAlias,
        session_id: id,
        created_at: now,
      })
      .onConflictDoNothing()
      .run();

    const claimedAlias = this._resolveByAliases(db, [claimAlias]);
    if (claimedAlias && claimedAlias.session_id !== id) {
      const claimedSession = this._resolveById(
        db,
        claimedAlias.session_id,
      );
      if (claimedSession) {
        return this._ensureAliasesAndBackfill(
          db,
          claimedSession,
          input,
          aliases,
        );
      }
    }

    const session = {
      id,
      agent_id: binding.agentId, shadow_id: binding.shadowId, binding_id: binding.id,
      channel_type: input.channelType,
      surface_key: surfaceKey,
      channel_id: input.channelId,
      group_id: input.groupId ?? null,
      thread_key: input.threadId ?? null,
      root_message_key:
        input.threadId !== undefined ? input.rootMessageId ?? null : null,
      parent_session_id: null,
      title: null,
      bot_user_id: shadow.replyUserId,
      status: "active",
      kind: input.kind ?? "main",
      created_by_user_id: null,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
    } satisfies SessionRow;

    db
      .insert(sessions)
      .values(session)
      .onConflictDoNothing({
        target: sessions.surface_key,
      })
      .run();

    const insertedOrExisting =
      this._resolveById(db, id) ?? this._resolveBySurfaceKey(db, surfaceKey);
    if (!insertedOrExisting) {
      throw new Error(`Failed to resolve session surface "${surfaceKey}".`);
    }
    if (insertedOrExisting.id !== id) {
      db.update(sessionSurfaceAliases)
        .set({ session_id: insertedOrExisting.id })
        .where(eq(sessionSurfaceAliases.session_id, id))
        .run();
    }
    return this._ensureAliasesAndBackfill(
      db,
      insertedOrExisting,
      input,
      aliases,
    );
  }

  private _resolveById(
    db: DrizzleDB,
    sessionId: string,
  ): SessionRow | undefined {
    return db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
  }

  private _resolveBySurfaceKey(
    db: DrizzleDB,
    surfaceKey: string,
  ): SessionRow | undefined {
    return db
      .select()
      .from(sessions)
      .where(eq(sessions.surface_key, surfaceKey))
      .get();
  }

  private _resolveByAliases(
    db: DrizzleDB,
    aliases: readonly string[],
  ): SessionSurfaceAliasRow | undefined {
    return this._resolveAliasRows(db, aliases)[0];
  }

  private _resolveAliasRows(
    db: DrizzleDB,
    aliases: readonly string[],
  ): SessionSurfaceAliasRow[] {
    const rows: SessionSurfaceAliasRow[] = [];
    for (const alias of new Set(aliases)) {
      const row = db
        .select()
        .from(sessionSurfaceAliases)
        .where(eq(sessionSurfaceAliases.alias_key, alias))
        .get();
      if (row) {
        rows.push(row);
      }
    }
    return rows;
  }

  private _resolveByThread(
    db: DrizzleDB,
    input: ResolveSessionSurfaceInput,
  ): SessionRow | undefined {
    if (input.threadId === undefined) {
      return undefined;
    }

    return db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.binding_id, new BotBindingStore(db).requireActive(input.channelId).id),
          ne(sessions.status, "deleted"),
          eq(sessions.channel_type, input.channelType),
          eq(sessions.channel_id, input.channelId),
          this._nullableEq(sessions.group_id, input.groupId),
          eq(sessions.thread_key, input.threadId),
        ),
      )
      .get();
  }

  private _ensureAliasesAndBackfill(
    db: DrizzleDB,
    row: SessionRow,
    input: ResolveSessionSurfaceInput,
    aliases: readonly string[],
  ): SessionRow {
    new SessionStore(db).requireChannelScope(row,input.channelId);
    let session = row;
    for (const alias of new Set(aliases)) {
      db.insert(sessionSurfaceAliases)
        .values({
          alias_key: alias,
          session_id: session.id,
          created_at: Date.now(),
        })
        .onConflictDoNothing()
        .run();
    }

    session = this._canonicalizeAliases(db, session, aliases);
    session = this._backfillSurfaceMetadata(db, session, input);

    for (const alias of new Set(aliases)) {
      db.insert(sessionSurfaceAliases)
        .values({
          alias_key: alias,
          session_id: session.id,
          created_at: Date.now(),
        })
        .onConflictDoNothing()
        .run();
      db.update(sessionSurfaceAliases)
        .set({ session_id: session.id })
        .where(eq(sessionSurfaceAliases.alias_key, alias))
        .run();
    }

    this._appendThreadReferences(db, session, input);

    return session;
  }

  private _appendThreadReferences(
    db: DrizzleDB,
    row: SessionRow,
    input: ResolveSessionSurfaceInput,
  ): void {
    if (input.threadId === undefined) {
      return;
    }

    const messageStore = new MessageStore(db);
    if (
      input.rootMessageId !== undefined &&
      input.createThreadLaunchContext !== false
    ) {
      const threadConfig = sessionConfigForAgent(db, row.agent_id, DEFAULT_SESSION_CONFIG);
      new LaunchContextBuilder(db).buildForThreadSessionFromSurface({
        threadSessionId: row.id,
        channelType: input.channelType,
        channelId: input.channelId,
        anchorExternalMessageId: input.rootMessageId,
        maxMessages: threadConfig.activation_context_max_messages,
        maxChars: threadConfig.activation_context_max_chars,
      });
    }

    const parentReferenceIds = [input.parentMessageId].filter(
      (messageId): messageId is string =>
        messageId !== undefined && messageId !== input.rootMessageId,
    );
    for (const externalMessageId of parentReferenceIds) {
      const message = messageStore.findByExternalMessageId({sessionId:row.id,
        channelType: input.channelType,
        channelId: input.channelId,
        externalMessageId,
      });
      if (message === undefined) {
        continue;
      }
      new SessionTimelineStore(db).appendReference({
        sessionId: row.id,
        messageId: message.id,
      });
    }
  }

  private _canonicalizeAliases(
    db: DrizzleDB,
    row: SessionRow,
    aliases: readonly string[],
  ): SessionRow {
    const candidateById = new Map<string, SessionRow>();
    candidateById.set(row.id, row);

    for (const aliasRow of this._resolveAliasRows(db, aliases)) {
      const session = this._resolveById(db, aliasRow.session_id);
      if (session) {
        candidateById.set(session.id, session);
      }
    }

    const candidates = [...candidateById.values()];
    const canonical = this._chooseCanonicalSession(candidates);
    for (const candidate of candidates) {
      if (candidate.id !== canonical.id) {
        this._mergeSessionIntoCanonical(db, candidate.id, canonical.id);
      }
    }

    for (const alias of new Set(aliases)) {
      db.update(sessionSurfaceAliases)
        .set({ session_id: canonical.id })
        .where(eq(sessionSurfaceAliases.alias_key, alias))
        .run();
    }

    return this._resolveById(db, canonical.id) ?? canonical;
  }

  private _chooseCanonicalSession(
    candidates: readonly SessionRow[],
  ): SessionRow {
    const [canonical] = [...candidates].sort((left, right) => {
      const scoreDiff =
        this._sessionMetadataScore(right) -
        this._sessionMetadataScore(left);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      const createdDiff = left.created_at - right.created_at;
      if (createdDiff !== 0) {
        return createdDiff;
      }
      return left.id.localeCompare(right.id);
    });

    if (!canonical) {
      throw new Error("Cannot canonicalize an empty session set.");
    }
    return canonical;
  }

  private _sessionMetadataScore(row: SessionRow): number {
    return (row.root_message_key === null ? 0 : 2) +
      (row.thread_key === null ? 0 : 1);
  }

  private _mergeSessionIntoCanonical(
    db: DrizzleDB,
    sourceSessionId: string,
    canonicalSessionId: string,
  ): void {
    const source = this._resolveById(db, sourceSessionId);
    const target = this._resolveById(db, canonicalSessionId);
    if (!source || !target || source.agent_id !== target.agent_id || source.shadow_id !== target.shadow_id || source.binding_id !== target.binding_id) throw new AgentError("scope_mismatch",409);
    if (source.bot_user_id) new SessionStore(db).bindBotUser(canonicalSessionId, source.bot_user_id);
    for (const binding of db.select().from(sessionChannelBindings).where(eq(sessionChannelBindings.sessionId, sourceSessionId)).all()) {
      const existing = db.select().from(sessionChannelBindings).where(and(eq(sessionChannelBindings.sessionId, canonicalSessionId), eq(sessionChannelBindings.channelId, binding.channelId))).get();
      if (!existing) db.update(sessionChannelBindings).set({ sessionId: canonicalSessionId }).where(eq(sessionChannelBindings.id,binding.id)).run();
      else db.delete(sessionChannelBindings).where(eq(sessionChannelBindings.id,binding.id)).run();
    }
    moveTimelineEntriesToCanonicalSession(
      db,
      sourceSessionId,
      canonicalSessionId,
    );
    const contextPackStore = new ContextPackStore(db);
    contextPackStore.moveSourceSessionReferences(
      sourceSessionId,
      canonicalSessionId,
    );
    contextPackStore.moveOwnerPacksToCanonicalSession(
      sourceSessionId,
      canonicalSessionId,
    );
    moveTaskSubscriptionsToCanonicalSession(
      db,
      sourceSessionId,
      canonicalSessionId,
    );
    db.update(timelineEvents)
      .set({ session_id: canonicalSessionId })
      .where(eq(timelineEvents.session_id, sourceSessionId))
      .run();
    this._mergeRunnerContextsIntoCanonical(
      db,
      sourceSessionId,
      canonicalSessionId,
    );
    db.update(sessionSurfaceAliases)
      .set({ session_id: canonicalSessionId })
      .where(eq(sessionSurfaceAliases.session_id, sourceSessionId))
      .run();
    db.delete(sessions)
      .where(eq(sessions.id, sourceSessionId))
      .run();
  }

  private _mergeRunnerContextsIntoCanonical(
    db: DrizzleDB,
    sourceSessionId: string,
    canonicalSessionId: string,
  ): void {
    const sourceRows = db
      .select()
      .from(runnerContexts)
      .where(
        and(
          eq(runnerContexts.owner_type, "session"),
          eq(runnerContexts.owner_id, sourceSessionId),
        ),
      )
      .all();

    const { runnerRootPath } =
      createSessionRunnerPaths(canonicalSessionId);
    for (const sourceRow of sourceRows) {
      const canonicalRow = db
        .select()
        .from(runnerContexts)
        .where(
          and(
            eq(runnerContexts.owner_type, "session"),
            eq(runnerContexts.owner_id, canonicalSessionId),
            eq(runnerContexts.runner_type, sourceRow.runner_type),
          ),
        )
        .get();

      if (canonicalRow) {
        db.delete(runnerContexts)
          .where(eq(runnerContexts.id, sourceRow.id))
          .run();
        continue;
      }

      db.update(runnerContexts)
        .set({
          owner_id: canonicalSessionId,
          runner_root_path: runnerRootPath,
          updated_at: Date.now(),
        })
        .where(eq(runnerContexts.id, sourceRow.id))
        .run();
    }
  }

  private _backfillSurfaceMetadata(
    db: DrizzleDB,
    row: SessionRow,
    input: ResolveSessionSurfaceInput,
  ): SessionRow {
    if (row.channel_id !== input.channelId || row.channel_type !== input.channelType) return row;
    const nextThreadId =
      row.thread_key === null && input.threadId !== undefined
        ? input.threadId
        : undefined;
    const nextRootMessageId =
      row.root_message_key === null &&
      input.threadId !== undefined &&
      input.rootMessageId !== undefined
        ? input.rootMessageId
        : undefined;

    if (nextThreadId === undefined && nextRootMessageId === undefined) {
      return row;
    }

    const updatedAt = Date.now();
    db
      .update(sessions)
      .set({
        ...(nextThreadId !== undefined ? { thread_key: nextThreadId } : {}),
        ...(nextRootMessageId !== undefined
          ? { root_message_key: nextRootMessageId }
          : {}),
        updated_at: updatedAt,
      })
      .where(eq(sessions.id, row.id))
      .run();

    return {
      ...row,
      ...(nextThreadId !== undefined ? { thread_key: nextThreadId } : {}),
      ...(nextRootMessageId !== undefined
        ? { root_message_key: nextRootMessageId }
        : {}),
      updated_at: updatedAt,
    };
  }

  private _createSurfaceAliases(
    input: ResolveSessionSurfaceInput,
  ): string[] {
    const aliases: string[] = [];
    if (input.threadId !== undefined) {
      aliases.push(
        this._createSurfaceKeyForDiscriminator(input, "thread", input.threadId),
      );
      if (input.rootMessageId !== undefined) {
        aliases.push(
          this._createSurfaceKeyForDiscriminator(input, "root", input.rootMessageId),
        );
      }
    } else {
      aliases.push(this._createSurfaceKeyForDiscriminator(input, "channel", "rootless"));
    }
    return aliases;
  }

  private _nullableEq<TColumn>(
    column: TColumn,
    value: string | undefined,
  ): ReturnType<typeof eq> | ReturnType<typeof isNull> {
    if (value === undefined) {
      return isNull(column as Parameters<typeof isNull>[0]);
    }
    return eq(column as Parameters<typeof eq>[0], value);
  }

  private _createSurfaceKey(input: ResolveSessionSurfaceInput): string {
    const discriminator =
      input.threadId !== undefined
          ? ["thread", input.threadId]
          : ["channel", "rootless"];

    return JSON.stringify([
      "v2",
      new BotBindingStore(this._db).requireActive(input.channelId).id,
      input.channelType,
      input.channelId,
      input.groupId ?? null,
      ...discriminator,
    ]);
  }

  private _createSurfaceKeyForDiscriminator(
    input: ResolveSessionSurfaceInput,
    kind: "channel" | "root" | "thread",
    value: string,
  ): string {
    return JSON.stringify([
      "v2",
      new BotBindingStore(this._db).requireActive(input.channelId).id,
      input.channelType,
      input.channelId,
      input.groupId ?? null,
      kind,
      value,
    ]);
  }
}
