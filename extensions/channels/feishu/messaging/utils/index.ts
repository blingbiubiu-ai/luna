import type { MessageContentBlock } from "@/sessions/types";

/** Feishu post content element with tag. */
type PostElement =
  | { tag: "text"; text: string; un_escape?: boolean; style?: string[] }
  | { tag: "a"; text: string; href: string; style?: string[] }
  | { tag: "at"; user_id: string; user_name?: string; style?: string[] }
  | { tag: "img"; image_key: string }
  | { tag: "media"; file_key: string; image_key: string }
  | { tag: "emotion"; emoji_type: string }
  | { tag: "code_block"; language: string; text: string }
  | { tag: "hr" };

/** Feishu post (rich text) message structure. */
export interface FeishuPost {
  title?: string;
  content?: PostElement[][];
}

export interface ConvertedFeishuPostContent {
  readonly markdown: string;
  readonly contentBlocks: readonly MessageContentBlock[];
}

function _applyStyle(text: string, style?: string[]): string {
  if (!style || style.length === 0) return text;
  let result = text;
  for (const s of style) {
    switch (s) {
      case "bold":
        result = `**${result}**`;
        break;
      case "italic":
        result = `*${result}*`;
        break;
      case "underline":
        result = `<u>${result}</u>`;
        break;
      case "lineThrough":
        result = `~~${result}~~`;
        break;
      default:
        break;
    }
  }
  return result;
}

/**
 * Convert Feishu post (rich text) to runner Markdown and structured blocks.
 * Supports: text, a, at, img, media, emotion, code_block, hr.
 */
export async function convertPostToMarkdownAndMessageContentBlocks(
  post: FeishuPost,
  resolveMessageResourceRef: (file_key: string) => Promise<string>,
): Promise<ConvertedFeishuPostContent> {
  const { title, content } = post;
  const lines: string[] = [];
  const contentBlocks: MessageContentBlock[] = [];

  if (title) {
    const titleText = `# ${title}`;
    lines.push(titleText);
    lines.push("");
    contentBlocks.push({ type: "text", text: titleText });
  }

  if (!Array.isArray(content)) {
    return { markdown: lines.join("\n"), contentBlocks };
  }

  for (const paragraph of content) {
    if (!Array.isArray(paragraph)) continue;
    const parts: string[] = [];
    const inlineText: string[] = [];
    const flushInlineText = () => {
      const text = inlineText.join("").trim();
      inlineText.length = 0;
      if (text.length > 0) {
        contentBlocks.push({ type: "text", text });
      }
    };

    for (const el of paragraph as PostElement[]) {
      switch (el.tag) {
        case "text": {
          const text = _applyStyle(el.text, el.style);
          parts.push(text);
          inlineText.push(text);
          break;
        }
        case "a": {
          const text = _applyStyle(`[${el.text}](${el.href})`, el.style);
          parts.push(text);
          inlineText.push(text);
          break;
        }
        case "at": {
          const text = _applyStyle(
            `@${el.user_name || el.user_id.replace(/^@_/, "")}`,
            el.style,
          );
          parts.push(text);
          inlineText.push(text);
          break;
        }
        case "emotion": {
          const text = `[emotion:${el.emoji_type}]`;
          parts.push(text);
          inlineText.push(text);
          break;
        }
        case "code_block": {
          flushInlineText();
          const text = `\n\`\`\`${el.language}\n${el.text}\n\`\`\`\n`;
          parts.push(text);
          contentBlocks.push({
            type: "text",
            text: `\`\`\`${el.language}\n${el.text}\n\`\`\``,
          });
          break;
        }
        case "hr":
          flushInlineText();
          parts.push("\n---\n");
          contentBlocks.push({ type: "text", text: "---" });
          break;
        case "img":
          flushInlineText();
          try {
            const resourceRef = await resolveMessageResourceRef(el.image_key);
            parts.push(`![image](${resourceRef})`);
            contentBlocks.push({
              type: "image",
              fileId: el.image_key,
              url: resourceRef,
              alt: "image",
              source: { provider: "feishu", imageKey: el.image_key },
            });
          } catch {
            const text = "[图片消息：资源暂时无法下载]";
            parts.push(text);
            contentBlocks.push({ type: "text", text });
          }
          break;
        case "media":
          flushInlineText();
          try {
            const resourceRef = await resolveMessageResourceRef(el.file_key);
            parts.push(`[video](${resourceRef})`);
            contentBlocks.push({
              type: "file",
              fileId: el.file_key,
              name: "video",
              source: {
                provider: "feishu",
                fileKey: el.file_key,
                imageKey: el.image_key,
                path: resourceRef,
              },
            });
          } catch {
            const text = "[视频消息：资源暂时无法下载]";
            parts.push(text);
            contentBlocks.push({ type: "text", text });
          }
          break;
        default:
          break;
      }
    }
    flushInlineText();
    if (parts.length > 0) {
      lines.push(parts.join(""));
    }
  }

  return { markdown: lines.join("\n").trim(), contentBlocks };
}
