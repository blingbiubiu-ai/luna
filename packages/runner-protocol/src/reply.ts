import { z } from "zod";

const artifactRef = z.string().regex(/^artifact:[A-Za-z0-9._:-]+$/);
export const replyBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(100000) }).strict(),
  z.object({ type: z.literal("mention"), userId: z.string().min(1).max(256), label: z.string().min(1).max(256).optional() }).strict(),
  z.object({ type: z.literal("image"), artifactRef, alt: z.string().max(500).optional() }).strict(),
  z.object({ type: z.literal("file"), artifactRef, name: z.string().max(500).optional() }).strict(),
  z.object({
    type: z.literal("actions"),
    requestId: z.string().min(1).max(128),
    options: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
  }).strict(),
]);
export const replySchema = z.object({
  type: z.literal("luna.reply"), version: z.literal(1),
  presentation: z.enum(["text", "message", "card"]),
  template: z.enum(["markdown", "result"]).optional(),
  title: z.string().max(500).optional(),
  content: z.array(replyBlockSchema).min(1).max(32),
  /** Id of a message of the conversation, as given in `<messages>`: the reply quotes it instead of standing alone in the chat. */
  replyTo: z.string().min(1).max(256).optional(),
}).strict();
export type ReplyDocument = z.infer<typeof replySchema>;

/** Only our discriminator opts into the protocol; ordinary JSON remains text. */
export function parseReply(text: string): ReplyDocument {
  if (!text.trim() || text.length > 100000) throw new Error("Reply must contain 1–100000 characters");
  let value: unknown;
  try { value = JSON.parse(text); } catch { /* Plain text is a supported reply. */ }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).type !== "luna.reply") {
    return { type: "luna.reply", version: 1, presentation: "text", content: [{ type: "text", text }] };
  }
  const input = value as Record<string, unknown>;
  // Validate media before degrading presentation: never silently discard an image.
  const content = z.array(replyBlockSchema).min(1).max(32).parse(typeof input.content === "string" ? [{ type: "text", text: input.content }] : input.content);
  const title = z.string().max(500).optional().parse(input.title);
  const replyTo = z.string().min(1).max(256).optional().parse(input.replyTo);
  const supported = input.version === 1 && ["text", "message", "card"].includes(String(input.presentation)) &&
    (input.template === undefined || ["markdown", "result"].includes(String(input.template)));
  return replySchema.parse({ type: "luna.reply", version: 1, presentation: supported ? input.presentation : "message",
    ...(supported && input.template ? { template: input.template } : {}), ...(title ? { title } : {}), content, ...(replyTo ? { replyTo } : {}) });
}

const label = (text: string) => text.replace(/[\\\[\]\r\n]/g, " ");
export function replyMarkdown(reply: ReplyDocument): string {
  const title = reply.title ? `**${reply.title.replace(/[\r\n]/g, " ").replace(/\*/g, "\\*")}**` : "";
  const blocks = reply.content.map(block => {
    if (block.type === "mention") return `@${label(block.label ?? block.userId)}`;
    if (block.type === "actions") return `选项：${block.options.map(label).join(" / ")}`;
    return block.type === "text" ? block.text : block.type === "image"
      ? `![${label(block.alt ?? "图片")}](${block.artifactRef})`
      : `[${label(block.name ?? "文件")}](${block.artifactRef})`;
  });
  const separator = reply.content.some(block => block.type === "mention") ? "" : "\n\n";
  return [title, blocks.filter(Boolean).join(separator)].filter(Boolean).join("\n\n");
}
