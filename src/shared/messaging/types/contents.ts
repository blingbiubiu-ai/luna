import { z } from "zod";

/**
 * A text message content.
 */
export const TextMessageContent = z.object({
  type: z.literal("text"),
  /**
   * The text content of the message.
   */
  text: z.string(),
});
/**
 * Describes the Text Message Content contract used by shared message model.
 */
export interface TextMessageContent extends z.infer<
  typeof TextMessageContent
> {}

/**
 * Zod schema for assistant thinking message content.
 */
export const ThinkingMessageContent = z.object({
  type: z.literal("thinking"),
  /**
   * The thinking content of the message.
   */
  thinking: z.string(),
});
/**
 * Describes the Thinking Message Content contract used by shared message model.
 */
export interface ThinkingMessageContent extends z.infer<
  typeof ThinkingMessageContent
> {}

/**
 * An image URL message content.
 */
export const ImageUrlMessageContent = z.object({
  type: z.literal("image_url"),
  /**
   * The image URL content of the message.
   */
  image_url: z.string(),
});
/**
 * Describes the Image URL Message Content contract used by shared message model.
 */
export interface ImageUrlMessageContent extends z.infer<
  typeof ImageUrlMessageContent
> {}

/**
 * The tool use message content.
 */
export const ToolUseMessageContent = z.object({
  type: z.literal("tool_use"),
  displayTitle: z.string().optional(),
  /**
   * The name of the tool to use.
   */
  name: z.string(),
  /**
   * The identifier of the tool use.
   */
  id: z.string(),
  /**
   * The input parameters to pass to the tool.
   */
  input: z.record(z.string(), z.any()),
});
/**
 * Describes the Tool Use Message Content contract used by shared message model.
 */
export interface ToolUseMessageContent extends z.infer<
  typeof ToolUseMessageContent
> {}

/**
 * The task tool use message content.
 */
export const ToolResultMessageContent = z.object({
  type: z.literal("tool_result"),
  /**
   * The identifier of the tool use.
   */
  tool_use_id: z.string(),
  /**
   * The result of the tool.
   */
  content: z.string(),
});
/**
 * Describes the Tool Result Message Content contract used by shared message model.
 */
export interface ToolResultMessageContent extends z.infer<
  typeof ToolResultMessageContent
> {}

/**
 * Zod union schema for all supported message content blocks.
 */
export const MessageContent = z.discriminatedUnion("type", [
  TextMessageContent,
  ThinkingMessageContent,
  ImageUrlMessageContent,
  ToolUseMessageContent,
  ToolResultMessageContent,
]);
/**
 * Represents Message Content values used by shared message model.
 */
export type MessageContent =
  | TextMessageContent
  | ThinkingMessageContent
  | ImageUrlMessageContent
  | ToolUseMessageContent
  | ToolResultMessageContent;
