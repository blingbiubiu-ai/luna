import { buildChildEnvironment } from "../job-env";
import { prepareRunnerEnvironment } from "./runner-environment";
import { runQuery } from "../runner";
import { runPtyQuery } from "../pty/pty-main";
import { writeOutput } from "../protocol";
import type { ContainerInput } from "../types";

/** Runs after setpriv, with no Executor control credentials in its environment. */
async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as ContainerInput;
  const env = prepareRunnerEnvironment(buildChildEnvironment(process.env, input.env));
  const preparedInput = { ...input, env: env as Record<string, string> };
  if (input.executionDriver === "pty") {
    await runPtyQuery(preparedInput, input.sessionId);
    return;
  }
  await runQuery(preparedInput, input.sessionId);
}
if (import.meta.main) {
  main().catch(() => { writeOutput({ status: "error", error: "Runner process failed" }); process.exitCode = 1; });
}
