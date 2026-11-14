import { selectLaunchMessages } from "./launch-context-selection";
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { sessions } from "@/data/schema";
import { ContextPackStore } from "@/context";
import { GatewayError } from "@/server/gateway-error";
import type { OperationContext, OperationRequest, OperationResult } from "@/runners/operation-contract";
import { SessionStore } from "./session-store";
import { SessionTimelineStore } from "./session-timeline-store";

type ThreadRequest = Extract<OperationRequest, {kind: "session.create_thread"}>;

/** Provision the topic and its explicit context. The first reply materializes it
 * on Feishu; this command never invents a user-facing message. */
export class ThreadCommandService {
  constructor(private readonly db: DrizzleDB) {}

  prepare(operationId: string, request: ThreadRequest, context: OperationContext): OperationResult {
    const store = new SessionStore(this.db);
    const source = store.getById(context.sessionId);
    if (!source || source.status !== "active")
      throw new GatewayError("session_unavailable", "Source session unavailable", 409);
    const {selected} = selectLaunchMessages(this.db, {sourceSessionId: source.id,
      anchorMessageId: request.payload.anchorMessageId, extraMessageIds: request.payload.contextMessageIds});
    const anchor = selected.find(row => row.message.id === request.payload.anchorMessageId)!.message;
    if (anchor.channelType !== "feishu" || anchor.channelId !== source.channel_id ||
        !anchor.externalMessageId.startsWith("om_") || !source.group_id)
      throw new GatewayError("invalid_thread_anchor", "Use a real Feishu message as the thread anchor", 400);
    const root = source.root_message_key ?? anchor.externalMessageId;
    const target = store.resolveByChannelSurface({
      channelType: anchor.channelType, channelId: anchor.channelId, groupId: source.group_id,
      threadId: source.thread_key ?? root, rootMessageId: root, createThreadLaunchContext: false,
    });
    if (target.status !== "active") throw new GatewayError("session_unavailable", "Target thread is closed", 409);
    if (request.payload.title) this.db.update(sessions).set({title: request.payload.title}).where(eq(sessions.id, target.id)).run();
    const timeline = new SessionTimelineStore(this.db);
    const entries = selected.map(({message}) => timeline.appendReference({sessionId: target.id, messageId: message.id}));
    const packs = new ContextPackStore(this.db);
    const pack = packs.createPack({ownerType: "session", ownerId: target.id, kind: "thread_launch",
      selectionStrategy: "window_with_explicit_context", triggerMessageId: anchor.id, triggerEntryId: entries[selected.findIndex(row => row.message.id === anchor.id)]!.id,
      metadataJson: {operationId, sourceSessionId: source.id, anchorMessageId: anchor.id}});
    packs.addItems(pack.id, selected.map(({message, entry}, index) => ({
      itemKind: "message", itemId: message.id, sourceSessionId: source.id, sourceEntryId: entry.id,
      sourceMessageId: message.id, role: "launch_context",
      reason: message.id === anchor.id ? "thread anchor message" : "Thread launch context", displayOrder: index,
    })));
    return {targetSessionId: target.id};
  }
}
