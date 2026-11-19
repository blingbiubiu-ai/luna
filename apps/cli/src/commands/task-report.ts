import type { CliResult, Env } from "@luna/cli-support/types";
import { readOption } from "@luna/cli-support/options";
import { callUnifiedService } from "@luna/cli-support/service-client";

export async function runTaskReportCli(argv: readonly string[], env: Env): Promise<CliResult> {
  if (argv[0] === "status" && argv[1]) return callUnifiedService(env, {method: "GET", path: `/api/runner/task-reports/${encodeURIComponent(argv[1])}`});
  const key = readOption(argv, "--request-id");
  const inline = readOption(argv, "--text");
  const stdin = argv.includes("--stdin");
  if (!key || (inline !== undefined) === stdin)
    return {status: "error", code: "invalid_report", message: "Use luna task report --request-id ID [--waiting] with exactly one of --stdin or --text REPORT"};
  const content = inline ?? await Bun.stdin.text();
  if (!content.trim()) return {status: "error", code: "invalid_report", message: "Report must not be empty"};
  return callUnifiedService(env, {method: "POST", path: "/api/runner/task-reports", idempotencyKey: key,
    body: {content, ...(argv.includes("--waiting") ? {waiting: true} : {})}});
}
