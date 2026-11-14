/**
 * Represents runner mode values used by fake/mock runner execution doubles.
 */
export type RunnerMode = "run" | "resume";

/**
 * Payload shape used by fake/mock runner execution messages or tasks.
 */
export type RunnerPayload = Record<string, unknown>;

/**
 * Represents runner payload-with-type values used by fake/mock execution.
 */
export type RunnerPayloadWithType<TPayload extends RunnerPayload> = TPayload & {
  readonly runnerType: string;
};

/**
 * Describes the runner command contract used by fake/mock execution doubles.
 */
export interface RunnerCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/**
 * Describes artifact paths used by fake/mock runner execution doubles.
 */
export interface RunnerArtifactPaths {
  readonly eventsJsonl: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
  readonly finalReport: string;
  readonly diffPatch: string;
  readonly artifactsDir: string;
}

/**
 * Builds the standard artifact file paths used by fake/mock runner executions.
 */
export function standardRunnerArtifactPaths(
  workspacePath: string,
): RunnerArtifactPaths {
  return {
    eventsJsonl: `${workspacePath}/runner-events.jsonl`,
    stdoutLog: `${workspacePath}/runner-stdout.log`,
    stderrLog: `${workspacePath}/runner-stderr.log`,
    finalReport: `${workspacePath}/final-report.md`,
    diffPatch: `${workspacePath}/diff.patch`,
    artifactsDir: `${workspacePath}/artifacts`,
  };
}

/**
 * Input contract for fake/mock runner execution doubles.
 */
export interface RunnerRunInput<TPayload extends RunnerPayload = RunnerPayload> {
  readonly taskId: string;
  readonly mode: RunnerMode;
  readonly workspacePath: string;
  readonly runnerRootPath: string;
  readonly artifactPaths?: RunnerArtifactPaths;
  readonly payload: TPayload;
}

/**
 * Describes artifact metadata returned by fake/mock runner execution doubles.
 */
export interface RunnerArtifact {
  readonly name: string;
  readonly path: string;
  readonly type: string;
  readonly mimeType?: string;
  readonly status?: "active" | "archived" | "pruned";
  readonly content?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Describes timeline events returned by fake/mock runner execution doubles.
 */
export interface RunnerTimelineEvent {
  readonly type: `runner.${string}`;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Result contract returned by fake/mock runner execution doubles.
 */
export interface RunnerExecutionResult {
  readonly exitCode: number;
  readonly artifacts: readonly RunnerArtifact[];
  readonly events: readonly RunnerTimelineEvent[];
}

/**
 * Describes the execution contract used by fake/mock runner execution doubles.
 */
export interface RunnerExecution<
  TPayload extends RunnerPayload = RunnerPayload,
> {
  readonly runnerType: string;
  readonly taskId: string;
  readonly mode: RunnerMode;
  readonly workspacePath: string;
  readonly runnerRootPath: string;
  readonly artifactPaths?: RunnerArtifactPaths;
  readonly payload: RunnerPayloadWithType<TPayload>;
  readonly command: RunnerCommand;
  execute?(): Promise<RunnerExecutionResult> | RunnerExecutionResult;
}

/**
 * Describes the adapter contract used by fake/mock runner execution doubles.
 */
export interface RunnerAdapter<
  TPayload extends RunnerPayload = RunnerPayload,
> {
  readonly runnerType: string;

  buildRun(input: RunnerRunInput<TPayload>): RunnerExecution<TPayload>;
}
