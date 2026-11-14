import { normalizeFeishuAtTags } from "./interactive-card-content";

const TITLE_KEYS = new Set([
  "title",
  "name",
  "subject",
  "topic_title",
  "thread_title",
]);
const BODY_KEYS = new Set([
  "description",
  "summary",
  "abstract",
  "content",
  "text",
  "subtitle",
  "preview",
]);
const URL_KEYS = new Set(["url", "link", "href", "permalink", "web_url"]);
const STRUCTURE_KEYS = new Set([
  "card_type",
  "topic",
  "topic_id",
  "topic_url",
  "thread_id",
  "thread_title",
]);

export function extractFeishuStructuredCardMarkdown(input: unknown): string | null {
  const record = parseJsonRecord(input);
  if (record === null || !looksLikeStructuredCard(record)) {
    return null;
  }

  const title = firstCollectedString(record, TITLE_KEYS);
  const body = collectStringFields(record, BODY_KEYS);
  const urls = collectStringFields(record, URL_KEYS).filter(isHttpUrl);
  const lines = uniqueStrings([
    ...(title !== null ? [`**${title}**`] : []),
    ...body.filter((value) => value !== title),
    ...urls.map((url) => `[查看原内容](${url})`),
  ]);
  const markdown = normalizeFeishuAtTags(lines.join("\n\n").trim());
  return markdown.length > 0 ? markdown : null;
}

function looksLikeStructuredCard(record: Record<string, unknown>): boolean {
  if (hasAnyKey(record, STRUCTURE_KEYS)) {
    return true;
  }
  const typeHint = firstString(record.type, record.tag, record.cardType);
  if (typeHint !== null && /topic|thread|card|话题/.test(typeHint)) {
    return true;
  }
  return (
    hasAnyKey(record, TITLE_KEYS) &&
    (hasAnyKey(record, BODY_KEYS) || hasAnyKey(record, URL_KEYS))
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

function collectStringFields(
  value: unknown,
  keys: ReadonlySet<string>,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStringFields(item, keys));
  }
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const own =
      keys.has(key) && typeof child === "string" ? [cleanString(child)] : [];
    return [...own, ...collectStringFields(child, keys)];
  }).filter((item) => item.length > 0);
}

function firstCollectedString(
  value: unknown,
  keys: ReadonlySet<string>,
): string | null {
  return collectStringFields(value, keys)[0] ?? null;
}

function hasAnyKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasAnyKey(item, keys));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) => keys.has(key) || hasAnyKey(child, keys),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const clean = cleanString(value);
    if (!clean || seen.has(clean)) {
      continue;
    }
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function cleanString(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function firstString(...values: readonly unknown[]): string | null {
  return values.find((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  ) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
