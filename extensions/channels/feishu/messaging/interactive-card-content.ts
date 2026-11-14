export const FEISHU_UNSUPPORTED_INTERACTIVE_PLACEHOLDER =
  "卡片消息（当前暂不支持解析具体内容）";

export function extractFeishuInteractiveMarkdown(input: unknown): string | null {
  const card = parseJsonRecord(input);
  if (card === null) {
    return null;
  }

  const userDsl = parseJsonRecord(card.user_dsl);
  const userDslMarkdown = collectMarkdownElements(userDsl).join("\n\n").trim();
  if (userDslMarkdown.length > 0) {
    return normalizeFeishuAtTags(userDslMarkdown);
  }

  const cardMarkdown = collectMarkdownElements(card).join("\n\n").trim();
  if (cardMarkdown.length > 0) {
    return normalizeFeishuAtTags(cardMarkdown);
  }

  const textFallback = collectTextElements(userDsl).concat(
    collectTextElements(card),
  ).join("\n\n").trim();
  if (textFallback.length > 0) {
    return normalizeFeishuAtTags(textFallback);
  }

  return FEISHU_UNSUPPORTED_INTERACTIVE_PLACEHOLDER;
}

function collectMarkdownElements(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectMarkdownElements(item));
  }
  if (!isRecord(value)) {
    return [];
  }
  const ownContent =
    value.tag === "markdown" && typeof value.content === "string"
      ? [value.content]
      : [];
  return [
    ...ownContent,
    ...Object.values(value).flatMap((child) => collectMarkdownElements(child)),
  ];
}

function collectTextElements(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextElements(item));
  }
  if (!isRecord(value)) {
    return [];
  }
  const ownText = [
    typeof value.title === "string" ? value.title : null,
    typeof value.text === "string" ? value.text : null,
    typeof value.content === "string" && value.tag !== "markdown"
      ? value.content
      : null,
  ].filter((item): item is string => item !== null && item.trim().length > 0);
  return [
    ...ownText,
    ...Object.values(value).flatMap((child) => collectTextElements(child)),
  ];
}

export function normalizeFeishuAtTags(text: string): string {
  return text.replace(
    /<at\b[^>]*\bmention_key=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\s*<\/at>/g,
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) =>
      doubleQuoted ?? singleQuoted ?? bare ?? "",
  );
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
