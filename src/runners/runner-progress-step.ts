import {
  extractTextContent,
  type AssistantMessage,
} from "@/shared";

export const DEFAULT_RUNNER_PROGRESS_STEP_MAX_LENGTH = 220;

/**
 * Converts one assistant event into a user-visible runner progress step.
 *
 * Provider adapters can place a tool description and its tool invocation in
 * the same event. Preserve that line structure so notification renderers do
 * not collapse distinct progress details onto one line.
 */
export function runnerProgressStepFromAssistant(
  event: AssistantMessage,
  options: { readonly maxLength?: number } = {},
): string | undefined {
  return normalizeRunnerProgressStep(
    extractTextContent(event, {
      includeThinking: true,
      includeToolUse: true,
    }),
    options,
  );
}

/**
 * Normalizes a runner-authored progress summary without discarding semantic
 * line breaks.
 */
export function normalizeRunnerProgressStep(
  summary: string,
  options: { readonly maxLength?: number } = {},
): string | undefined {
  const normalized = summary
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.trim().replace(/[^\S\n]+/gu, " "))
    .filter((line) => line.length > 0)
    .join("\n");
  if (normalized.length === 0) {
    return undefined;
  }

  const maxLength =
    options.maxLength ?? DEFAULT_RUNNER_PROGRESS_STEP_MAX_LENGTH;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
