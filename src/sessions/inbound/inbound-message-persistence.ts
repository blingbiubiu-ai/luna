import { artifactizeLocalFileReferencesInValue } from "@/artifacts/local-file-artifactizer";
import { TaskScopeResolver } from "@/agents/task-scope";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import type { NormalizedInboundMessage } from "@/channels/types";
import type { DrizzleDB } from "@/data";
import { channelUserBindings } from "@/data/schema";
import {
  canonicalUserIdForRequestedIdentity,
  requestedIdentityFromInbound,
} from "@/identity/requested-identity";
import type { AppendMessageInput } from "@/sessions/types";
import { eq } from "drizzle-orm";

export function appendInputFromNormalizedInbound(input: {
  readonly db: DrizzleDB;
  readonly sessionId: string;
  readonly message: NormalizedInboundMessage;
}): AppendMessageInput {
  const renderedText = renderNormalizedMentions(
    input.message.text,
    input.message.mentions,
  );
  const renderedMessage = {
    ...input.message,
    text: renderedText,
  };
  const senderUserId = resolveInboundSenderUserId({
    db: input.db,
    agentId: new TaskScopeResolver(input.db).session(input.sessionId).agentId,
    message: renderedMessage,
  });
  return {
    sessionId: input.sessionId,
    channelMessageKey: renderedMessage.id,
    senderUserId,
    role: "user",
    channel: renderedMessage.channel,
    surface: renderedMessage.surface,
    sender: renderedMessage.sender,
    ...(renderedMessage.relatedIdentities !== undefined
      ? { relatedIdentities: renderedMessage.relatedIdentities }
      : {}),
    content: renderedMessage.contentBlocks ?? { text: renderedText },
    ...(renderedMessage.contentKind !== undefined
      ? { contentKind: renderedMessage.contentKind }
      : {}),
    ...(renderedMessage.presentationKind !== undefined
      ? { presentationKind: renderedMessage.presentationKind }
      : {}),
    ...(renderedMessage.providerMessageType !== undefined
      ? { providerMessageType: renderedMessage.providerMessageType }
      : {}),
    rawPayload: normalizedMessageStoragePayload(renderedMessage),
    mentions: renderedMessage.mentions,
    inbound: renderedMessage,
  };
}

export function artifactizeInboundMessageResources(input: {
  readonly db: DrizzleDB;
  readonly sessionId: string;
  readonly message: NormalizedInboundMessage;
}): NormalizedInboundMessage {
  const relatedUserId = canonicalUserIdForRequestedIdentity(
    input.db,
    new TaskScopeResolver(input.db).session(input.sessionId).agentId,
    requestedIdentityFromInbound(input.message),
  ) ?? input.message.sender.externalId;
  return artifactizeLocalFileReferencesInValue({
    db: input.db,
    value: input.message,
    scopeType: "session",
    scopeId: input.sessionId,
    relatedUserId,
    producer: input.message.channel.type,
  });
}

export function renderNormalizedMentions(
  text: string,
  mentions: NormalizedInboundMessage["mentions"],
): string {
  const mentionByKey = new Map<string, string>();
  for (const mention of mentions) {
    if (mention.key.length > 0 && !mentionByKey.has(mention.key)) {
      mentionByKey.set(mention.key, mention.label);
    }
  }
  const keys = [...mentionByKey.keys()].sort(
    (left, right) => right.length - left.length,
  );
  if (keys.length === 0 || text.length === 0) {
    return text;
  }

  let rendered = "";
  let offset = 0;
  while (offset < text.length) {
    const key = keys.find((candidate) => text.startsWith(candidate, offset));
    if (key === undefined) {
      rendered += text[offset] ?? "";
      offset += 1;
      continue;
    }
    rendered += mentionByKey.get(key) ?? key;
    offset += key.length;
  }
  return rendered;
}

function normalizedMessageStoragePayload(
  message: NormalizedInboundMessage,
): NormalizedInboundMessage {
  return message.presentation === undefined
    ? message
    : {
        ...message,
        presentation: message.presentation,
      };
}

/** The sender as a user of `agentId`, the Agent whose session or bot received the message. */
export function resolveInboundSenderUserId(input: {
  readonly db: DrizzleDB;
  readonly agentId: string;
  readonly message: NormalizedInboundMessage;
}): string {
  const persistedIdentity = new ChannelDirectoryStore(input.db).upsertIdentity({
    channel: input.message.channel,
    identity: input.message.sender,
    agentId: input.agentId,
  });
  const requestedIdentity = requestedIdentityFromInbound(input.message);
  const requestedUserId = canonicalUserIdForRequestedIdentity(
    input.db,
    input.agentId,
    requestedIdentity,
  );
  if (requestedUserId !== undefined) {
    return requestedUserId;
  }
  const linkedUserId = input.db
    .select({ userId: channelUserBindings.userId })
    .from(channelUserBindings)
    .where(eq(channelUserBindings.channelIdentityId, persistedIdentity.id))
    .get()?.userId;
  if (linkedUserId !== undefined) {
    return linkedUserId;
  }
  throw new Error(
    `Inbound sender could not be resolved to a canonical Luna user: ${input.message.sender.externalId}`,
  );
}
