import type { NormalizedInboundMessage } from "./types";

export function normalizedRootMessageExternalId(
  message: NormalizedInboundMessage,
): string | undefined {
  return (
    message.thread?.rootMessageExternalId ??
    stringField(asRecord(message.rawPayload), "rootMessageId") ??
    stringField(asRecord(asRecord(message.rawPayload)?.message), "root_id") ??
    stringField(asRecord(asRecord(message.rawPayload)?.message), "parent_id")
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}
