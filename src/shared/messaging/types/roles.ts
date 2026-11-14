import { z } from "zod";

/**
 * The role of the message sender.
 *
 * NOTE: This is different from the role definition in Claude Code.
 *
 * - `system`: The system message.
 * - `user`: The user message.
 * - `assistant`: The assistant message. May contain tool use.
 * - `tool`: The tool message which contains the result of a tool use.
 */
export const MessageRole = z.enum(["system", "user", "assistant", "tool"]);
/**
 * Represents Message Role values used by shared message model.
 */
export type MessageRole = z.infer<typeof MessageRole>;
