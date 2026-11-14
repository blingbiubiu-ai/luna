import type {
  AppendMessageInput,
  MessageContentBlock,
  MessageContentKind,
  MessagePresentationKind,
} from "./types";

export interface NormalizedStoredMessageContent {
  readonly blocks: MessageContentBlock[];
  readonly contentKind: MessageContentKind;
  readonly presentationKind: MessagePresentationKind;
}

export function normalizeMessageContent(
  content: AppendMessageInput["content"],
): NormalizedStoredMessageContent {
  const blocks: MessageContentBlock[] = [];
  if (Array.isArray(content)) {
    blocks.push(...content);
  } else {
    const textContent = content as { readonly text: string };
    blocks.push({ type: "text", text: textContent.text });
  }

  return {
    blocks,
    ...classifyMessageContent(blocks),
  };
}

function classifyMessageContent(
  blocks: readonly MessageContentBlock[],
): {
  readonly contentKind: MessageContentKind;
  readonly presentationKind: MessagePresentationKind;
} {
  if (blocks.length === 0) {
    return { contentKind: "unknown", presentationKind: "unknown" };
  }

  const card = blocks.find((block) => block.type === "card");
  if (card !== undefined) {
    return {
      contentKind: "card",
      presentationKind: card.presentationKind ?? "provider_rich_card",
    };
  }

  const hasText = blocks.some(
    (block) => block.type === "text" && block.text.length > 0,
  );
  const hasImage = blocks.some((block) => block.type === "image");
  const hasFile = blocks.some((block) => block.type === "file");
  const hasRichInline = blocks.some(
    (block) => block.type === "link" || block.type === "mention",
  );

  if (hasImage && !hasText && !hasFile && !hasRichInline) {
    return { contentKind: "image", presentationKind: "image_gallery" };
  }
  if (hasImage && (hasText || hasRichInline)) {
    return { contentKind: "mixed", presentationKind: "image_gallery" };
  }
  if (hasFile && !hasText && !hasImage && !hasRichInline) {
    return { contentKind: "file", presentationKind: "file_attachment" };
  }
  if (hasText && !hasImage && !hasFile && !hasRichInline) {
    return { contentKind: "text", presentationKind: "plain" };
  }
  if (hasText || hasRichInline) {
    return { contentKind: "rich_text", presentationKind: "rich_markdown" };
  }
  return { contentKind: "unknown", presentationKind: "unknown" };
}
