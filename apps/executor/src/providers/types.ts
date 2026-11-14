import type { ContainerInput } from "../types";

export type PublicRunnerEvent =
  | {kind: "text"; text: string}
  | {kind: "tool_start"; id: string; name: string; title: string}
  | {kind: "tool_result"; id: string; text: string};

export type ParsedRunnerLine =
  | { kind: "complete"; finalText?: string }
  | {kind: "events"; events: PublicRunnerEvent[]}
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "checkpoint" }
  | { kind: "error"; message: string; code?: string };

import type { RunnerFailure } from "@luna/runner-protocol/failure";
export type { RunnerFailure, RunnerFailureKind } from "@luna/runner-protocol/failure";

export interface ContainerRunnerProvider {
  readonly family: "claude" | "codex";
  buildCliArgs(input: ContainerInput, sessionId?: string): string[];
  parseStreamLine(line: string): ParsedRunnerLine | null;
  normalizeFailure(message: string): RunnerFailure;
  normalizeErrorCode(message: string): string | undefined;
  writesPromptToStdin(): boolean;
}
