import { z } from "zod";

import { ToolUseMessageContent } from "./contents";

/**
 * Zod schema for Bash tool-use message content.
 */
export const BashToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Bash"),
  input: z.object({
    command: z.string(),
    description: z.string().optional(),
  }),
});
/**
 * Describes the Bash Tool Use Message Content contract used by shared message model.
 */
export interface BashToolUseMessageContent extends z.infer<
  typeof BashToolUseMessageContent
> {}

/**
 * Zod schema for Edit tool-use message content.
 */
export const EditToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Edit"),
  input: z.object({
    file_path: z.string(),
  }),
});
/**
 * Describes the Edit Tool Use Message Content contract used by shared message model.
 */
export interface EditToolUseMessageContent extends z.infer<
  typeof EditToolUseMessageContent
> {}

/**
 * Zod schema for Glob tool-use message content.
 */
export const GlobToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Glob"),
  input: z.object({
    pattern: z.string(),
  }),
});
/**
 * Describes the Glob Tool Use Message Content contract used by shared message model.
 */
export interface GlobToolUseMessageContent extends z.infer<
  typeof GlobToolUseMessageContent
> {}

/**
 * Zod schema for Grep tool-use message content.
 */
export const GrepToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Grep"),
  input: z.object({
    pattern: z.string(),
    glob: z.string(),
  }),
});
/**
 * Describes the Grep Tool Use Message Content contract used by shared message model.
 */
export interface GrepToolUseMessageContent extends z.infer<
  typeof GrepToolUseMessageContent
> {}

/**
 * Zod schema for Read tool-use message content.
 */
export const ReadToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Read"),
  input: z.object({
    file_path: z.string(),
  }),
});
/**
 * Describes the Read Tool Use Message Content contract used by shared message model.
 */
export interface ReadToolUseMessageContent extends z.infer<
  typeof ReadToolUseMessageContent
> {}

/**
 * Zod schema for Skill tool-use message content.
 */
export const SkillToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Skill"),
  input: z.object({
    skill: z.string(),
  }),
});
/**
 * Describes the Skill Tool Use Message Content contract used by shared message model.
 */
export interface SkillToolUseMessageContent extends z.infer<
  typeof SkillToolUseMessageContent
> {}

/**
 * Zod schema for Task tool-use message content.
 */
export const TaskToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Task"),
  input: z.object({
    description: z.string(),
    prompt: z.string(),
    subagent_type: z.string(),
  }),
});
/**
 * Describes the Task Tool Use Message Content contract used by shared message model.
 */
export interface TaskToolUseMessageContent extends z.infer<
  typeof TaskToolUseMessageContent
> {}

/**
 * Zod schema for Tool Search tool-use message content.
 */
export const ToolSearchToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("ToolSearch"),
  input: z.object({
    query: z.string(),
  }),
});
/**
 * Describes the Tool Search Tool Use Message Content contract used by shared message model.
 */
export interface ToolSearchToolUseMessageContent extends z.infer<
  typeof ToolSearchToolUseMessageContent
> {}

/**
 * Zod schema for Web Fetch tool-use message content.
 */
export const WebFetchToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("WebFetch"),
  input: z.object({
    url: z.string(),
    prompt: z.string().optional(),
  }),
});
/**
 * Describes the Web Fetch Tool Use Message Content contract used by shared message model.
 */
export interface WebFetchToolUseMessageContent extends z.infer<
  typeof WebFetchToolUseMessageContent
> {}

/**
 * Zod schema for Web Search tool-use message content.
 */
export const WebSearchToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("WebSearch"),
  input: z.object({
    query: z.string(),
  }),
});
/**
 * Describes the Web Search Tool Use Message Content contract used by shared message model.
 */
export interface WebSearchToolUseMessageContent extends z.infer<
  typeof WebSearchToolUseMessageContent
> {}

/**
 * Zod schema for Write tool-use message content.
 */
export const WriteToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Write"),
  input: z.object({
    file_path: z.string(),
    content: z.string(),
  }),
});
/**
 * Describes the Write Tool Use Message Content contract used by shared message model.
 */
export interface WriteToolUseMessageContent extends z.infer<
  typeof WriteToolUseMessageContent
> {}
