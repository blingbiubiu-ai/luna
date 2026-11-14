import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { messages, sessionTimelineEntries } from "@/data/schema";
import { ContextPackStore } from "@/context/context-pack-store";
import { GatewayError } from "@/server/gateway-error";
import { SessionTimelineStore } from "./session-timeline-store";

/** Group creation selects source messages; handoff only requests execution. */
export function selectGroupLaunchMessages(db: DrizzleDB, sourceSessionId: string, messageIds: readonly string[]) {
  return messageIds.map(messageId => {
    const row = db.select({message: messages, entry: sessionTimelineEntries})
      .from(sessionTimelineEntries).innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
      .where(and(eq(sessionTimelineEntries.sessionId, sourceSessionId), eq(messages.id, messageId), isNull(messages.deletedAt))).get();
    if (!row) throw new GatewayError("invalid_group_context", "Group context must contain visible messages from the current session", 403);
    return row;
  });
}

export function bindGroupLaunchContext(db: DrizzleDB, input: {
  sourceSessionId: string; targetSessionId: string; commandId: string; anchorMessageId?: string | undefined; contextMessageIds: readonly string[];
}) {
  const selected = selectGroupLaunchMessages(db, input.sourceSessionId, input.contextMessageIds);
  if (!selected.length) return;
  const packs = new ContextPackStore(db);
  const existing = packs.listPacksForOwner("session", input.targetSessionId)
    .find(pack => pack.kind === "group_launch" && pack.createdForInvocationId === input.commandId);
  if (existing) return;
  const timeline = new SessionTimelineStore(db);
  const entries = selected.map(({message}) => timeline.appendReference({sessionId: input.targetSessionId, messageId: message.id}));
  const anchorIndex = Math.max(0, selected.findIndex(row => row.message.id === input.anchorMessageId));
  const pack = packs.createPack({ownerType: "session", ownerId: input.targetSessionId, kind: "group_launch",
    selectionStrategy: "window_with_explicit_context", createdForInvocationId: input.commandId,
    triggerMessageId: selected[anchorIndex]!.message.id, triggerEntryId: entries[anchorIndex]!.id,
    metadataJson: {commandId: input.commandId, sourceSessionId: input.sourceSessionId}});
  packs.addItems(pack.id, selected.map(({message, entry}, index) => ({
    itemKind: "message", itemId: message.id, sourceSessionId: input.sourceSessionId,
    sourceEntryId: entry.id, sourceMessageId: message.id, role: "launch_context",
    reason: message.id === input.anchorMessageId ? "group creation trigger" : "Group launch context", displayOrder: index,
  })));
}
