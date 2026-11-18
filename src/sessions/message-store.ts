import {BotBindingStore} from "@/agents/bot-binding-store";
import { IdentityDirectory } from "@/identity/identity-directory";
import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  channelIdentities,
  messageMentions,
  messages,
  sessionTimelineEntries,
  sessionTurnEntries,
  sessionTurns,
  sessions,
  channelUserBindings,
  users,
} from "@/data/schema";
import {
  isReservedSystemUserId,
  LUNA_INTERNAL_USER_ID,
  systemUserKind,
  SystemUserStore,
} from "@/identity/system-user-store";
import { inferUserKindForChannelIdentity } from "@/identity/identity-directory";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import { uuid } from "@/shared";

import { normalizeMessageContent } from "./message-content";
import { SessionTimelineStore } from "./session-timeline-store";
import type {
  AppendMessageInput,
  MessageContentBlock,
  MessageContentKind,
  MessagePresentationKind,
  SessionMessageKind,
  SessionMessageRole,
} from "./types";

type PersistedMessageRow = typeof messages.$inferSelect;

/**
 * Persisted message fact plus snake_case aliases consumed by existing routes.
 */
export interface MessageRow {
  readonly id: string;
  readonly sessionId?: string;
  readonly channelType?: string;
  readonly channelId?: string;
  readonly externalMessageId?: string;
  readonly channelMessageKey?: string | null;
  readonly senderIdentityId?: string | null;
  readonly senderUserId?: string | null;
  readonly role: SessionMessageRole | string;
  readonly messageKind?: SessionMessageKind;
  readonly contentKind?: MessageContentKind;
  readonly presentationKind?: MessagePresentationKind;
  readonly providerMessageType?: string | null;
  readonly contentJson?: readonly MessageContentBlock[];
  readonly rawPayloadJson?: unknown;
  readonly occurredAt?: number;
  readonly createdAt?: number;
  readonly session_id: string;
  readonly channel_message_key: string | null;
  readonly sender_user_id: string | null;
  readonly message_kind: SessionMessageKind | string;
  readonly content_json: unknown;
  readonly raw_payload_json?: unknown;
  readonly created_at: number;
}

type SenderIdentityLike = {
  readonly externalId: string;
  readonly kind: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly rawProfile?: unknown;
};

/**
 * Result contract returned by persistence append message operations in session.
 */
export interface AppendMessageResult {
  readonly row: MessageRow;
  readonly created: boolean;
}

let lastMessageCreatedAt = 0;

/**
 * Persists provider-neutral message facts and projects them into session timelines.
 */
export class MessageStore {
  private readonly _directory: ChannelDirectoryStore;
  private readonly _systemUsers: SystemUserStore;
  private readonly _timeline: SessionTimelineStore;

  constructor(private readonly _db: DrizzleDB) {
    this._directory = new ChannelDirectoryStore(_db);
    this._systemUsers = new SystemUserStore(_db);
    this._timeline = new SessionTimelineStore(_db);
  }

  append(input: AppendMessageInput): MessageRow {
    return this._appendMessage(input).row;
  }

  appendOnce(input: AppendMessageInput): AppendMessageResult {
    return this._appendMessage(input);
  }

  appendOrUpdateOnce(input: AppendMessageInput): AppendMessageResult {
    const result = this._appendMessage(input);
    if (result.created) {
      return result;
    }
    return {
      row: this.updateContentAndPresentation(result.row.id, input),
      created: false,
    };
  }

  updateRawPayload(rowId: string, rawPayload: unknown): MessageRow {
    this._db
      .update(messages)
      .set({ rawPayloadJson: rawPayload })
      .where(eq(messages.id, rowId))
      .run();

    const row = this._db.select().from(messages).where(eq(messages.id, rowId)).get();
    if (row === undefined) {
      throw new Error(`Message row "${rowId}" was not found after raw payload update.`);
    }
    const sessionId = this._owningSessionIdForMessage(row.id);
    return this._toMessageRow(
      row,
      sessionId === undefined ? {} : { sessionId },
    );
  }

  updateContentAndPresentation(
    rowId: string,
    input: AppendMessageInput,
  ): MessageRow {
    const existing=this._db.select().from(messages).where(and(eq(messages.id,rowId),this._messageScope(input.sessionId))).get();
    if(!existing)throw new Error("message_scope_mismatch");
    const normalizedContent = normalizeMessageContent(input.content);
    const rawPayload = rawPayloadFromInput(input);
    this._db
      .update(messages)
      .set({
        contentKind:
          input.contentKind ??
          input.inbound?.contentKind ??
          normalizedContent.contentKind,
        presentationKind:
          input.presentationKind ??
          input.inbound?.presentationKind ??
          normalizedContent.presentationKind,
        providerMessageType:
          input.providerMessageType ??
          input.inbound?.providerMessageType ??
          providerMessageType(rawPayload),
        contentJson: normalizedContent.blocks,
        rawPayloadJson: rawPayload,
      })
      .where(eq(messages.id, rowId))
      .run();

    const row = this._db.select().from(messages).where(eq(messages.id, rowId)).get();
    if (row === undefined) {
      throw new Error(`Message row "${rowId}" was not found after content update.`);
    }
    const sessionId = this._owningSessionIdForMessage(row.id);
    return this._toMessageRow(
      row,
      sessionId === undefined ? {} : { sessionId },
    );
  }

  hasAssistantChannelMessage(input: {
    readonly sessionId: string;
    readonly channelMessageKeys: readonly string[];
  }): boolean {
    if (input.channelMessageKeys.length === 0) {
      return false;
    }

    const row = this._db
      .select({ id: messages.id })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(
        and(
          eq(sessionTimelineEntries.sessionId, input.sessionId),
          eq(sessionTimelineEntries.entryKind, "message"),
          eq(messages.role, "assistant"),
          inArray(messages.externalMessageId, [...input.channelMessageKeys]),
        ),
      )
      .get();
    return row !== undefined;
  }

  hasAssistantChannelMessageOnSurface(input: {
    readonly channelType: string;
    readonly channelId: string;
    readonly groupId?: string;
    readonly channelMessageKeys: readonly string[];
  }): boolean {
    if (input.channelMessageKeys.length === 0) {
      return false;
    }

    const binding=new BotBindingStore(this._db).requireActive(input.channelId);
    const groupPredicate =
      input.groupId === undefined
        ? isNull(sessions.group_id)
        : eq(sessions.group_id, input.groupId);

    const row = this._db
      .select({ id: messages.id })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .innerJoin(sessions, eq(sessionTimelineEntries.sessionId, sessions.id))
      .where(
        and(
          eq(messages.bindingId,binding.id),
          eq(messages.role, "assistant"),
          eq(messages.channelType, input.channelType),
          eq(messages.channelId, input.channelId),
          groupPredicate,
          inArray(messages.externalMessageId, [...input.channelMessageKeys]),
        ),
      )
      .get();
    return row !== undefined;
  }

  listRecentUserMessagesBefore(input: {
    readonly sessionId: string;
    readonly beforeCreatedAt: number;
    readonly sinceCreatedAt: number;
  }): MessageRow[] {
    const candidateRows = this._db
      .select({ message: messages })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(
        and(
          eq(sessionTimelineEntries.sessionId, input.sessionId),
          eq(messages.role, "user"),
          gte(messages.occurredAt, input.sinceCreatedAt),
          lt(messages.occurredAt, input.beforeCreatedAt),
        ),
      )
      .orderBy(asc(messages.occurredAt), asc(messages.id))
      .all();
    if (candidateRows.length === 0) {
      return [];
    }
    return this._excludeMessagesAlreadySentToRunner({
      sessionId: input.sessionId,
      beforeCreatedAt: input.beforeCreatedAt,
      candidateRows,
    });
  }

  listRecentSkippedUserMessagesBefore(input: {
    readonly sessionId: string;
    readonly beforeCreatedAt: number;
    readonly limit: number;
  }): MessageRow[] {
    if (input.limit === 0) {
      return [];
    }

    const candidateRows = this._db
      .select({ message: messages })
      .from(sessionTurnEntries)
      .innerJoin(sessionTurns, eq(sessionTurnEntries.turn_id, sessionTurns.id))
      .innerJoin(
        sessionTimelineEntries,
        eq(sessionTurnEntries.entry_id, sessionTimelineEntries.id),
      )
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(
        and(
          eq(sessionTurnEntries.session_id, input.sessionId),
          eq(sessionTurnEntries.role, "skipped"),
          eq(sessionTurns.runner_invoked, false),
          eq(sessionTimelineEntries.entryKind, "message"),
          eq(messages.role, "user"),
          lt(messages.occurredAt, input.beforeCreatedAt),
        ),
      )
      .orderBy(desc(messages.occurredAt), desc(messages.id))
      .limit(input.limit)
      .all()
      .reverse();
    return this._excludeMessagesAlreadySentToRunner({
      sessionId: input.sessionId,
      beforeCreatedAt: input.beforeCreatedAt,
      candidateRows,
    });
  }

  listLatestUserMessagesBefore(input: {
    readonly sessionId: string;
    readonly beforeCreatedAt: number;
    readonly limit: number;
    readonly excludeMessagesAlreadySentToRunner?: boolean;
  }): MessageRow[] {
    if (input.limit === 0) {
      return [];
    }

    const candidateRows = this._db
      .select({ message: messages })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(
        and(
          eq(sessionTimelineEntries.sessionId, input.sessionId),
          eq(messages.role, "user"),
          lt(messages.occurredAt, input.beforeCreatedAt),
        ),
      )
      .orderBy(desc(messages.occurredAt), desc(messages.id))
      .limit(input.limit)
      .all()
      .reverse();
    if (input.excludeMessagesAlreadySentToRunner !== true) {
      return candidateRows.map((row) =>
        this._toMessageRow(row.message, { sessionId: input.sessionId })
      );
    }
    return this._excludeMessagesAlreadySentToRunner({
      sessionId: input.sessionId,
      beforeCreatedAt: input.beforeCreatedAt,
      candidateRows,
    });
  }

  listMessagesBefore(input: {
    readonly sessionId: string;
    readonly beforeCreatedAt: number;
    readonly sinceCreatedAt?: number;
  }): MessageRow[] {
    const bounds =
      input.sinceCreatedAt === undefined
        ? and(
            eq(sessionTimelineEntries.sessionId, input.sessionId),
            lt(messages.occurredAt, input.beforeCreatedAt),
          )
        : and(
            eq(sessionTimelineEntries.sessionId, input.sessionId),
            gte(messages.occurredAt, input.sinceCreatedAt),
            lt(messages.occurredAt, input.beforeCreatedAt),
          );

    return this._db
      .select({ message: messages })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(bounds)
      .orderBy(asc(messages.occurredAt), asc(messages.id))
      .all()
      .map((row) => this._toMessageRow(row.message, { sessionId: input.sessionId }));
  }

  findByExternalMessageId(input: {
    readonly sessionId:string;
    readonly channelType:string;
    readonly channelId:string;
    readonly externalMessageId:string;
    readonly role?:SessionMessageRole;
  }):MessageRow|undefined {
    const row=this._db.select().from(messages).where(and(
      this._messageScope(input.sessionId),eq(messages.channelType,input.channelType),eq(messages.channelId,input.channelId),
      eq(messages.externalMessageId,input.externalMessageId),input.role?eq(messages.role,input.role):undefined,
    )).orderBy(asc(messages.occurredAt),asc(messages.id)).get();
    if(!row)return undefined;
    return this._toMessageRow(row,row.ownerSessionId?{sessionId:row.ownerSessionId}:{});
  }

  private _messageScope(sessionId:string){
    const session=this._db.select().from(sessions).where(eq(sessions.id,sessionId)).get();
    if(!session)throw new Error("message_session_scope_required");
    return and(eq(messages.agentId,session.agent_id),eq(messages.shadowId,session.shadow_id),
      session.binding_id===null?isNull(messages.bindingId):eq(messages.bindingId,session.binding_id));
  }

  private _appendMessage(input: AppendMessageInput): AppendMessageResult {
    return this._db.transaction(tx=>new MessageStore(tx as unknown as DrizzleDB)._appendMessageInTransaction(input));
  }

  private _appendMessageInTransaction(input: AppendMessageInput): AppendMessageResult {
    const session=this._db.select().from(sessions).where(eq(sessions.id,input.sessionId)).get();
    if(!session||session.status!=="active")throw new Error("message_session_scope_required");
    this._upsertDirectory(input, session.agent_id);
    this._upsertMentionTargets(input, session.agent_id);

    const messageId = uuid();
    const channel = this._resolveMessageChannel(input);
    const externalMessageId =
      input.channelMessageKey ?? input.inbound?.id ?? messageId;
    const occurredAt = input.createdAt ?? nextMessageCreatedAt();
    const messageKind = input.messageKind ?? defaultMessageKind(input.role);
    const normalizedContent = normalizeMessageContent(input.content);
    const rawPayload = rawPayloadFromInput(input);
    const sender = this._resolvedSender(input, channel, messageKind, session.agent_id);
    const values = {
      id: messageId,
      agentId:session.agent_id,shadowId:session.shadow_id,bindingId:session.binding_id,
      ownerSessionId: input.sessionId,
      channelType: channel.channelType,
      channelId: channel.channelId,
      externalMessageId,
      senderUserId: sender.senderUserId,
      senderIdentityId: sender.senderIdentityId,
      role: input.role,
      contentKind:
        input.contentKind ??
        input.inbound?.contentKind ??
        normalizedContent.contentKind,
      presentationKind:
        input.presentationKind ??
        input.inbound?.presentationKind ??
        normalizedContent.presentationKind,
      providerMessageType:
        input.providerMessageType ??
        input.inbound?.providerMessageType ??
        providerMessageType(rawPayload),
      contentJson: normalizedContent.blocks,
      rawPayloadJson: rawPayload,
      occurredAt,
      createdAt: occurredAt,
    };

    this._db
      .insert(messages)
      .values(values)
      .onConflictDoNothing()
      .run();

    const persisted = this._requireMessage({
      sessionId:input.sessionId,
      channelType: channel.channelType,
      channelId: channel.channelId,
      externalMessageId,
      role: input.role,
    });
    if (persisted.deletedAt !== null) throw new Error("Deleted message cannot be reused");
    const appendEntry = persisted.ownerSessionId === input.sessionId
      ? this._timeline.appendMessage.bind(this._timeline)
      : this._timeline.appendReference.bind(this._timeline);
    appendEntry({ sessionId: input.sessionId, messageId: persisted.id });
    this._appendMentions(persisted.id, input);
    if (messageKind !== "internal") {
      this._touchSession(input.sessionId, persisted.occurredAt);
    }

    return {
      row: this._toMessageRow(persisted, {
        sessionId: this._owningSessionIdForMessage(persisted.id) ?? input.sessionId,
        channelMessageKey: input.channelMessageKey ?? null,
        senderUserId: sender.senderUserId,
        messageKind,
      }),
      created: persisted.id === messageId,
    };
  }

  private _excludeMessagesAlreadySentToRunner(input: {
    readonly sessionId: string;
    readonly beforeCreatedAt: number;
    readonly candidateRows: readonly { readonly message: PersistedMessageRow }[];
  }): MessageRow[] {
    if (input.candidateRows.length === 0) {
      return [];
    }

    const candidateMessageIds = input.candidateRows.map((row) => row.message.id);
    const usedMessageIds = new Set(
      this._db
        .select({ messageId: sessionTimelineEntries.messageId })
        .from(sessionTurnEntries)
        .innerJoin(sessionTurns, eq(sessionTurnEntries.turn_id, sessionTurns.id))
        .innerJoin(
          sessionTimelineEntries,
          eq(sessionTurnEntries.entry_id, sessionTimelineEntries.id),
        )
        .where(
          and(
            eq(sessionTurnEntries.session_id, input.sessionId),
            eq(sessionTurns.runner_invoked, true),
            lt(sessionTurns.started_at, input.beforeCreatedAt),
            inArray(sessionTurnEntries.role, [
              "trigger",
              "coalesced_input",
              "context",
              "launch_context",
            ]),
            inArray(sessionTimelineEntries.messageId, candidateMessageIds),
          ),
        )
        .all()
        .map((row) => row.messageId),
    );

    return input.candidateRows
      .filter((row) => !usedMessageIds.has(row.message.id))
      .map((row) => this._toMessageRow(row.message, { sessionId: input.sessionId }));
  }

  private _requireMessage(input: {
    readonly sessionId:string;
    readonly channelType: string;
    readonly channelId: string;
    readonly externalMessageId: string;
    readonly role: SessionMessageRole;
  }): PersistedMessageRow {
    const row = this._db
      .select()
      .from(messages)
      .where(
        and(
          this._messageScope(input.sessionId),
          eq(messages.channelType, input.channelType),
          eq(messages.channelId, input.channelId),
          eq(messages.externalMessageId, input.externalMessageId),
          eq(messages.role, input.role),
        ),
      )
      .get();
    if (row === undefined) {
      throw new Error(
        `Message "${input.externalMessageId}" was not found after append.`,
      );
    }
    return row;
  }

  private _touchSession(sessionId: string, updatedAt: number): void {
    this._db
      .update(sessions)
      .set({ updated_at: updatedAt, last_activity_at: updatedAt })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  private _appendMentions(messageId: string, input: AppendMessageInput): void {
    if (
      input.mentions === undefined ||
      input.mentions.length === 0 ||
      input.channel === undefined
    ) {
      return;
    }
    const createdAt = Date.now();
    for (const mention of input.mentions) {
      if (mention.target.externalId.length === 0) {
        continue;
      }
      const targetIdentityId = this._findMentionTargetIdentityId({
        channelType: input.channel.type,
        channelId: input.channel.id,
        targetExternalId: mention.target.externalId,
      });
      if (targetIdentityId !== null) new IdentityDirectory(this._db).applyMentionDisplayName(targetIdentityId, mention.label);
      const existingMention = this._db
        .select()
        .from(messageMentions)
        .where(
          and(
            eq(messageMentions.messageId, messageId),
            eq(messageMentions.mentionKey, mention.key),
            eq(messageMentions.mentionLabel, mention.label),
            eq(messageMentions.targetExternalId, mention.target.externalId),
            eq(messageMentions.targetKind, mention.target.kind),
          ),
        )
        .get();
      if (existingMention !== undefined) {
        if (
          existingMention.targetIdentityId === null &&
          targetIdentityId !== null
        ) {
          this._db
            .update(messageMentions)
            .set({ targetIdentityId })
            .where(eq(messageMentions.id, existingMention.id))
            .run();
        }
        continue;
      }
      this._db
        .insert(messageMentions)
        .values({
          id: uuid(),
          messageId,
          mentionKey: mention.key,
          mentionLabel: mention.label,
          targetIdentityId,
          targetExternalId: mention.target.externalId,
          targetKind: mention.target.kind,
          rawMentionJson: JSON.stringify(mention.rawMention ?? mention),
          createdAt,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  private _upsertMentionTargets(input: AppendMessageInput, agentId: string): void {
    if (
      input.mentions === undefined ||
      input.mentions.length === 0 ||
      input.channel === undefined
    ) {
      return;
    }
    for (const mention of input.mentions) {
      if (mention.target.externalId.length === 0) {
        continue;
      }
      this._directory.ensureMentionTarget({
        channel: input.channel,
        mention,
        agentId,
      });
    }
  }

  private _upsertDirectory(input: AppendMessageInput, agentId: string): void {
    const channel = input.channel ?? input.inbound?.channel;
    if (channel === undefined) {
      return;
    }

    if (
      input.sender !== undefined &&
      !shouldSkipSenderIdentityUpsert(input)
    ) {
      this._directory.upsertIdentity({
        channel,
        identity: input.sender,
        agentId,
      });
    } else if (
      input.sender === undefined &&
      input.inbound?.sender !== undefined &&
      !shouldSkipSenderIdentityUpsert(input)
    ) {
      this._directory.upsertIdentity({
        channel,
        identity: input.inbound.sender,
        agentId,
      });
    }
    for (const identity of input.relatedIdentities ?? []) {
      this._directory.upsertIdentity({
        channel,
        identity,
        agentId,
      });
    }
    const surface = input.surface ?? input.inbound?.surface;
    if (surface !== undefined) {
      this._directory.upsertSurface({
        channel,
        surface,
      });
    }
  }

  private _senderIdentityId(
    input: AppendMessageInput,
    channel: ChannelFingerprint,
  ): string | null {
    if (
      input.senderUserId !== undefined &&
      isReservedSystemUserId(input.senderUserId)
    ) {
      return null;
    }
    const senderExternalId =
      input.sender?.externalId ??
      input.inbound?.sender.externalId;
    if (senderExternalId === undefined) {
      return null;
    }
    return this._findIdentityId({
      channelType: channel.channelType,
      channelId: channel.channelId,
      externalId: senderExternalId,
    });
  }

  private _findMentionTargetIdentityId(input: {
    readonly channelType: string;
    readonly channelId: string;
    readonly targetExternalId: string;
  }): string | null {
    return this._findIdentityId({
      channelType: input.channelType,
      channelId: input.channelId,
      externalId: input.targetExternalId,
    });
  }

  private _findIdentityId(input: {
    readonly channelType: string;
    readonly channelId: string;
    readonly externalId: string;
  }): string | null {
    return (
      this._db
        .select({ id: channelIdentities.id })
        .from(channelIdentities)
        .where(
          and(
            eq(channelIdentities.channelType, input.channelType),
            eq(channelIdentities.channelId, input.channelId),
            eq(channelIdentities.externalId, input.externalId),
          ),
        )
        .get()?.id ?? null
    );
  }

  private _resolvedSender(
    input: AppendMessageInput,
    channel: ChannelFingerprint,
    messageKind: SessionMessageKind,
    agentId: string,
  ): {
    readonly senderUserId: string;
    readonly senderIdentityId: string | null;
  } {
    const explicitSenderUserId = normalizedSenderUserId(input.senderUserId);
    if (explicitSenderUserId !== undefined) {
      if (isReservedSystemUserId(explicitSenderUserId)) {
        return {
          senderUserId: this._materializeSystemSender(explicitSenderUserId, agentId),
          senderIdentityId: null,
        };
      }
      this._ensureCanonicalUserRecord(explicitSenderUserId, input, messageKind, agentId);
      return {
        senderUserId: explicitSenderUserId,
        senderIdentityId: this._senderIdentityId(input, channel),
      };
    }

    const reservedSenderUserId = reservedSystemSenderUserId(messageKind);
    if (reservedSenderUserId !== undefined) {
      return {
        senderUserId: this._materializeSystemSender(reservedSenderUserId, agentId),
        senderIdentityId: null,
      };
    }

    const senderIdentityId = this._senderIdentityId(input, channel);
    if (senderIdentityId !== null) {
      const senderUserId = this._userIdForSenderIdentityId(senderIdentityId);
      if (senderUserId !== null) {
        return { senderUserId, senderIdentityId };
      }
    }

    throw new Error(
      `Message sender must resolve to a canonical user before persistence: ${input.role}:${input.sessionId}`,
    );
  }

  private _materializeSystemSender(userId: string, agentId: string): string {
    return this._systemUsers.requireUserId(systemUserKind(userId), agentId);
  }

  private _ensureCanonicalUserRecord(
    userId: string,
    input: AppendMessageInput,
    messageKind: SessionMessageKind,
    agentId: string,
  ): void {
    const existing = this._db
      .select({ id: users.id, agentId: users.agentId })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (existing !== undefined) {
      if (existing.agentId !== agentId) throw new Error("message_sender_agent_mismatch");
      return;
    }
    const now = String(Date.now());
    const sender = messageSenderIdentity(input);
    this._db
      .insert(users)
      .values({
        id: userId,
        agentId,
        kind: canonicalUserKind(sender, input.role, messageKind),
        displayName:
          normalizedDisplayName(sender) ??
          defaultDisplayNameForRole(input.role, userId),
        avatarUrl: sender?.avatarUrl ?? null,
        status: "active",
        mergedIntoUserId: null,
        profileSource: sender === undefined ? "manual" : "channel",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  private _userIdForSenderIdentityId(senderIdentityId: string): string | null {
    return this._db
      .select({ userId: channelUserBindings.userId })
      .from(channelUserBindings)
      .where(eq(channelUserBindings.channelIdentityId, senderIdentityId))
      .get()?.userId ?? null;
  }

  private _owningSessionIdForMessage(messageId: string): string | undefined {
    return this._db.select({ owner: messages.ownerSessionId }).from(messages)
      .where(eq(messages.id, messageId)).get()?.owner ?? undefined;
  }

  private _resolveMessageChannel(input: AppendMessageInput): ChannelFingerprint {
    if (input.channel !== undefined) {
      return {
        channelType: input.channel.type,
        channelId: input.channel.id,
      };
    }
    if (input.inbound !== undefined) {
      return {
        channelType: input.inbound.channel.type,
        channelId: input.inbound.channel.id,
      };
    }
    const rawChannel = channelIdentity(input.rawPayload);
    if (isCompleteChannelFingerprint(rawChannel)) {
      return rawChannel;
    }
    const session = this._db
      .select({
        channelType: sessions.channel_type,
        channelId: sessions.channel_id,
      })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get();
    if (session !== undefined) {
      return session;
    }
    throw new Error(
      `Unable to resolve message channel identity for session "${input.sessionId}". Provide input.channel, input.inbound, rawPayload channel data, or an existing session row.`,
    );
  }

  private _toMessageRow(
    row: PersistedMessageRow,
    options: {
      readonly sessionId?: string;
      readonly channelMessageKey?: string | null;
      readonly senderUserId?: string | null;
      readonly messageKind?: SessionMessageKind;
    } = {},
  ): MessageRow {
    const sessionId = options.sessionId ?? "";
    const channelMessageKey = options.channelMessageKey ?? row.externalMessageId;
    const senderUserId = options.senderUserId ?? row.senderUserId;
    const messageKind = options.messageKind ?? defaultMessageKind(asRole(row.role));
    const contentJson = asMessageContentBlocks(row.contentJson);
    const base = {
      id: row.id,
      sessionId,
      channelType: row.channelType,
      channelId: row.channelId,
      externalMessageId: row.externalMessageId,
      channelMessageKey,
      senderIdentityId: row.senderIdentityId,
      senderUserId,
      role: asRole(row.role),
      messageKind,
      contentKind: asContentKind(row.contentKind),
      presentationKind: asPresentationKind(row.presentationKind),
      providerMessageType: row.providerMessageType,
      contentJson,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt,
      session_id: sessionId,
      channel_message_key: channelMessageKey,
      sender_user_id: senderUserId,
      message_kind: messageKind,
      content_json: contentJson,
      created_at: row.occurredAt,
    };
    return row.rawPayloadJson === undefined
      ? base
      : {
          ...base,
          rawPayloadJson: row.rawPayloadJson,
          raw_payload_json: row.rawPayloadJson,
        };
  }
}

function normalizedSenderUserId(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function shouldSkipSenderIdentityUpsert(input: AppendMessageInput): boolean {
  if (
    input.senderUserId !== undefined &&
    isReservedSystemUserId(input.senderUserId)
  ) {
    return true;
  }
  const messageKind = input.messageKind ?? defaultMessageKind(input.role);
  return reservedSystemSenderUserId(messageKind) !== undefined;
}

function reservedSystemSenderUserId(
  messageKind: SessionMessageKind,
): string | undefined {
  if (messageKind === "internal") {
    return LUNA_INTERNAL_USER_ID;
  }
  return undefined;
}

function messageSenderIdentity(
  input: AppendMessageInput,
): SenderIdentityLike | undefined {
  return input.sender ?? input.inbound?.sender;
}

function canonicalUserKind(
  sender: SenderIdentityLike | undefined,
  _role: SessionMessageRole,
  messageKind: SessionMessageKind,
): "human" | "bot" | "system" {
  if (messageKind === "internal") {
    return "system";
  }
  if (sender !== undefined) {
    const inferred = inferUserKindForChannelIdentity({
      kind:
        sender.kind === "user" ||
          sender.kind === "bot" ||
          sender.kind === "system" ||
          sender.kind === "unknown"
          ? sender.kind
          : "unknown",
      rawProfile: sender.rawProfile,
    });
    if (inferred === "bot" || inferred === "system") {
      return inferred;
    }
  }
  return "human";
}

function normalizedDisplayName(
  sender: SenderIdentityLike | undefined,
): string | undefined {
  const displayName = sender?.displayName?.trim();
  if (displayName !== undefined && displayName.length > 0) {
    return displayName;
  }
  return undefined;
}

function defaultDisplayNameForRole(
  _role: SessionMessageRole,
  userId: string,
): string {
  return userId;
}

interface ChannelFingerprint {
  readonly channelType: string;
  readonly channelId: string;
}

function defaultMessageKind(role: AppendMessageInput["role"]): SessionMessageKind {
  return role === "user" ? "user_message" : "assistant_message";
}

function channelIdentity(value: unknown): Partial<ChannelFingerprint> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const normalizedChannel =
    typeof record.channel === "object" && record.channel !== null
      ? (record.channel as Record<string, unknown>)
      : undefined;
  const channelType =
    typeof record.channelType === "string"
      ? record.channelType
      : typeof normalizedChannel?.type === "string"
        ? normalizedChannel.type
        : undefined;
  const channelId =
    typeof record.channelId === "string"
      ? record.channelId
      : typeof normalizedChannel?.id === "string"
        ? normalizedChannel.id
        : undefined;
  return {
    ...(channelType !== undefined ? { channelType } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
  };
}

function isCompleteChannelFingerprint(
  value: Partial<ChannelFingerprint> | undefined,
): value is ChannelFingerprint {
  return value?.channelType !== undefined && value.channelId !== undefined;
}

function rawPayloadFromInput(input: AppendMessageInput): unknown {
  const basePayload =
    input.rawPayload !== undefined
      ? input.rawPayload
      : input.inbound !== undefined
        ? input.inbound
        : null;
  if (input.ingestMetadata === undefined) {
    return basePayload;
  }
  if (
    typeof basePayload !== "object" ||
    basePayload === null ||
    Array.isArray(basePayload)
  ) {
    return {
      rawPayload: basePayload,
      lunaIngest: input.ingestMetadata,
    };
  }
  return {
    ...basePayload,
    lunaIngest: input.ingestMetadata,
  };
}

function providerMessageType(rawPayload: unknown): string | null {
  const record = asRecord(rawPayload);
  const event = asRecord(record?.event);
  const message = asRecord(record?.message) ?? asRecord(event?.message);
  return (
    stringField(record, "message_type") ??
    stringField(record, "msg_type") ??
    stringField(message, "message_type") ??
    stringField(message, "msg_type") ??
    null
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function nextMessageCreatedAt(): number {
  const now = Date.now();
  const createdAt = Math.max(now, lastMessageCreatedAt + 1);
  lastMessageCreatedAt = createdAt;
  return createdAt;
}
