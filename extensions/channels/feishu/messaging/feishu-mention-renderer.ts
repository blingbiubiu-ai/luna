import type { ChannelMention } from "@/channels/types";

// Feishu sends mention tokens in text; Luna stores rendered labels instead.
export function renderFeishuMentions(
  text: string,
  mentions: readonly ChannelMention[],
): string {
  return renderFeishuMentionsWithKeys(text, mentions).text;
}

export function renderFeishuMentionsWithKeys(
  text: string,
  mentions: readonly ChannelMention[],
): {
  readonly text: string;
  readonly renderedMentionKeys: readonly string[];
} {
  const mentionByKey = new Map<string, ChannelMention>();
  for (const mention of mentions) {
    if (mention.key.length > 0 && !mentionByKey.has(mention.key)) {
      mentionByKey.set(mention.key, mention);
    }
  }

  const keys = [...mentionByKey.keys()].sort(
    (left, right) => right.length - left.length,
  );
  if (keys.length === 0 || text.length === 0) {
    return { text, renderedMentionKeys: [] };
  }

  let rendered = "";
  const renderedMentionKeys: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const key = keys.find((candidate) => text.startsWith(candidate, offset));
    if (key === undefined) {
      rendered += text[offset] ?? "";
      offset += 1;
      continue;
    }
    rendered += mentionByKey.get(key)?.label ?? key;
    renderedMentionKeys.push(key);
    offset += key.length;
  }
  return { text: rendered, renderedMentionKeys };
}

export function toMentionLabel(
  name: string | undefined,
  fallbackExternalId: string,
): string {
  const display = name?.trim() || fallbackExternalId;
  return display.startsWith("@") ? display : `@${display}`;
}
