import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { AgentError } from "@/agents/agent-store";
import { messages, sessionTimelineEntries, sessionChannelDeliveries, sessionReplyDispatches, users } from "@/data/schema";
import type { NormalizedInboundMessage } from "@/channels";
import type { DeliveryTarget, OutboundChannelOperation, ReplyChannel } from "@/channels/outbound";
import { SessionStore } from "@/sessions/session-store";
import { bindSessionBot } from "@/channels/session-bot";
import { renderLocalUserMentions } from "./reply-text";

type Operation = Omit<OutboundChannelOperation, "id" | "channelId">;
const active = new WeakMap<DrizzleDB, Map<string, Promise<OutboundChannelOperation>>>();

/** One logical reply, independently durable deliveries to all bound channel surfaces. */
export class SessionReplyDispatcher {
  constructor(private readonly db: DrizzleDB, private readonly channelFor: (id: string) => ReplyChannel | undefined) {}

  prepare(sessionId: string): void {
    const store = new SessionStore(this.db);
    store.requireReplyUserId(sessionId);
    const bindings = store.channelBindings(sessionId);
    for (const binding of bindings) {
      bindSessionBot(this.db, sessionId, { type: binding.channelType, id: binding.channelId }, this.channelFor(binding.channelId)?.getBotIdentity?.());
    }

  }

  channel(id: string): ReplyChannel | undefined {
    const adapter = this.channelFor(id);
    if (!adapter) return undefined;
    return new Proxy(adapter, { get: (target, property) => {
      if (property === "send") return (inbound: NormalizedInboundMessage, operation: Operation) => operation.sessionId
        ? this.send(inbound, operation) : target.send(inbound, operation);
      if (property === "sendTo" && target.sendTo) return (destination: DeliveryTarget, operation: Operation) => {
        if (!operation.sessionId) return target.sendTo!(destination, operation);
        const session = new SessionStore(this.db).getById(operation.sessionId)!;
        return this.send({ id: destination.rootMessageId ?? `command:${operation.idempotencyKey}`, channel: { type: session.channel_type, id },
          surface: { externalId: destination.surfaceId, kind: "unknown" }, sender: { kind: "bot", externalId: session.bot_user_id ?? "luna" },
          text: "", mentions: [], addressing: { addressedToBot: false, reason: "silent_group" },
        }, operation, destination);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }

  async send(inbound: NormalizedInboundMessage, operation: Operation, directTarget?: DeliveryTarget): Promise<OutboundChannelOperation> {
    const sessionId = operation.sessionId!;
    const key = JSON.stringify([sessionId, operation.idempotencyKey ?? crypto.randomUUID()]);
    const locks = active.get(this.db) ?? new Map<string, Promise<OutboundChannelOperation>>();
    active.set(this.db, locks);
    // Reject conflicting payloads even while another caller is delivering the first payload.
    const signature = JSON.stringify({ content: operation.content, ...(operation.reply ? { reply: operation.reply } : {}), replyMode: operation.replyMode,
      targetMessageId: operation.targetMessageId, statusCard: operation.statusCard, statusCardSteps: operation.statusCardSteps,
      ...(operation.statusCardStyle === "native" ? {statusCardStyle: operation.statusCardStyle, nativeProgress: operation.nativeProgress} : {}),
      progressUpdate:operation.progressUpdate,
      statusCardState: operation.statusCardState, taskResultCard: operation.taskResultCard, batchSummaryCard: operation.batchSummaryCard,
      mention: operation.mention, inlineMentions: operation.inlineMentions, directTarget });
    const existing = this.db.select().from(sessionReplyDispatches).where(eq(sessionReplyDispatches.idempotencyKey, key)).get();
    if (existing && existing.signature !== signature) throw new Error("Reply idempotency conflict");
    const pending = locks.get(key);
    if (pending) return pending;
    const promise = this.dispatch(key, signature, inbound, operation, directTarget).finally(() => locks.delete(key));
    locks.set(key, promise);
    return promise;
  }

  private async dispatch(key: string, signature: string, inbound: NormalizedInboundMessage, operation: Operation, directTarget?: DeliveryTarget): Promise<OutboundChannelOperation> {
    const store = new SessionStore(this.db);
    const sessionId = operation.sessionId!;
    const session = store.getById(sessionId);
    if (!session || session.status !== "active") throw new Error("Session is unavailable");
    if (directTarget && (directTarget.channelId !== session.channel_id || inbound.channel.id !== directTarget.channelId)) {
      throw new AgentError("session_binding_mismatch", 409);
    }
    this.prepare(sessionId);
    let dispatch = this.db.select().from(sessionReplyDispatches).where(eq(sessionReplyDispatches.idempotencyKey, key)).get();
    if (dispatch?.receipt) return dispatch.receipt;
    const userId = inbound.sender.requesterIdentity?.canonicalUserId ?? inbound.sender.externalId;
    const user = this.db.select().from(users).where(eq(users.id,userId)).get();
    const content = renderLocalUserMentions(operation.content, user);
    if (!dispatch) {
      const id = `session-reply:${crypto.randomUUID()}`;
      const bindings = store.channelBindings(sessionId);
      const previous = operation.replyMode === "update_status_card" && operation.targetMessageId
        ? this.db.select().from(sessionChannelDeliveries).all().filter(row => row.receipt && (row.receipt.id === operation.targetMessageId || row.dispatchId === operation.targetMessageId)) : [];
      const priorDispatchId = previous[0]?.dispatchId;
      const prior = priorDispatchId ? this.db.select().from(sessionChannelDeliveries).where(eq(sessionChannelDeliveries.dispatchId,priorDispatchId)).all() : [];
      const plans = bindings.filter(binding => !operation.inlineMentions || binding.channelId === inbound.channel.id).map(binding => {
        const sameSource = binding.channelId === inbound.channel.id;
        const latest = this.db.select({ id: messages.externalMessageId }).from(sessionTimelineEntries)
          .innerJoin(messages, eq(messages.id,sessionTimelineEntries.messageId))
          .where(and(eq(sessionTimelineEntries.sessionId,sessionId),eq(messages.channelId,binding.channelId),eq(messages.role,"user")))
          .orderBy(desc(messages.occurredAt)).all().find(row => !row.id.startsWith("trigger:"));
        const anchor = binding.rootMessageId ?? (sameSource ? inbound.id : latest?.id);
        if (binding.threadId && !binding.rootMessageId) throw new Error("Bound thread has no root message");
        const priorReceipt = prior.find(row => row.channelId === binding.channelId)?.receipt;
        const target = operation.replyMode === "update_status_card"
          ? priorReceipt?.id ?? (sameSource ? operation.targetMessageId : undefined)
          : (sameSource ? operation.targetMessageId : undefined) ?? anchor ?? binding.surfaceId;
        if (!target) throw new Error("Missing channel-specific status card target");
        const { thread: _thread, ...source } = inbound;
        const normalized: NormalizedInboundMessage = { ...source, id: anchor ?? binding.surfaceId,
          channel: { type: binding.channelType, id: binding.channelId }, surface: { externalId: binding.surfaceId, kind: binding.threadId ? "thread" : "group" },
          ...(binding.threadId ? { thread: { externalId: binding.threadId, rootMessageExternalId: binding.rootMessageId! } } : {}),
        };
        const { mention, assetBasePath: _assets, ...payload } = operation;
        const outgoing: Operation = { ...payload, content, targetMessageId: target,
          ...(sameSource && user?.profileSource !== "dashboard" && mention ? { mention } : {}),
          idempotencyKey: JSON.stringify(["session-delivery",id,binding.id]),
          replyMode: operation.replyMode === "update_status_card" ? operation.replyMode : binding.threadId || (operation.replyMode === "reply_in_thread" && anchor) ? "reply_in_thread" : operation.replyMode === "direct_message" ? "direct_message" : "channel_message",
        };
        return { id: crypto.randomUUID(), dispatchId:id,bindingId:binding.id,channelId:binding.channelId,inbound:normalized,operation:outgoing,status:"pending",updatedAt:Date.now() };
      });
      this.db.transaction(tx => {
        tx.insert(sessionReplyDispatches).values({id,sessionId,idempotencyKey:key,signature,createdAt:Date.now()}).run();
        for (const plan of plans) tx.insert(sessionChannelDeliveries).values(plan).run();
      });
      dispatch = this.db.select().from(sessionReplyDispatches).where(eq(sessionReplyDispatches.id,id)).get()!;
    }
    const errors: unknown[] = [];
    for (const delivery of this.db.select().from(sessionChannelDeliveries).where(eq(sessionChannelDeliveries.dispatchId,dispatch.id)).all()) {
      if (delivery.status === "sent" || delivery.status === "skipped") continue;
      if (delivery.status === "sending" && Date.now() - delivery.updatedAt < 60_000) { errors.push(new Error("Channel delivery in flight")); continue; }
      this.db.update(sessionChannelDeliveries).set({status:"sending",error:null,updatedAt:Date.now()}).where(eq(sessionChannelDeliveries.id,delivery.id)).run();
      try {
        const adapter = this.channelFor(delivery.channelId);
        if (!adapter) throw new Error(`Bound channel unavailable: ${delivery.channelId}`);
        const payload = { ...delivery.operation, ...(operation.assetBasePath ? {assetBasePath:operation.assetBasePath} : {}) };
        const destination = directTarget?.channelId === delivery.channelId ? directTarget : undefined;
        const receipt = destination && adapter.sendTo ? await adapter.sendTo(destination,payload) : await adapter.send(delivery.inbound,payload);
        const {assetBasePath:_assets,...persistable} = receipt;
        this.db.update(sessionChannelDeliveries).set({status:"sent",receipt:persistable,updatedAt:Date.now()}).where(eq(sessionChannelDeliveries.id,delivery.id)).run();
      } catch (error) {
        this.db.update(sessionChannelDeliveries).set({status:"failed",error:String(error),updatedAt:Date.now()}).where(eq(sessionChannelDeliveries.id,delivery.id)).run();
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors,`Session reply delivery failed: ${errors.map(String).join("; ")}`);
    const delivered = this.db.select().from(sessionChannelDeliveries).where(eq(sessionChannelDeliveries.dispatchId,dispatch.id)).all();
    const threaded = operation.replyMode !== "update_status_card" ? delivered.filter(row => row.receipt?.threadId && row.receipt?.rootMessageId) : [];
    let outputSessionId = sessionId;
    if (threaded.length) {
      const first = threaded[0]!;
      outputSessionId = store.resolveByChannelSurface({channelType:first.inbound.channel.type,channelId:first.channelId,groupId:first.inbound.surface.externalId,threadId:first.receipt!.threadId!,rootMessageId:first.receipt!.rootMessageId!}).id;
      const botId = store.getById(sessionId)?.bot_user_id;
      if (botId) store.bindBotUser(outputSessionId,botId);
      for (const row of delivered) {
        const surface = this.channelFor(row.channelId)?.getSessionSurface?.(outputSessionId);
        if (row.receipt?.threadId && row.receipt.rootMessageId) {
          store.bindChannelSurface(outputSessionId,{channelType:row.inbound.channel.type,channelId:row.channelId,groupId:row.inbound.surface.externalId,threadId:row.receipt.threadId,rootMessageId:row.receipt.rootMessageId});
        } else if (surface) {
          store.bindChannelSurface(outputSessionId,{channelType:row.inbound.channel.type,channelId:row.channelId,groupId:surface.externalId});
        }
      }
    }
    const sourceReceipt = delivered.find(row => row.channelId === inbound.channel.id)?.receipt;
    const {assetBasePath:_assets,...payload} = operation;
    const receipt: OutboundChannelOperation = { ...payload, content, id: operation.replyMode === "update_status_card" ? operation.targetMessageId! : dispatch.id,
      channelId:inbound.channel.id,resolvedSessionId:outputSessionId,
      ...(sourceReceipt?.progressSnapshot?{progressSnapshot:sourceReceipt.progressSnapshot,statusCardSteps:sourceReceipt.statusCardSteps}:{}),
      ...(sourceReceipt?.deliveredSurfaceId ? {deliveredSurfaceId:sourceReceipt.deliveredSurfaceId} : {}) };
    this.db.update(sessionReplyDispatches).set({receipt}).where(eq(sessionReplyDispatches.id,dispatch.id)).run();
    return receipt;
  }
}
