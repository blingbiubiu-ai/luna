import { and, asc, eq, isNull } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { messages, sessionTimelineEntries } from "@/data/schema";
import { GatewayError } from "@/server/gateway-error";

/** Freeze the old default window (trigger + four preceding messages) at creation. */
export function selectLaunchMessages(db: DrizzleDB, input: {
  sourceSessionId: string; anchorMessageId?: string; extraMessageIds: readonly string[]; before?: number;
}) {
  const visible = db.select({message: messages, entry: sessionTimelineEntries})
    .from(sessionTimelineEntries).innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .where(and(eq(sessionTimelineEntries.sessionId, input.sourceSessionId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.occurredAt), asc(sessionTimelineEntries.createdAt), asc(sessionTimelineEntries.id)).all();
  const byId = new Map(visible.map(row => [row.message.id, row]));
  const requireMessage = (id: string) => {
    const row = byId.get(id);
    if (!row) throw new GatewayError("invalid_launch_context", "Launch context must contain visible messages from the current session", 403);
    return row;
  };
  const extras = input.extraMessageIds.map(requireMessage);
  const candidates = visible.filter(({entry, message}) => {
    const raw = message.rawPayloadJson as Record<string, unknown> | null;
    return (input.anchorMessageId !== undefined || input.before === undefined || entry.createdAt <= input.before) &&
      (!raw?.deliveryStatus || raw.deliveryStatus === "sent") &&
      raw?.origin !== "runner_operation" && raw?.origin !== "session_trigger";
  });
  const anchor = input.anchorMessageId ? requireMessage(input.anchorMessageId) : candidates.at(-1);
  const index = anchor ? candidates.findIndex(row => row.message.id === anchor.message.id) : -1;
  const window = index >= 0 ? candidates.slice(Math.max(0, index - 4), index + 1) : anchor ? [anchor] : [];
  const selected = [...new Map([...window, ...extras].map(row => [row.message.id, row])).values()];
  return {selected, anchorMessageId: anchor?.message.id};
}
