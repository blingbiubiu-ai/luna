/**
 * Runner input is split into tagged blocks: `<tag>` around Markdown, compact JSON or plain
 * text. Only the block boundaries are tags; the content inside keeps its own format.
 */

/** Every block name Luna uses in Runner instructions or turn input. */
export const RESERVED_BLOCK_TAGS = [
  "soul", "luna_runtime", "identity", "role", "hard_rules", "routing", "reply_protocol",
  "task_commands", "session_commands", "input_rules", "messaging", "memory_rules", "artifacts",
  "evidence", "environment",
  "capabilities", "events",
  "messages", "memory", "history", "tasks", "clarification", "task_result", "trigger",
  "task", "launch_context", "update_context", "user_input", "report_sections", "now",
] as const;

const forgedTag = new RegExp(`<(?=/?(?:${RESERVED_BLOCK_TAGS.join("|")})\\b)`, "gi");

/**
 * Keeps text written by people (messages, memory, persona) from opening or closing a Luna
 * block: `<` before a reserved block name becomes `&lt;`. Every other `<` is left alone, so
 * pasted code and HTML stay intact. The replacement contains no JSON special characters, so
 * serialized JSON stays valid.
 */
export function neutralizeBlockTags(text: string): string {
  return text.replace(forgedTag, "&lt;");
}

/** A block of trusted text; omitted when empty. */
export function promptBlock(tag: string, body: string): string {
  const content = body.trim();
  return content ? `<${tag}>\n${content}\n</${tag}>` : "";
}

/** A block whose content comes from people or stored data. */
export function dataBlock(tag: string, value: { readonly json?: unknown; readonly text?: string }): string {
  const parts = [
    value.json === undefined ? "" : neutralizeBlockTags(JSON.stringify(value.json)),
    value.text === undefined ? "" : neutralizeBlockTags(value.text.trim()),
  ].filter(Boolean);
  return parts.length ? `<${tag}>\n${parts.join("\n\n")}\n</${tag}>` : "";
}

/** Joins blocks in order, dropping empty ones. */
export function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter(Boolean).join("\n\n");
}
