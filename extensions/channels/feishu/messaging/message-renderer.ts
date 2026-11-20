import fs from "node:fs";
import nodePath from "node:path";

import {
  config,
  type AssistantMessage,
  type BashToolUseMessageContent,
  type EditToolUseMessageContent,
  type GlobToolUseMessageContent,
  type GrepToolUseMessageContent,
  type ReadToolUseMessageContent,
  type SkillToolUseMessageContent,
  type ToolUseMessageContent,
  type WebFetchToolUseMessageContent,
  type WebSearchToolUseMessageContent,
  type WriteToolUseMessageContent,
} from "@/shared";
import type { BatchSummaryCardOperation } from "@/channels/outbound";

import type {
  Card,
  CollapsiblePanel,
  DivElement,
  ImageElement,
  MarkdownElement,
} from "./types";

/**
 * Render assistant message content as a Feishu interactive card.
 * @param messageContent - Array of content blocks (thinking, tool_use, text).
 * @param options - Rendering options (streaming mode).
 * @returns Feishu Card object for API payload.
 */
export async function renderTaskResultCard(
  input: {
    readonly taskId: string;
    readonly title?: string;
    readonly summary?: string;
    readonly status?: string;
    readonly content: string;
  },
  {
    uploadImage,
    resolveImagePath,
  }: {
    // eslint-disable-next-line no-unused-vars
    uploadImage: (path: string) => Promise<string>;
    resolveImagePath?: (path: string) => string | undefined;
  },
): Promise<Card> {
  const renderedContent = await _renderMarkdownContent(
    input.content,
    imageUploadOptions({ uploadImage, resolveImagePath }),
  );
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      enable_forward: true,
      enable_forward_interaction: true,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: _cardSummary(renderedContent.summaryContent),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: input.title ?? "Task 结论",
      },
      ..._cardHeaderSubtitle(input),
      template: _taskResultTemplate(input.status),
    },
    body: {
      elements: renderedContent.elements,
    },
  };
}

export async function renderBatchSummaryCard(
  input: BatchSummaryCardOperation & { readonly reply: string },
  options: {
    uploadImage?: (path: string) => Promise<string>;
    resolveImagePath?: (path: string) => string | undefined;
  } = {},
): Promise<Card> {
  const subtitle = input.timeRangeLabel?.trim() ?? "";
  const elements: Array<MarkdownElement | DivElement | ImageElement> = [];

  const backgroundTasks = input.backgroundTasks?.filter(
    (task) => task.trim() !== "",
  );
  if (backgroundTasks !== undefined && backgroundTasks.length > 0) {
    elements.push({
      tag: "markdown",
      content: "**后台任务**",
    });
    elements.push(
      ...backgroundTasks.map((task) => ({
        tag: "div" as const,
        text: {
          tag: "plain_text" as const,
          content: `• ${_safeBatchSummaryLine(task)}`,
        },
      })),
    );
  }
  const renderedReply = options.uploadImage
    ? await _renderMarkdownContent(
        input.reply,
        imageUploadOptions({
          uploadImage: options.uploadImage,
          resolveImagePath: options.resolveImagePath,
        }),
      )
    : {
        elements: [{ tag: "markdown" as const, content: input.reply }],
        summaryContent: input.reply,
      };

  elements.push(
    ...renderedReply.elements,
    {
      tag: "div",
      text: {
        tag: "plain_text",
        text_color: "grey",
        text_size: "notation",
        content: "Luna · 批量会话回复",
      },
    },
  );

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      enable_forward: true,
      enable_forward_interaction: true,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: _cardSummary(renderedReply.summaryContent || input.title),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: input.title,
      },
      ...(subtitle !== ""
        ? {
            subtitle: {
              tag: "plain_text" as const,
              content: subtitle,
            },
          }
        : {}),
      template: "blue",
    },
    body: {
      elements,
    },
  };
}

export async function renderStatusCard(
  input: {
    readonly title?: string;
    readonly summary?: string;
    readonly status?: string;
    readonly state?: "active" | "terminal";
    readonly hideHeader?: boolean;
    readonly content: string;
    readonly steps?: readonly string[];
  },
  { uploadImage, resolveImagePath, maxVisibleSteps }: {
    // eslint-disable-next-line no-unused-vars
    uploadImage: (path: string) => Promise<string>;
    resolveImagePath?: (path: string) => string | undefined;
    maxVisibleSteps?: number;
  },
): Promise<Card> {
  const active = input.state === "active";
  const renderedContent = await _renderMarkdownContent(
    input.content,
    imageUploadOptions({ uploadImage, resolveImagePath }),
  );
  const stepPanel = _renderStatusCardStepPanel(input.steps ?? [], active, maxVisibleSteps);
  const renderedSummary = _cardSummary(renderedContent.summaryContent);
  const card: Card = {
    schema: "2.0",
    config: {
      streaming_mode: active,
      enable_forward: true,
      enable_forward_interaction: true,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content:
          renderedSummary ||
          stepPanel?.header.title.content ||
          _cardSummary(input.summary ?? input.title ?? ""),
      },
    },
    body: {
      elements: [
        ...(stepPanel === undefined ? [] : [stepPanel]),
        ...renderedContent.elements,
      ],
    },
  };
  if (input.hideHeader !== true) {
    card.header = {
      title: {
        tag: "plain_text",
        content: input.title ?? "Task 状态",
      },
      ..._cardHeaderSubtitle(input),
      template: _statusCardTemplate(input.status, input.state),
    };
  }
  return card;
}

function _renderStatusCardStepPanel(
  steps: readonly string[],
  active: boolean,
  maxVisibleSteps: number = 32,
): CollapsiblePanel | undefined {
  if (steps.length === 0) {
    return undefined;
  }
  const visibleSteps = steps.slice(-maxVisibleSteps);
  const omittedStepCount = steps.length - visibleSteps.length;
  const renderedSteps = renderStatusCardSteps(visibleSteps);
  if (omittedStepCount > 0) {
    renderedSteps.unshift(
      _renderStep(`... ${omittedStepCount} earlier steps omitted`, "more_outlined"),
    );
  }
  const stepCountText = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  const isTruncated = omittedStepCount > 0;
  const progressSummary = isTruncated
    ? `${stepCountText} · showing latest ${visibleSteps.length}`
    : stepCountText;
  return {
    tag: "collapsible_panel",
    expanded: active,
    border: {
      color: "grey-300",
      corner_radius: "6px",
    },
    vertical_spacing: "2px",
    header: {
      title: {
        tag: "plain_text",
        text_color: "grey",
        text_size: "notation",
        content: active
          ? `Working on it (${progressSummary})`
          : isTruncated
            ? `Show latest ${visibleSteps.length} of ${stepCountText}`
            : `Show ${stepCountText}`,
      },
      icon: {
        tag: "standard_icon",
        token: "right_outlined",
        color: "grey",
      },
      icon_position: "right",
      icon_expanded_angle: 90,
    },
    elements: renderedSteps,
  };
}

export async function renderMessageCard(
  messageContent: AssistantMessage["content"],
  {
    streaming,
    uploadImage,
    resolveImagePath,
    maxVisibleSteps = 32,
  }: {
    streaming: boolean;
    // eslint-disable-next-line no-unused-vars
    uploadImage: (path: string) => Promise<string>;
    resolveImagePath?: (path: string) => string | undefined;
    maxVisibleSteps?: number;
  },
): Promise<Card> {
  const stepPanel: CollapsiblePanel = {
    tag: "collapsible_panel",
    expanded: streaming,
    border: {
      color: "grey-300",
      corner_radius: "6px",
    },
    vertical_spacing: "2px",
    header: {
      title: {
        tag: "plain_text",
        text_color: "grey",
        text_size: "notation",
        content: "",
      },
      icon: {
        tag: "standard_icon",
        token: "right_outlined",
        color: "grey",
      },
      icon_position: "right",
      icon_expanded_angle: 90,
    },
    elements: [],
  };
  const card: Card = {
    schema: "2.0",
    config: {
      streaming_mode: true,
      enable_forward: true,
      enable_forward_interaction: true,
      update_multi: true,
      width_mode: "fill",
      summary: {
        content: "",
      },
    },
    body: {
      elements: [stepPanel],
    },
  };
  const allSteps: DivElement[] = [];
  const lastTextIndex = messageContent.findLastIndex((content) => content.type === "text");
  for (const [index, content] of messageContent.entries()) {
    if (content.type === "thinking") {
      allSteps.push(_renderStep(content.thinking, "robot_outlined"));
    } else if (content.type === "tool_use") {
      _renderTool(content, allSteps);
    } else if (
      content.type === "text" &&
      content.text.trim() !== "" &&
      (streaming || index !== lastTextIndex)
    ) {
      allSteps.push(_renderStep(content.text, "robot_outlined"));
    }
  }
  const stepCount = allSteps.length;
  const visibleSteps = allSteps.slice(-maxVisibleSteps);
  const omittedStepCount = stepCount - visibleSteps.length;
  if (omittedStepCount > 0) {
    stepPanel.elements.push(
      _renderStep(`... ${omittedStepCount} earlier steps omitted`, "more_outlined"),
    );
  }
  stepPanel.elements.push(...visibleSteps);
  if (!streaming) {
    // Find the last text block (final response), not all text blocks
    const lastTextContent = messageContent.findLast((c) => c.type === "text");
    if (lastTextContent) {
      const renderedContent = await _renderMarkdownContent(
        lastTextContent.text,
        imageUploadOptions({ uploadImage, resolveImagePath }),
      );
      card.config!.summary.content = renderedContent.summaryContent;
      card.body.elements.push(...renderedContent.elements);
    }
  }

  if (stepCount > 0) {
    const stepCountText =
      stepCount + " " + (stepCount === 1 ? "step" : "steps");
    const isTruncated = stepCount > visibleSteps.length;
    const progressSummary = isTruncated
      ? `${stepCountText} · showing latest ${visibleSteps.length}`
      : stepCountText;
    if (streaming) {
      stepPanel.header.title.content = `Working on it (${progressSummary})`;
      card.config!.summary.content = `Working on it (${progressSummary})`;
    } else {
      stepPanel.header.title.content = isTruncated
        ? `Show latest ${visibleSteps.length} of ${stepCountText}`
        : `Show ${stepCountText}`;
    }
  } else {
    // No steps, remove the collapsible panel if it exists
    if (card.body.elements[0]?.tag === "collapsible_panel") {
      card.body.elements.splice(0, 1);
    }
    if (card.body.elements.length === 0) {
      card.body.elements.push({
        tag: "div",
        text: {
          tag: "plain_text",
          content: "",
        },
      });
    }
  }
  if (streaming) {
    card.body.elements.push({
      tag: "div",
      icon: {
        tag: "standard_icon",
        token: "more_outlined",
        color: "grey",
      },
    });
  }
  return card;
}

function imageUploadOptions(input: {
  readonly uploadImage: (path: string) => Promise<string>;
  readonly resolveImagePath:
    | ((path: string) => string | undefined)
    | undefined;
}): {
  readonly uploadImage: (path: string) => Promise<string>;
  readonly resolveImagePath?: (path: string) => string | undefined;
} {
  return {
    uploadImage: input.uploadImage,
    ...(input.resolveImagePath !== undefined
      ? { resolveImagePath: input.resolveImagePath }
      : {}),
  };
}

async function _renderMarkdownContent(
  text: string,
  {
    uploadImage,
    resolveImagePath,
  }: {
    // eslint-disable-next-line no-unused-vars
    uploadImage: (path: string) => Promise<string>;
    resolveImagePath?: (path: string) => string | undefined;
  },
): Promise<{
  elements: Array<MarkdownElement | ImageElement>;
  summaryContent: string;
}> {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const elements: Array<MarkdownElement | ImageElement> = [];
  let summaryContent = "";
  let markdownBuffer = "";
  let cursor = 0;

  const flushMarkdown = () => {
    if (markdownBuffer === "") {
      return;
    }
    elements.push({
      tag: "markdown",
      content: markdownBuffer,
    });
    markdownBuffer = "";
  };

  for (const match of text.matchAll(imageRegex)) {
    const rawMatch = match[0];
    const alt = match[1] ?? "";
    let imagePath = match[2] ?? "";
    const index = match.index ?? 0;
    const before = text.slice(cursor, index);
    markdownBuffer += before;
    summaryContent += before;
    cursor = index + rawMatch.length;

    if (imagePath === "") {
      continue;
    }

    if (imagePath.startsWith("http:") || imagePath.startsWith("https:")) {
      const downloadedPath = await downloadRemoteImageToWorkspace(imagePath);
      if (downloadedPath === undefined) {
        const fallbackLink = `[${imagePath}](${imagePath})`;
        markdownBuffer += fallbackLink;
        summaryContent += imagePath;
        continue;
      }
      imagePath = downloadedPath;
    }

    const localImagePath =
      resolveImagePath?.(imagePath) ?? defaultLocalImagePath(imagePath);
    if (localImagePath === undefined) {
      continue;
    }

    const imageKey = await uploadImage(localImagePath);
    flushMarkdown();
    const altText = imageAltText(alt);
    elements.push({
      tag: "img",
      img_key: imageKey,
      mode: "fit_horizontal",
      custom_width: 320,
      alt: {
        tag: "plain_text",
        content: altText,
      },
    });
    summaryContent += `[${altText}]`;
  }

  markdownBuffer += text.slice(cursor);
  summaryContent += text.slice(cursor);
  flushMarkdown();

  if (elements.length === 0) {
    elements.push({
      tag: "markdown",
      content: "",
    });
  }

  return { elements, summaryContent };
}

async function downloadRemoteImageToWorkspace(
  imagePath: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(imagePath);
    const imageBuffer = await response.arrayBuffer();
    const imageName = imagePath.split("/").pop();
    const downloadPath = nodePath.join(config.paths.workspace, "downloads");
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }
    if (imageName) {
      fs.writeFileSync(
        nodePath.join(downloadPath, imageName),
        Buffer.from(imageBuffer),
      );
      return nodePath.join("workspace", "downloads", imageName);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function imageAltText(alt: string): string {
  const trimmed = alt.trim();
  return trimmed === "" ? "image" : trimmed;
}

function defaultLocalImagePath(imagePath: string): string | undefined {
  const candidatePath = nodePath.isAbsolute(imagePath)
    ? imagePath
    : nodePath.join(config.paths.home, imagePath);
  return fs.existsSync(candidatePath) &&
    isPathContainedBy(candidatePath, config.paths.workspace)
    ? candidatePath
    : undefined;
}

function isPathContainedBy(path: string, root: string): boolean {
  const relativePath = nodePath.relative(nodePath.resolve(root), nodePath.resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !nodePath.isAbsolute(relativePath));
}

/** Render a single tool use step into the collapsible panel. */
function _renderTool(
  content: ToolUseMessageContent,
  steps: DivElement[],
) {
  switch (content.name) {
    case "Agent":
    case "Task":
      steps.push(_renderStep("Run sub-agent", "robot_outlined"));
      break;
    case "Bash":
      const bashContent = content as BashToolUseMessageContent;
      steps.push(
        _renderStep(
          bashContent.input.description ?? bashContent.input.command,
          "computer_outlined",
        ),
      );
      break;
    case "Edit":
      const editContent = content as EditToolUseMessageContent;
      steps.push(
        _renderStep(`Edit "${editContent.input.file_path}"`, "edit_outlined"),
      );
      break;
    case "Glob":
      const globContent = content as GlobToolUseMessageContent;
      steps.push(
        _renderStep(
          `Search files by pattern "${globContent.input.pattern}"`,
          "card-search_outlined",
        ),
      );
      break;
    case "Grep":
      const grepContent = content as GrepToolUseMessageContent;
      steps.push(
        _renderStep(
          `Search text by pattern "${grepContent.input.pattern}" in "${grepContent.input.glob}"`,
          "doc-search_outlined",
        ),
      );
      break;
    case "WebFetch":
      const webFetchContent = content as WebFetchToolUseMessageContent;
      steps.push(
        _renderStep(
          `Fetch web page from "${webFetchContent.input.url}"`,
          "language_outlined",
        ),
      );
      break;
    case "WebSearch":
      const webSearchContent = content as WebSearchToolUseMessageContent;
      steps.push(
        _renderStep(
          `Search web for "${webSearchContent.input.query}"`,
          "search_outlined",
        ),
      );
      break;
    case "Read":
      const readContent = content as ReadToolUseMessageContent;
      steps.push(
        _renderStep(
          `Read file "${readContent.input.file_path}"`,
          "file-link-bitable_outlined",
        ),
      );
      break;
    case "Write":
      const writeContent = content as WriteToolUseMessageContent;
      steps.push(
        _renderStep(
          `Write file "${writeContent.input.file_path}"`,
          "edit_outlined",
        ),
      );
      break;
    case "Skill":
      const skillContent = content as SkillToolUseMessageContent;
      steps.push(
        _renderStep(
          `Load skill "${skillContent.input.skill}"`,
          "file-link-mindnote_outlined",
        ),
      );
      break;
    case "ToolSearch":
      // Ignore ToolSearch for now
      //
      // const toolSearchContent = content as ToolSearchToolUseMessageContent;
      // steps.push(
      //   renderStep(
      //     `Search tools for "${toolSearchContent.input.query}"`,
      //     "search_outlined",
      //   ),
      // );
      break;
    default:
      steps.push(_renderStep(content.name, "setting-inter_outlined"));
  }
}

/** Create a step element (icon + text) for the collapsible panel. */
function _renderStep(text: string, iconToken: string): DivElement {
  return {
    tag: "div",
    icon: {
      tag: "standard_icon",
      token: iconToken,
      color: "grey",
    },
    text: {
      tag: "plain_text",
      text_color: "grey",
      text_size: "notation",
      content: text,
    },
  };
}

function _statusCardTemplate(
  status: string | undefined,
  state: "active" | "terminal" | undefined,
): Exclude<NonNullable<Card["header"]>["template"], undefined> {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "cancelled":
      return "grey";
    default:
      return state === "terminal" ? "green" : "blue";
  }
}

function _taskResultTemplate(
  status: string | undefined,
): Exclude<NonNullable<Card["header"]>["template"], undefined> {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "cancelled":
      return "grey";
    default:
      return "blue";
  }
}

function _cardHeaderSubtitle(input: {
  readonly title?: string;
  readonly summary?: string;
}): Pick<NonNullable<Card["header"]>, "subtitle"> | object {
  const summary = input.summary?.replace(/\s+/g, " ").trim();
  if (!summary || summary === input.title?.trim()) {
    return {};
  }
  return {
    subtitle: {
      tag: "plain_text" as const,
      content: summary,
    },
  };
}

const BATCH_SUMMARY_LINE_MAX_LENGTH = 240;

function _safeBatchSummaryLine(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return "（空消息）";
  }
  if (normalized.length <= BATCH_SUMMARY_LINE_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, BATCH_SUMMARY_LINE_MAX_LENGTH - 1)}…`;
}

function _cardSummary(text: string): string {
  const summary = text.replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

/**
 * Regex pattern for matching markdown tables.
 * Matches: header row, separator row, and one or more data rows.
 */
const MARKDOWN_TABLE_REGEX =
  /^\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*\n?)+/gm;

/**
 * Split markdown content into multiple chunks, each containing at most a specified
 * number of tables. Used to work around Feishu's limit of 5 table components per card.
 *
 * @param markdown - The markdown content to split.
 * @param maxTables - Maximum number of tables per chunk (default: 5).
 * @returns Array of markdown strings, each with at most maxTables tables.
 */
export function splitMarkdownByTables(
  markdown: string,
  maxTables: number = 5,
): string[] {
  const tables = markdown.match(MARKDOWN_TABLE_REGEX);
  if (!tables || tables.length <= maxTables) {
    return [markdown];
  }

  // Find all table positions in the markdown
  const tablePositions: Array<{ start: number; end: number; match: string }> =
    [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(MARKDOWN_TABLE_REGEX.source, "gm");
  while ((match = regex.exec(markdown)) !== null) {
    tablePositions.push({
      start: match.index,
      end: match.index + match[0].length,
      match: match[0],
    });
  }

  const chunks: string[] = [];
  let currentChunkStart = 0;
  let tablesInCurrentChunk = 0;

  for (let i = 0; i < tablePositions.length; i++) {
    const tablePos = tablePositions[i]!;
    tablesInCurrentChunk++;

    // If we've reached the max tables for this chunk, split here
    if (tablesInCurrentChunk >= maxTables && i < tablePositions.length - 1) {
      // End current chunk after this table
      const chunkEnd = tablePos.end;
      chunks.push(markdown.slice(currentChunkStart, chunkEnd).trim());

      // Start new chunk from the content after the current table
      currentChunkStart = chunkEnd;
      tablesInCurrentChunk = 0;
    }
  }

  // Add the remaining content as the last chunk
  const remainingContent = markdown.slice(currentChunkStart).trim();
  if (remainingContent) {
    chunks.push(remainingContent);
  }

  return chunks;
}


/**
 * Renders status card step strings (with embedded icons like ✅🔄⏸⛔)
 * into Feishu card DivElement array for display in a collapsible step panel.
 */
export function renderStatusCardSteps(steps: readonly string[]): DivElement[] {
  return steps.map((step) => _renderStep(step, "robot_outlined"));
}
