import { maintainMemory, type MemoryMaintenanceSettings } from "@/agents/agent-memory-maintenance";
import { createShadowHeartbeatRoutine } from "@/agents/shadow-heartbeat";
import type { SelfRoutine } from "@/agents/self-routines";
import { TaskRunStore } from "@/tasks/task-run-store";
import { createCorrelatedRequestExpiryRoutine } from "./correlated-request-service";
import { evaluateOutboundGovernance, releaseDeferredOutboundCommands } from "./outbound-governance";
import { notifyFailedSchedules } from "./schedule-failure-notifier";
import {AgentStore} from "@/agents/agent-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import {ContextPackScope} from "@/context/context-pack-scope";
import { completeProcessingOnce } from "@/messaging/processing-markers";
import { selectLaunchMessages } from "@/sessions/launch-context-selection";
import { bindGroupLaunchContext, selectGroupLaunchMessages } from "@/sessions/group-launch-context";
import { parseReply, replyMarkdown, type ReplyDocument } from "@luna/runner-protocol/reply";
import { groupCreationSchema, groupInvitationSchema, groupContextMessageIdsSchema, type GroupCreation, type GroupInvitation } from "./group-commands";
import { ProviderDeliveryRejected } from "./provider-delivery-error";
import { requireFeishuRecipientClaim } from "./feishu-recipient";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { InvocationStore } from "@/runners/invocation-store";
import { SessionStore } from "@/sessions/session-store";
import { ChannelDirectoryStore, isGroupChannelSurface } from "@/channels/directory-store";
import { calendarOccurrence } from "@luna/service-client/schedule-timing";
import { ContextPackStore } from "@/context/context-pack-store";
import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { channelIdentities, channelSurfaces, channelUserBindings, directRecipients, sessionCommands, sessions, tasks, users, managedArtifacts, messages, scheduleOccurrences, sessionSchedules, sessionInbox } from "@/data/schema";
import { MessageStore } from "@/sessions/message-store";
import { normalizedInboundFromMessageRow } from "@/runners/message-envelope";
import { sessionDispatcherFor, SessionDispatcher } from "@/sessions/session-dispatcher";
import { GatewayError } from "@/server/gateway-error";
import type { ReplyChannel } from "@/channels/outbound";
import type { NormalizedInboundMessage } from "@/channels";
import { scanArtifactRefs } from "@luna/service-client/artifact-ref";
/** Memory is maintained at most this often; the worker itself ticks every 250 ms. */
const MEMORY_SCAN_INTERVAL_MS = 60_000;
export interface CommandActor {
    userId: string;
    sourceSessionId: string;
    originId: string;
    correlationId?: string;
    hops?: number;
    triggerMessageId?: string | undefined;
    contextBefore?: number;
}
export type SessionCommand = typeof sessionCommands.$inferSelect;
type DirectDeliveryAddress = Pick<typeof directRecipients.$inferSelect, "channelId" | "idType" | "recipientId" | "claimId">;
export interface CommandPayload {
    group?: GroupCreation;
    invitation?: GroupInvitation;
    taskId?: string;
    content: string;
    reply?: ReplyDocument;
    mentionBotUserId?: string;
    purpose?: "progress" | "answer" | "notification";
    contextRefs?: string[];
    contextMessageIds?: string[];
}
export type SessionCommandKind = "message.send" | "session.invoke" | "task.run" | "group.create" | "group.invite";
export interface CommandRuntimeOptions {
    db: DrizzleDB;
    channelFor: (id: string) => ReplyChannel | undefined;
    executeTrigger?: (command: SessionCommand, signal: AbortSignal) => Promise<void>;
    executeTaskRun?: (command: SessionCommand, signal: AbortSignal) => Promise<{ taskId: string; runId: string }>;
    /** Forgetting, reflection and consolidation of Agent memory (plus proactivity routines); unset leaves background routines off. */
    memory?: MemoryMaintenanceSettings | (() => MemoryMaintenanceSettings);
    extraRoutines?: readonly SelfRoutine<any>[];
}
/** Durable command acceptance and source-independent delivery/execution lifecycle. */
export class SessionCommandService {
    private timer?: ReturnType<typeof setInterval>;
    private ticking: Promise<void> | undefined;
    private readonly inFlight = new Map<string, Promise<void>>();
    private readonly running = new Map<string, AbortController>();
    private stopped = false;
    private memoryScannedAt = 0;
    private readonly deliveryDispatcher = new SessionDispatcher();
    constructor(readonly options: CommandRuntimeOptions) { }
    private mentionAddress(target: typeof sessions.$inferSelect, userId: string, botOnly = false): string {
        const db = this.options.db;
        if (!target.binding_id || !target.group_id || target.channel_type !== "feishu" ||
            (botOnly && !isGroupChannelSurface(db, target.channel_id, target.group_id, target.channel_type))) {
            throw new GatewayError(
                botOnly ? "bot_mention_group_required" : "mention_channel_unsupported",
                botOnly ? "Bot mentions require a Feishu group conversation" : "Inline mentions require a bound Feishu conversation",
                400,
            );
        }
        if (userId === new SessionStore(db).requireReplyUserId(target.id))
            throw new GatewayError("bot_mention_self", "A bot cannot mention itself", 400);
        const identities = db.select({ providerIds: channelIdentities.providerIdsJson }).from(channelUserBindings)
            .innerJoin(channelIdentities, eq(channelIdentities.id, channelUserBindings.channelIdentityId))
            .innerJoin(users, eq(users.id, channelUserBindings.userId))
            .where(and(eq(users.id, userId), eq(users.status, "active"),
                eq(channelIdentities.channelId, target.channel_id), eq(channelIdentities.channelType, target.channel_type),
                botOnly ? eq(channelIdentities.identityKind, "bot") : sql`${channelIdentities.identityKind} IN ('user', 'bot')`)).all();
        const addresses = [...new Set(identities.map(row => JSON.parse(row.providerIds ?? "{}").open_id)
            .filter((id): id is string => typeof id === "string" && /^ou_[\w-]+$/.test(id)))];
        if (addresses.length !== 1 || !addresses[0])
            throw new GatewayError(botOnly ? "bot_mention_unresolved" : "mention_unresolved", "Mention target has no unique address in this channel", 409);
        return addresses[0];
    }
    authorize(actor: CommandActor, targetId: string, capability: string, refs: readonly string[] = [], _now = Date.now(), taskId?: string) {
        const db = this.options.db;
        const target = db.select().from(sessions).where(eq(sessions.id, targetId)).get();
        if (!target || target.status !== "active")
            throw new GatewayError("session_unavailable", "Target session is unavailable", 404);
        const scopes=new TaskScopeResolver(db),scope=scopes.session(actor.sourceSessionId);
        scopes.assertSame(scope,scopes.session(targetId));
        if (capability === "task.run" || taskId !== undefined) {
            if (!taskId?.trim())
                throw new GatewayError("invalid_task_schedule", "task.run requires taskId", 400);
            const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
            if (!task)
                throw new GatewayError("task_not_found", "Task not found", 404);
            scopes.assertSame(scope, scopes.task(task.id));
        }
        new AgentStore(db).requireAccess(actor.userId,scope.agentId);
        new SessionStore(db).requireReplyUserId(actor.sourceSessionId);
        new SessionStore(db).requireReplyUserId(targetId);
        const user = db.select().from(users).where(eq(users.id, actor.userId)).get();
        if (!user || user.status !== "active")
            throw new GatewayError("actor_inactive", "Actor is inactive", 403);
        for (const id of refs) {
            const artifact = db.select().from(managedArtifacts).where(eq(managedArtifacts.id, id)).get();
            if (!artifact || artifact.status !== "active" || artifact.deleted_at !== null)
                throw new GatewayError("artifact_unavailable", "Artifact unavailable", 403);
            scopes.assertSame(scope,new ContextPackScope(db).owner(artifact.scope_type,artifact.scope_id));

        }
        return target;
    }
    accept(actor: CommandActor, targetId: string, kind: SessionCommandKind, key: string, payload: CommandPayload, timing: {
        availableAt?: number;
        expiresAt?: number;
    } = {}): SessionCommand {
        const db = this.options.db;
        if (!key || key.length > 128 || !payload.content.trim() || payload.content.length > 100000)
            throw new GatewayError("invalid_command", "Invalid command key or content", 400);
        if (kind === "session.invoke" && (actor.hops ?? 3) <= 0)
            throw new GatewayError("hop_limit", "Trigger hop limit reached", 409);
        const taskId = kind === "task.run" ? payload.taskId?.trim() : undefined;
        if (kind === "task.run" && !taskId)
            throw new GatewayError("invalid_task_schedule", "task.run requires taskId", 400);
        const reply = payload.reply ? parseReply(JSON.stringify(payload.reply)) : undefined;
        if (reply) {
            payload = { ...payload, reply, content: replyMarkdown(reply) };
            for (const block of reply.content) {
                if (block.type !== "image") continue;
                const artifact = db.select().from(managedArtifacts).where(eq(managedArtifacts.id, block.artifactRef.slice(9))).get();
                if (!artifact || artifact.status !== "active" || artifact.deleted_at !== null || !artifact.mime_type?.startsWith("image/"))
                    throw new GatewayError("image_artifact_unavailable", "Image must reference an active image Artifact", 400);
            }
        }
        if (!payload.content.trim() || payload.content.length > 100000) throw new GatewayError("invalid_command", "Reply is too large or empty", 400);
        const refs = [...new Set([...scanArtifactRefs(payload.content), ...(payload.contextRefs ?? [])])].sort();
        const invitation = kind === "group.invite" ? groupInvitationSchema.parse(payload.invitation) : undefined;
        const group = kind === "group.create" ? groupCreationSchema.parse(payload.group) : undefined;
        if (group && targetId !== actor.sourceSessionId) throw new GatewayError("invalid_group_source", "Group commands belong to their source session", 400);
        const contextMessageIds = groupContextMessageIdsSchema.parse(payload.contextMessageIds ?? []);
        if (contextMessageIds.length && kind !== "group.create") throw new GatewayError("invalid_group_context", "Message context belongs to group creation", 400);
        const target = this.authorize(actor, targetId, kind, refs, Date.now(), taskId);
        const mentionBotUserId = payload.mentionBotUserId;
        if (mentionBotUserId) {
            if (kind !== "message.send" || targetId !== actor.sourceSessionId || reply)
                throw new GatewayError("invalid_bot_mention", "Use a text message in the current session to mention a bot", 400);
            this.mentionAddress(target, mentionBotUserId, true);
        }
        for (const block of reply?.content ?? []) {
            if (block.type !== "mention") continue;
            if (kind !== "message.send" || targetId !== actor.sourceSessionId || reply?.presentation !== "message")
                throw new GatewayError("invalid_mention", "Inline mentions require message presentation in the current group", 400);
            this.mentionAddress(target, block.userId);
        }
        const canonical = { ...(contextMessageIds.length ? {contextMessageIds} : {}), ...(taskId ? { taskId } : {}), content: payload.content, ...(reply ? { reply } : {}), purpose: payload.purpose ?? "notification", contextRefs: refs, ...(group ? { group } : {}), ...(invitation ? { invitation } : {}), ...(mentionBotUserId ? { mentionBotUserId } : {}) };
        if (group && (target.channel_type !== "feishu" || target.channel_id !== group.channelId))
            throw new GatewayError("channel_forbidden", "Group creation must use the current session's Feishu binding", 403);
        if (invitation && (target.channel_id !== invitation.channelId || target.group_id !== invitation.chatId || target.thread_key)) throw new GatewayError("invalid_group_target", "Invitation must match its authorized group", 403);
        const dedupeKey = `${actor.sourceSessionId}:${actor.originId}:${key}`;
        const preExisting = db.select().from(sessionCommands).where(eq(sessionCommands.dedupeKey, dedupeKey)).get();
        if (preExisting) {
            if (preExisting.kind !== kind || preExisting.sessionId !== targetId || preExisting.actorUserId !== actor.userId || JSON.stringify({ ...(Array.isArray(preExisting.payload.contextMessageIds) && preExisting.payload.contextMessageIds.length ? {contextMessageIds: preExisting.payload.contextMessageIds} : {}), ...(typeof preExisting.payload.taskId === "string" ? { taskId: preExisting.payload.taskId } : {}), content: preExisting.payload.content, ...(preExisting.payload.reply ? { reply: preExisting.payload.reply } : {}), purpose: preExisting.payload.purpose, contextRefs: preExisting.payload.contextRefs, ...(preExisting.payload.group ? { group: preExisting.payload.group } : {}), ...(preExisting.payload.invitation ? { invitation: preExisting.payload.invitation } : {}), ...(preExisting.payload.mentionBotUserId ? { mentionBotUserId: preExisting.payload.mentionBotUserId } : {}) }) !== JSON.stringify(canonical))
                throw new GatewayError("idempotency_conflict", "Key already used with different payload", 409);
            return preExisting;
        }
        const acceptNow = Date.now();
        const governance = kind === "message.send"
            ? evaluateOutboundGovernance(db, {
                target,
                sourceSessionId: actor.sourceSessionId,
                originId: actor.originId,
                purpose: (payload.purpose ?? "notification") as "progress" | "answer" | "notification",
                content: payload.content,
                requestedAvailableAt: timing.availableAt,
                now: acceptNow,
            })
            : { proactive: false, status: "pending" as const, availableAt: timing.availableAt ?? acceptNow };
        return db.transaction(tx => {
            const existing = tx.select().from(sessionCommands).where(eq(sessionCommands.dedupeKey, dedupeKey)).get();
            if (existing) {
                if (existing.kind !== kind || existing.sessionId !== targetId || existing.actorUserId !== actor.userId || JSON.stringify({ ...(Array.isArray(existing.payload.contextMessageIds) && existing.payload.contextMessageIds.length ? {contextMessageIds: existing.payload.contextMessageIds} : {}), ...(typeof existing.payload.taskId === "string" ? { taskId: existing.payload.taskId } : {}), content: existing.payload.content, ...(existing.payload.reply ? { reply: existing.payload.reply } : {}), purpose: existing.payload.purpose, contextRefs: existing.payload.contextRefs, ...(existing.payload.group ? { group: existing.payload.group } : {}), ...(existing.payload.invitation ? { invitation: existing.payload.invitation } : {}), ...(existing.payload.mentionBotUserId ? { mentionBotUserId: existing.payload.mentionBotUserId } : {}) }) !== JSON.stringify(canonical))
                    throw new GatewayError("idempotency_conflict", "Key already used with different payload", 409);
                return existing;
            }
            const launch = group ? selectLaunchMessages(tx as unknown as DrizzleDB, {sourceSessionId: actor.sourceSessionId,
              ...(actor.triggerMessageId ? {anchorMessageId: actor.triggerMessageId} : {}),
              extraMessageIds: contextMessageIds, ...(actor.contextBefore !== undefined ? {before: actor.contextBefore} : {})}) : undefined;
            const id = randomUUID(), now = acceptNow;
            let messageId: string | null = null;
            let directAddress: DirectDeliveryAddress | undefined;
            if (kind === "message.send") {
                const recipient = tx.select().from(directRecipients).where(eq(directRecipients.sessionId, targetId)).get();
                if (recipient && !recipient.surfaceId) {
                    const {channelId, idType, recipientId, claimId} = recipient;
                    directAddress = {channelId, idType, recipientId, claimId};
                    this.requireDirectAddress(target.channel_id, directAddress);
                } else if (!recipient && target.channel_type === "feishu" && target.group_id?.startsWith("recipient:")) {
                    throw new GatewayError("recipient_unresolved", "Resolve this recipient before sending", 409);
                }
                messageId = new MessageStore(tx as unknown as DrizzleDB).appendOnce({ sessionId: targetId, channelMessageKey: `command:${id}`, role: "assistant", content: [{ type: "text", text: payload.content }], ...(reply?.presentation === "card" ? { presentationKind: "rich_markdown" as const } : {}),
                    channel: { type: target.channel_type, id: target.channel_id }, senderUserId: new SessionStore(tx as unknown as DrizzleDB).requireReplyUserId(targetId), rawPayload: { commandId: id, sourceSessionId: actor.sourceSessionId, deliveryStatus: governance.status, ...(reply?.replyTo ? { replyTo: reply.replyTo } : {}) } }).row.id;
            }
            let contextPackId: string | undefined;
            if (kind === "session.invoke") {
                const packs = new ContextPackStore(tx as unknown as DrizzleDB);
                const pack = packs.createPack({ ownerType: "session", ownerId: targetId, kind: "session_trigger", selectionStrategy: "explicit_authorized_refs", createdForInvocationId: id, metadataJson: { instruction: payload.content, sourceSessionId: actor.sourceSessionId } });
                packs.addItems(pack.id, refs.map(artifactId => ({ itemKind: "artifact", itemId: artifactId, sourceSessionId: actor.sourceSessionId, role: "context", reason: "explicit_handoff", metadataJson: { artifactId } })));
                contextPackId = pack.id;
            }
            const rawPayload = payload as unknown as Record<string, unknown>;
            const extraPayload = "requestResult" in rawPayload
                ? { requestResult: rawPayload.requestResult }
                : {};
            tx.insert(sessionCommands).values({ id, kind, sessionId: targetId, sourceSessionId: actor.sourceSessionId, actorUserId: actor.userId,
                originId: actor.originId, dedupeKey, payload: { ...canonical, ...extraPayload, ...(governance.metadata ? { proactiveGovernance: governance.metadata } : {}), ...(directAddress ? {directAddress} : {}), ...(launch ? {launchMessageIds: launch.selected.map(row => row.message.id), launchAnchorMessageId: launch.anchorMessageId} : {}), ...(contextPackId ? { contextPackId } : {}) }, status: governance.status, messageId, correlationId: actor.correlationId ?? id, hops: kind === "session.invoke" ? (actor.hops ?? 3) - 1 : actor.hops ?? 3,
                availableAt: governance.availableAt, expiresAt: timing.expiresAt ?? null, createdAt: now, updatedAt: now }).run();
            return tx.select().from(sessionCommands).where(eq(sessionCommands.id, id)).get()!;
        });
    }
    get(id: string) { return this.options.db.select().from(sessionCommands).where(eq(sessionCommands.id, id)).get(); }
    start() {
        this.stopped = false;
        // An interrupted provider send is ambiguous; interrupted reasoning is not automatically replayed.
        this.options.db.transaction(tx => {
            const interrupted = tx.select().from(sessionCommands).where(eq(sessionCommands.status, "running")).all();
            for (const command of interrupted) {
                const recoverable = command.kind === "session.invoke" && new InvocationStore(this.options.db).findActive({ runnerKind: "main", originId: command.id, sessionId: command.sessionId });
                tx.update(sessionCommands).set({ status: recoverable ? "pending" : "unknown", error: recoverable ? null : "Runtime interrupted execution", claim: null, updatedAt: Date.now() }).where(eq(sessionCommands.id, command.id)).run();
                if (recoverable) continue;
                if (command.messageId) {
                    const replyTo = command.payload.reply && typeof command.payload.reply === "object" && "replyTo" in command.payload.reply && typeof command.payload.reply.replyTo === "string" ? command.payload.reply.replyTo : undefined;
                    tx.update(messages).set({ rawPayloadJson: { commandId: command.id, sourceSessionId: command.sourceSessionId, deliveryStatus: "unknown", ...(replyTo ? { replyTo } : {}) } }).where(eq(messages.id, command.messageId)).run();
                }
                tx.update(scheduleOccurrences).set({ status: "unknown", reason: "Runtime interrupted execution" }).where(eq(scheduleOccurrences.commandId, command.id)).run();
            }
        });
        this.timer = setInterval(() => { void this.tick().catch(error => console.error("session command worker", error)); }, 250);
        this.timer.unref();
    }
    async stop() { this.stopped = true; if (this.timer)
        clearInterval(this.timer); for (const controller of this.running.values())
        controller.abort(); await this.ticking; await Promise.allSettled([...this.inFlight.values()]); }
    tick(now = Date.now()): Promise<void> {
        if (this.ticking)
            return this.ticking;
        this.ticking = this.drain(now).finally(() => { this.ticking = undefined; });
        return this.ticking;
    }
    private async drain(now: number) {
        if (this.stopped)
            return;
        this.materializeSchedules(now);
        releaseDeferredOutboundCommands(this.options.db, now);
        notifyFailedSchedules(this.options.db, this, now);
        if (this.options.memory && now - this.memoryScannedAt >= MEMORY_SCAN_INTERVAL_MS) {
            this.memoryScannedAt = now;
            const memorySettings = typeof this.options.memory === "function" ? this.options.memory() : this.options.memory;
            maintainMemory(this.options.db, this, memorySettings, now, [
                createShadowHeartbeatRoutine(),
                createCorrelatedRequestExpiryRoutine(),
                ...(this.options.extraRoutines ?? []),
            ]);
        }
        const isTriggerKind = (kind: string | undefined) => kind === "session.invoke" || kind === "task.run";
        const pending = this.options.db.select().from(sessionCommands).where(and(eq(sessionCommands.status, "pending"), lte(sessionCommands.availableAt, Math.max(now, Date.now())))).orderBy(asc(sessionCommands.createdAt), sql`session_commands.rowid`).all();
        let triggerSlots = 8 - [...this.inFlight.keys()].filter(id => isTriggerKind(this.get(id)?.kind)).length;
        let deliverySlots = 32 - [...this.inFlight.keys()].filter(id => !isTriggerKind(this.get(id)?.kind)).length;
        for (const command of pending) {
            const triggerLike = isTriggerKind(command.kind);
            if (triggerLike ? triggerSlots <= 0 : deliverySlots <= 0) continue;
            if (this.inFlight.has(command.id))
                continue;
            if (triggerLike) triggerSlots--; else deliverySlots--;
            const execution = this.execute(command, now).catch(error => console.error("command execution", error)).finally(() => this.inFlight.delete(command.id));
            this.inFlight.set(command.id, execution);
        }
    }
    async waitForIdle() { await this.tick(); while (this.inFlight.size) {
        await Promise.allSettled([...this.inFlight.values()]);
        await this.tick();
    } }
    private async execute(command: SessionCommand, now: number) {
        const run = async () => {
            const db = this.options.db;
            const claim = randomUUID();
            const acquired = db.update(sessionCommands).set({ status: "running", claim, attempts: command.attempts + 1, updatedAt: now }).where(and(eq(sessionCommands.id, command.id), eq(sessionCommands.status, "pending"))).returning().get();
            if (!acquired)
                return;
            const controller = new AbortController();
            this.running.set(command.id, controller);
            const finish = (status: string, error: string | null = null, providerMessageId?: string) => {
                db.transaction(tx => {
                    // A Work session runs its trigger on the Work Runner, so its invocation is not Main's.
                    if (command.kind === "session.invoke") new InvocationStore(db).finishOrigin({ originId: command.id, sessionId: command.sessionId }, () => {});
                    tx.update(sessionCommands).set({ status, error, claim: null, updatedAt: Date.now(), ...(providerMessageId ? { providerMessageId } : {}) }).where(and(eq(sessionCommands.id, command.id), eq(sessionCommands.claim, claim))).run();
                    if (command.messageId) {
                        const replyTo = command.payload.reply && typeof command.payload.reply === "object" && "replyTo" in command.payload.reply && typeof command.payload.reply.replyTo === "string" ? command.payload.reply.replyTo : undefined;
                        tx.update(messages).set({ rawPayloadJson: { commandId: command.id, sourceSessionId: command.sourceSessionId, deliveryStatus: status, providerMessageId, ...(replyTo ? { replyTo } : {}) } }).where(eq(messages.id, command.messageId)).run();
                    }
                    tx.update(scheduleOccurrences).set({ status, reason: error }).where(eq(scheduleOccurrences.commandId, command.id)).run();
                });
            };
            let sending = false;
            try {
                if (this.stopped || controller.signal.aborted) {
                    finish("cancelled");
                    return;
                }
                const recovering = command.kind === "session.invoke" && (["main", "work"] as const).some(runnerKind =>
                    new InvocationStore(db).findActive({ runnerKind, originId: command.id, sessionId: command.sessionId }));
                if (!recovering && command.expiresAt !== null && command.expiresAt <= now) {
                    finish("skipped", "Expired");
                    return;
                }
                const target = this.authorize({ userId: command.actorUserId, sourceSessionId: command.sourceSessionId, originId: command.originId }, command.sessionId, command.kind, command.payload.contextRefs as string[] ?? [], now, typeof command.payload.taskId === "string" ? command.payload.taskId : undefined);
                if (command.kind === "session.invoke") {
                    if (!this.options.executeTrigger)
                        throw new Error("Trigger executor unavailable");
                    await this.options.executeTrigger(command, controller.signal);
                    finish(controller.signal.aborted ? "cancelled" : "completed");
                }
                else if (command.kind === "task.run") {
                    if (!this.options.executeTaskRun)
                        throw new Error("Scheduled Task executor unavailable");
                    const result = await this.options.executeTaskRun(command, controller.signal);
                    db.transaction(tx => {
                        tx.update(sessionCommands).set({ payload: { ...command.payload, result } }).where(and(eq(sessionCommands.id, command.id), eq(sessionCommands.claim, claim))).run();
                        finish(controller.signal.aborted ? "cancelled" : "completed");
                    });
                }
                else if (command.kind === "group.invite") {
                    const invitation = groupInvitationSchema.parse(command.payload.invitation);
                    if (target.channel_id !== invitation.channelId || target.group_id !== invitation.chatId || target.thread_key) throw new Error("Invitation target changed");
                    const channel = this.options.channelFor(invitation.channelId);
                    if (!channel?.inviteGroupMembers) throw new Error("Channel invitations unavailable");
                    sending = true;
                    const result = await channel.inviteGroupMembers({ ...invitation, requestId: command.id });
                    db.transaction(tx => {
                        tx.update(sessionCommands).set({ payload: { ...command.payload, result } }).where(and(eq(sessionCommands.id, command.id), eq(sessionCommands.claim, claim))).run();
                        finish(result.invalidMemberIds.length || result.notExistedMemberIds.length ? "partial" : result.pendingApprovalMemberIds.length ? "pending_approval" : "completed");
                    });
                }
                else if (command.kind === "group.create") {
                    const group = groupCreationSchema.parse(command.payload.group);
                    if (target.channel_type !== "feishu" || target.channel_id !== group.channelId)
                        throw new GatewayError("channel_forbidden", "Group creation must use the current session's Feishu binding", 403);
                    const channel = this.options.channelFor(group.channelId);
                    if (!channel?.createGroup) throw new Error("Channel group creation unavailable");
                    const contextMessageIds = (command.payload.launchMessageIds ?? command.payload.contextMessageIds ?? []) as string[];
                    selectGroupLaunchMessages(db, command.sourceSessionId, contextMessageIds);
                    sending = true;
                    const surface = await channel.createGroup({ ...group, requestId: command.id });
                    if (!surface.externalId || surface.kind !== "group") throw new Error("Group creation returned an invalid receipt");
                    db.transaction(tx => {
                        const storeDb = tx as unknown as DrizzleDB;
                        const directory = new ChannelDirectoryStore(storeDb).upsertSurface({ channel: { type: "feishu", id: group.channelId }, surface });
                        const session = new SessionStore(storeDb).resolveByChannelSurface({ channelType: "feishu", channelId: group.channelId, groupId: surface.externalId });
                        bindGroupLaunchContext(storeDb, {sourceSessionId: command.sourceSessionId, targetSessionId: session.id, commandId: command.id, contextMessageIds, anchorMessageId: command.payload.launchAnchorMessageId as string | undefined});
                        tx.update(sessionCommands).set({ payload: { ...command.payload, result: { groupId: directory.id, chatId: surface.externalId, sessionId: session.id } } }).where(and(eq(sessionCommands.id, command.id), eq(sessionCommands.claim, claim))).run();
                        finish("completed");
                    });
                }
                else {
                    const channel = this.options.channelFor(target.channel_id);
                    if (!channel) {
                        if (command.attempts >= 8) {
                            finish("failed", "Channel unavailable after bounded retries");
                            return;
                        }
                        db.update(sessionCommands).set({ status: "pending", claim: null, availableAt: now + Math.min(60000, 1000 * 2 ** Math.min(command.attempts, 6)), updatedAt: now }).where(and(eq(sessionCommands.id, command.id), eq(sessionCommands.claim, claim))).run();
                        return;
                    }
                    const inbound: NormalizedInboundMessage = { id: target.root_message_key ?? `command:${command.id}`, channel: { type: target.channel_type, id: target.channel_id }, surface: { externalId: target.group_id ?? target.channel_id, kind: "unknown" }, sender: { externalId: "luna", kind: "bot" }, text: "", mentions: [], addressing: { addressedToBot: false, reason: "silent_group" }, ...(target.thread_key ? { thread: { externalId: target.thread_key, ...(target.root_message_key ? { rootMessageExternalId: target.root_message_key } : {}) } } : {}) };
                    if (target.thread_key && !target.root_message_key)
                        throw new GatewayError("missing_thread_anchor", "Thread reply requires its root message", 409);
                    const recipient = db.select().from(directRecipients).where(eq(directRecipients.sessionId, target.id)).get();
                    const directAddress = command.payload.directAddress as DirectDeliveryAddress | undefined;
                    if (directAddress) {
                        if (!channel.sendTo) throw new Error("Channel does not support direct recipient delivery");
                        this.requireDirectAddress(target.channel_id, directAddress);
                    } else if ((recipient && !recipient.surfaceId) || (target.channel_type === "feishu" && target.group_id?.startsWith("recipient:"))) {
                        throw new GatewayError("recipient_unresolved", "The command has no verified recipient address", 409);
                    }
                    const mention = typeof command.payload.mentionBotUserId === "string"
                        ? { requesterUserId: this.mentionAddress(target, command.payload.mentionBotUserId, true) }
                        : undefined;
                    const reply: ReplyDocument | undefined = command.payload.reply ? parseReply(JSON.stringify(command.payload.reply))
                        : mention ? { type: "luna.reply", version: 1, presentation: "text", content: [{ type: "text", text: String(command.payload.content) }] } : undefined;
                    const inlineMentions = reply?.content.flatMap(block => block.type === "mention"
                        ? [this.mentionAddress(target, block.userId)] : []) ?? [];
                    // A reply may quote one message of the conversation it is sent to; in a topic thread it already replies in place.
                    const quoted = reply?.replyTo && !target.thread_key
                        ? db.select({ externalId: messages.externalMessageId }).from(messages)
                            .where(and(eq(messages.id, reply.replyTo), eq(messages.ownerSessionId, target.id))).get()?.externalId
                        : undefined;
                    sending = true;
                    const operation = { replyMode: target.thread_key ? "reply_in_thread" as const : "channel_message" as const, sessionId: target.id, ...(target.root_message_key ? { targetMessageId: target.root_message_key } : {}), ...(quoted ? { quoteMessageId: quoted } : {}), idempotencyKey: command.id, content: String(command.payload.content), ...(reply ? { reply } : {}), ...(mention ? { mention } : {}), ...(inlineMentions.length ? { inlineMentions } : {}) };
                    const surfaceId = directAddress ? `recipient:${directAddress.claimId}` : target.group_id ?? target.channel_id;
                    const sent = channel.sendTo ? await channel.sendTo({ channelId: target.channel_id, surfaceId, ...(directAddress ? { recipient: { idType: directAddress.idType, id: directAddress.recipientId } } : {}), ...(target.thread_key ? { threadId: target.thread_key } : {}), ...(target.root_message_key ? { rootMessageId: target.root_message_key } : {}) }, operation) : await channel.send(inbound, operation);
                    if (directAddress) {
                        if (!sent.deliveredSurfaceId) throw new Error("Direct delivery returned no conversation ID");
                        db.transaction(tx => {
                            new SessionStore(tx as unknown as DrizzleDB).bindDirectSurface(target.id, target.channel_id, sent.deliveredSurfaceId!);
                            new ChannelDirectoryStore(tx as unknown as DrizzleDB).upsertSurface({ channel: { type: "feishu", id: target.channel_id }, surface: { externalId: sent.deliveredSurfaceId!, kind: "p2p" } });
                            finish("sent", null, sent.id);
                        });
                    } else finish("sent", null, sent.id);
                    await this.completeReplyProcessing(command);
                }
            }
            catch (error) {
                if (error instanceof RuntimeDetachedError) return;
                finish(error instanceof ProviderDeliveryRejected ? "failed" : sending ? "unknown" : controller.signal.aborted ? "cancelled" : "failed", String(error));
            }
            finally {
                this.running.delete(command.id);
                notifyFailedSchedules(db, this, Date.now());
            }
        };
        if (command.kind === "session.invoke" || command.kind === "task.run")
            await sessionDispatcherFor(this.options.db).dispatch({ kind: "session_trigger", sessionId: command.sessionId }, run);
        else
            await this.deliveryDispatcher.dispatch({kind:"message_delivery",sessionId:command.sessionId},run);
    }
    private requireDirectAddress(channelId: string, address: DirectDeliveryAddress): void {
        const claim = requireFeishuRecipientClaim(this.options.db, channelId, address.idType, address.recipientId);
        if (address.channelId !== channelId || address.claimId !== claim.claimId)
            throw new GatewayError("recipient_unresolved", "The saved recipient scope no longer matches", 409);
    }

    private async completeReplyProcessing(command: SessionCommand): Promise<void> {
        if (command.payload.purpose !== "answer" || command.sourceSessionId !== command.sessionId || this.get(command.id)?.status !== "sent") return;
        // Only the input claimed by this turn has been answered. Later arrivals
        // and contextual messages keep their own processing markers.
        try {
            const rows = this.options.db.select({ message: messages }).from(sessionInbox)
                .innerJoin(messages, eq(messages.id, sessionInbox.message_id))
                .where(and(eq(sessionInbox.session_id, command.sourceSessionId), eq(sessionInbox.turn_id, command.originId), eq(sessionInbox.status, "claimed"), eq(messages.role, "user"))).all();
            const store = new MessageStore(this.options.db);
            await Promise.all(rows.map(async ({ message }) => {
                const channel = this.options.channelFor(message.channelId);
                if (!channel?.completeProcessing) return;
                const row = store.findByExternalMessageId({sessionId:command.sourceSessionId, channelType: message.channelType, channelId: message.channelId, externalMessageId: message.externalMessageId, role: "user" });
                if (row) await completeProcessingOnce(channel, normalizedInboundFromMessageRow(row));
            }));
        } catch (error) {
            // The reply is already delivered. Turn finalization retries marker
            // cleanup; a marker failure must never downgrade or resend the reply.
            console.warn("Failed to clear processing markers after reply", { commandId: command.id, error });
        }
    }
    cancel(id: string) {
        this.running.get(id)?.abort();
        this.options.db.update(sessionCommands).set({ status: "cancelled", updatedAt: Date.now() }).where(and(eq(sessionCommands.id, id), eq(sessionCommands.status, "pending"))).run();
    }
    materializeSchedules(now = Date.now()) {
        const db = this.options.db;
        const due = db.select().from(sessionSchedules).where(and(eq(sessionSchedules.enabled, true), lte(sessionSchedules.nextAt, now))).all();
        for (const schedule of due)
            db.transaction(tx => {
                const current = tx.select().from(sessionSchedules).where(eq(sessionSchedules.id, schedule.id)).get();
                if (!current?.enabled || current.nextAt > now)
                    return;
                const interval = current.intervalMs;
                const calendarAt = current.recurrence ? calendarOccurrence(current.recurrence, current.timezone, now, "previous") : null;
                const missed = calendarAt !== null ? Number(calendarAt > current.nextAt) : interval ? Math.floor((now - current.nextAt) / interval) : 0;
                const scheduledAt = calendarAt ?? (interval ? current.nextAt + missed * interval : current.nextAt);
                const occurrenceId = `${current.id}:${current.revision}:${scheduledAt}`;
                if (missed > 0)
                    tx.insert(scheduleOccurrences).values({ id: `${occurrenceId}:missed`, scheduleId: current.id, scheduledAt: current.nextAt, revision: current.revision, status: "skipped", reason: current.recurrence ? "Coalesced earlier calendar occurrences" : `Coalesced ${missed} missed occurrences`, snapshot: { schedule: current, missedCount: missed }, createdAt: now }).onConflictDoNothing().run();
                const scheduledTaskId = current.action.kind === "task.run" && typeof current.action.taskId === "string" ? current.action.taskId : undefined;
                const activeCommand = tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.scheduleId, current.id)).all().some(o => o.commandId && ["pending", "running"].includes(this.get(o.commandId)?.status ?? ""));
                const activeTaskRun = scheduledTaskId ? new TaskRunStore(tx as unknown as DrizzleDB).getActiveRunForTask(scheduledTaskId) !== undefined : false;
                let reason: string | null = null;
                let acceptFailed = false;
                if ((activeCommand || activeTaskRun) && current.overlap === "skip")
                    reason = activeTaskRun ? "Previous task run is active" : "Previous occurrence is active";
                if ((missed > 0 || now - scheduledAt > current.expiresAfterMs) && current.misfire === "skip")
                    reason = "Missed occurrence";
                let commandId: string | null = null;
                try {
                    if (!reason) {
                        const command = this.accept(
                            { userId: current.actorUserId, sourceSessionId: current.sourceSessionId, originId: occurrenceId },
                            current.targetSessionId,
                            current.action.kind as "message.send" | "session.invoke" | "task.run",
                            "occurrence",
                            {
                                ...(scheduledTaskId ? { taskId: scheduledTaskId } : {}),
                                content: String(current.action.content),
                                purpose: "notification",
                                contextRefs: current.action.contextRefs as string[] ?? [],
                            },
                            { expiresAt: scheduledAt + current.expiresAfterMs },
                        );
                        commandId = command.id;
                    }
                }
                catch (error) {
                    acceptFailed = true;
                    reason = String(error);
                }
                tx.insert(scheduleOccurrences).values({ id: occurrenceId, scheduleId: current.id, scheduledAt, revision: current.revision, commandId, status: acceptFailed ? "failed" : reason ? "skipped" : "pending", reason, snapshot: current, createdAt: now }).onConflictDoNothing().run();
                tx.update(sessionSchedules).set({ nextAt: current.recurrence ? calendarOccurrence(current.recurrence, current.timezone, now) : interval ? scheduledAt + interval : scheduledAt, enabled: !!current.recurrence || interval !== null }).where(eq(sessionSchedules.id, current.id)).run();
            });
    }
}
const runtimes = new WeakMap<DrizzleDB, SessionCommandService>();
export function registerSessionCommands(db: DrizzleDB, service: SessionCommandService) { runtimes.set(db, service); }
export function sessionCommandsFor(db: DrizzleDB, channelFor: (id: string) => ReplyChannel | undefined): SessionCommandService {
    let service = runtimes.get(db);
    if (!service) {
        service = new SessionCommandService({ db, channelFor });
        runtimes.set(db, service);
    }
    return service;
}
