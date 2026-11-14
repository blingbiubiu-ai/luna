import { claudeContainerRunnerProvider } from "./claude";
import { codexContainerRunnerProvider } from "./codex";
import type { ContainerRunnerProvider } from "./types";

export function resolveContainerRunnerProvider(
  runnerType: string,
): ContainerRunnerProvider {
  if (runnerType.includes("claude")) {
    return claudeContainerRunnerProvider;
  }
  if (runnerType === "codex") {
    return codexContainerRunnerProvider;
  }
  throw new Error(`Unsupported container runner type: ${runnerType}`);
}

export type {
  ContainerRunnerProvider,
  ParsedRunnerLine,
  RunnerFailure,
  RunnerFailureKind,
} from "./types";
