import { mkdirSync, writeFileSync } from "node:fs";

import {
  standardRunnerArtifactPaths,
  type RunnerAdapter,
  type RunnerExecution,
  type RunnerExecutionResult,
  type RunnerPayload,
  type RunnerRunInput,
} from "@/runners/types";

/**
 * Configuration options for fake/mock runner adapter behavior.
 */
export interface FakeRunnerAdapterOptions {
  readonly runnerType?: string;
}

/**
 * Provides a deterministic fake/mock runner adapter for tests and local simulations.
 */
export class FakeRunnerAdapter<TPayload extends RunnerPayload = RunnerPayload>
  implements RunnerAdapter<TPayload>
{
  readonly runnerType: string;

  constructor(options: FakeRunnerAdapterOptions = {}) {
    this.runnerType = options.runnerType ?? "mock";
  }

  buildRun(input: RunnerRunInput<TPayload>): RunnerExecution<TPayload> {
    const artifactPaths =
      input.artifactPaths ?? standardRunnerArtifactPaths(input.workspacePath);
    return {
      runnerType: this.runnerType,
      taskId: input.taskId,
      mode: input.mode,
      workspacePath: input.workspacePath,
      runnerRootPath: input.runnerRootPath,
      artifactPaths,
      payload: {
        ...input.payload,
        runnerType: this.runnerType,
      },
      command: {
        executable: "fake-runner",
        args: [],
        cwd: input.workspacePath,
        env: {
          RUNNER_HOME: input.runnerRootPath,
        },
      },
      execute: () => this._execute({ ...input, artifactPaths }),
    };
  }

  private _execute(input: RunnerRunInput<TPayload>): RunnerExecutionResult {
    const artifactPaths =
      input.artifactPaths ?? standardRunnerArtifactPaths(input.workspacePath);
    mkdirSync(input.workspacePath, { recursive: true });
    mkdirSync(input.runnerRootPath, { recursive: true });
    mkdirSync(artifactPaths.artifactsDir, { recursive: true });

    const events = [
      {
        type: "runner.started" as const,
        summary: `Started ${this.runnerType} runner.`,
        data: {
          taskId: input.taskId,
          mode: input.mode,
          runnerType: this.runnerType,
        },
      },
      {
        type: "runner.completed" as const,
        summary: `Completed ${this.runnerType} runner.`,
        data: {
          taskId: input.taskId,
          mode: input.mode,
          runnerType: this.runnerType,
        },
      },
    ];
    const eventRows = events.map((event) =>
      JSON.stringify({
        type: event.type,
        taskId: input.taskId,
        mode: input.mode,
        runnerType: this.runnerType,
      }),
    );

    const eventsPath = artifactPaths.eventsJsonl;
    const reportPath = artifactPaths.finalReport;
    const stdoutPath = artifactPaths.stdoutLog;
    const stderrPath = artifactPaths.stderrLog;

    writeFileSync(eventsPath, `${eventRows.join("\n")}\n`, "utf-8");
    writeFileSync(stdoutPath, "Fake runner completed.\n", "utf-8");
    writeFileSync(
      reportPath,
      [
        "# Fake runner report",
        "",
        `Task: ${input.taskId}`,
        `Mode: ${input.mode}`,
        `Runner: ${this.runnerType}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(stderrPath, "", "utf-8");

    return {
      exitCode: 0,
      events,
      artifacts: [
        {
          name: "runner-events.jsonl",
          path: eventsPath,
          type: "runner_events",
          mimeType: "application/x-ndjson",
          status: "active",
        },
        {
          name: "runner-stdout.log",
          path: stdoutPath,
          type: "runner_stdout",
          mimeType: "text/plain",
          status: "active",
        },
        {
          name: "runner-stderr.log",
          path: stderrPath,
          type: "runner_stderr",
          mimeType: "text/plain",
          status: "active",
        },
        {
          name: "final-report.md",
          path: reportPath,
          type: "report",
          mimeType: "text/markdown",
          status: "active",
        },
      ],
    };
  }
}
