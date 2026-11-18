import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import { callUnifiedService, servicePathWithQuery } from "@luna/cli-support/service-client";

/** Domain commands pass domain payloads unchanged; there is no action translation. */
export async function runRunnerOperationsCli(scope: "task" | "session", argv: readonly string[], env: Env): Promise<CliResult> {
  const command = argv[0];
  if (!command || command === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return {status: "ok", output: scope === "task"
      ? "luna task list [--agent-id ID | --session-id ID] | get --task-id ID | create|update|restart|cancel|status-card|report|status"
      : "luna session messages|read_session_timeline --session-id ID | create-thread|clarify|release|status"};
  }
  try {
    if (scope === "task" && command === "list" && argv.includes("--session-id")) {
      const sessionId = readOption(argv, "--session-id")?.trim() || env.LUNA_SESSION_ID?.trim();
      if (!sessionId) return {status: "error", code: "missing_session_id", message: "missing --session-id"};
      return callUnifiedService(env, {method: "GET", path: servicePathWithQuery("/api/tasks", {sessionId})});
    }
    if (scope === "task" && command === "list") {
      const agentId = (readOption(argv, "--agent-id") ?? env.LUNA_AGENT_ID)?.trim();
      if (!agentId) return {status: "error", code: "agent_scope_required", message: "Use --agent-id or set LUNA_AGENT_ID"};
      return callUnifiedService(env, {method: "GET", path: servicePathWithQuery("/api/tasks", {agentId})});
    }
    if (scope === "task" && command === "get") {
      const taskId = readOption(argv, "--task-id");
      if (!taskId) return {status: "error", code: "missing_task_id", message: "missing --task-id"};
      return callUnifiedService(env, {method: "GET", path: `/api/tasks/${encodeURIComponent(taskId)}`});
    }
    if (scope === "session" && (command === "messages" || command === "read_session_timeline")) {
      const sessionId = readOption(argv, "--session-id");
      if (!sessionId) return {status: "error", code: "missing_session_id", message: "missing --session-id"};
      const path = `/api/sessions/${encodeURIComponent(sessionId)}`;
      return callUnifiedService(env, {method: "GET", path: command === "messages" ? path + "/messages"
        : servicePathWithQuery(path + "/timeline/read", {
          beforeEntryId: readOption(argv, "--before-entry-id"),
          afterEntryId: readOption(argv, "--after-entry-id"),
          limit: readOption(argv, "--limit"),
          includeReferences: readOption(argv, "--include-references"),
        })});
    }
  } catch (error) {
    return {status: "error", code: "invalid_query", message: error instanceof Error ? error.message : String(error)};
  }
  if (command === "status" && argv[1]) return callUnifiedService(env, {method: "GET", path: `/api/runner/operations/${encodeURIComponent(argv[1])}`});
  if (scope === "task" && command === "status-card" && readOption(argv, "--task-id")) {
    const requestId = readOption(argv, "--request-id");
    if (!requestId || readOption(argv, "--json") !== undefined || argv.includes("--stdin"))
      return {status: "error", code: "invalid_operation", message: "Use --task-id TASK_ID --request-id ID [--resend] [--style card|native], without JSON/stdin"};
    return callUnifiedService(env, {method: "POST", path: "/api/runner/tasks/status-card", idempotencyKey: requestId,
      body: {taskId: readOption(argv, "--task-id")!, resend: argv.includes("--resend"), ...(readOption(argv, "--style") ? {style: readOption(argv, "--style")} : {})}});
  }
  if (!(scope === "task" ? ["create", "update", "restart", "cancel", "status-card"] : ["create-thread", "clarify", "release"]).includes(command ?? ""))
    return {status: "error", code: "invalid_operation", message: scope === "task" ? "Use luna task create|update|restart|cancel|status-card|status" : "Use luna session create-thread|clarify|release|status"};
  const key = readOption(argv, "--request-id");
  const createThread = scope === "session" && command === "create-thread";
  const jsonIndex = argv.indexOf("--json");
  const jsonValue = argv[jsonIndex + 1];
  if (createThread && jsonIndex !== -1 && argv.includes("--stdin") &&
      (jsonValue === undefined || jsonValue.startsWith("--"))) {
    argv = argv.filter(flag => flag !== "--json");
  }
  const inline = readOption(argv, "--json");
  const stdin = argv.includes("--stdin");
  if ((!key && !createThread) || (inline !== undefined && stdin) || (!createThread && inline === undefined && !stdin))
    return {status: "error", code: "invalid_operation", message: "Use --request-id and exactly one of --stdin or --json <JSON>"};
  try {
    const body: unknown = JSON.parse(stdin ? await Bun.stdin.text() : inline ?? "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
    if (readOption(argv, "--style")) {
      if (scope !== "task" || command !== "status-card") throw new Error("--style is only valid for tasks status-card");
      (body as Record<string, unknown>).style = readOption(argv, "--style");
    }
    if (argv.includes("--resend")) {
      if (scope !== "task" || command !== "status-card") throw new Error("--resend is only valid for tasks status-card");
      (body as Record<string, unknown>).resend = true;
    }
    return await callUnifiedService(env, {method: "POST", path: `/api/runner/${scope === "task" ? "tasks" : "session"}/${command}`, idempotencyKey: key ?? crypto.randomUUID(), body: body as Record<string, unknown>});
  } catch (error) {return {status: "error", code: "operation_failed", message: String(error)};}
}
