import type { NormalizedInboundMessage } from "@/channels";
import type { InboundAddressing } from "@/sessions/types";
import { textStartsWithLeadingAlias } from "@/sessions/addressing-utils";
import type { SessionConfig } from "@/shared";

export function decideInboundAddressing(input: {
  readonly message: NormalizedInboundMessage;
  readonly config: SessionConfig;
  readonly repliesToBotMessage: boolean;
}): InboundAddressing {
  const { message } = input;
  if (message.sender.kind === "bot") {
    return message.surface.kind === "group" && message.addressing?.reason === "mention" && message.addressing.addressedToBot
      ? message.addressing
      : { addressedToBot: false, reason: "silent_group" };
  }
  if (message.surface.kind === "p2p") {
    return { addressedToBot: true, reason: "p2p" };
  }

  if (message.surface.kind !== "group") {
    return message.addressing ?? { addressedToBot: true, reason: "p2p" };
  }

  if (message.addressing?.addressedToBot === true) {
    return message.addressing;
  }

  if (input.repliesToBotMessage) {
    return { addressedToBot: true, reason: "reply_to_bot" };
  }

  if (textStartsWithLeadingAlias(message.text, input.config.group_bot_aliases)) {
    return { addressedToBot: true, reason: "alias" };
  }

  return { addressedToBot: false, reason: "silent_group" };
}

export { textStartsWithLeadingAlias };
