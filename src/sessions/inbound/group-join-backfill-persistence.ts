import type { NormalizedInboundMessage } from "@/channels";
import type { DrizzleDB } from "@/data";
import type { AppendMessageResult } from "@/sessions/message-store";
import { MessageStore } from "@/sessions/message-store";
import type { AppendMessageInput } from "@/sessions/types";

import {
  appendInputFromNormalizedInbound,
} from "./inbound-message-persistence";

export function appendBackfillMessage(input: {
  readonly db: DrizzleDB;
  readonly sessionId: string;
  readonly message: NormalizedInboundMessage;
  readonly importedAt: number;
  readonly joinEventId: string;
  readonly occurredAt?: number;
}): AppendMessageResult {
  const appendInput = backfillAppendInput(input);
  return new MessageStore(input.db).appendOnce({
    ...appendInput,
    ingestMetadata: {
      mode: "history_backfill",
      source: "group_join_backfill",
      importedAt: input.importedAt,
      joinEventId: input.joinEventId,
    },
    ...(input.occurredAt !== undefined ? { createdAt: input.occurredAt } : {}),
  });
}

function backfillAppendInput(input: {
  readonly db: DrizzleDB;
  readonly sessionId: string;
  readonly message: NormalizedInboundMessage;
}): AppendMessageInput {
  return appendInputFromNormalizedInbound(input);
}
