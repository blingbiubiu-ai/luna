import type { CliResult, Env } from "@luna/cli-support/types";
import { workspaceHelpText, workspaceSubcommandHelpText } from "@luna/cli-support/help";
import { hasFlag, readOption, readPositional, readRequiredOption, workspaceWriteBody } from "@luna/cli-support/options";
import { callUnifiedService, queryString } from "@luna/cli-support/service-client";
import { KNOWLEDGE_WORKSPACE_ID } from "@luna/service-client/knowledge";

export async function runWorkspaceCli(argv: readonly string[], env: Env): Promise<CliResult> {
  const [workspaceId, subcommand] = argv;
  if (!workspaceId || workspaceId === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    if (workspaceId && workspaceId !== "help" && !workspaceId.startsWith("-") && subcommand) {
      const subcommandHelp = workspaceSubcommandHelpText(workspaceId, subcommand);
      if (subcommandHelp) {
        return { status: "ok", output: subcommandHelp };
      }
    }
    return {
      status: "ok",
      output: workspaceHelpText(workspaceId && workspaceId !== "help" && !workspaceId.startsWith("-") ? workspaceId : undefined),
    };
  }
  return runServiceWorkspaceCli(workspaceId, argv.slice(1), env, `luna workspace ${workspaceId}`);
}

export async function runServiceWorkspaceCli(
  workspaceId: string,
  argv: readonly string[],
  env: Env,
  commandLabel: string,
): Promise<CliResult> {
  const [subcommand] = argv;
  try {
    const agentId = workspaceId === KNOWLEDGE_WORKSPACE_ID
      ? readOption(argv, "--agent-id") ?? env.LUNA_AGENT_ID
      : undefined;
    const workspacePath = (operation: string, parameters: Record<string, string> = {}) => {
      const query = queryString({ ...(agentId ? { agentId } : {}), ...parameters });
      return `/api/workspaces/${encodeURIComponent(workspaceId)}/${operation}${query ? `?${query}` : ""}`;
    };
    if (subcommand === "read") {
      const path = readPositional(argv, 1, "path");
      return callUnifiedService(env, {
        method: "GET",
        path: workspacePath("file", { path }),
      });
    }
    if (subcommand === "glob") {
      const pattern = readPositional(argv, 1, "pattern");
      return callUnifiedService(env, {
        method: "GET",
        path: workspacePath("glob", { pattern }),
      });
    }
    if (subcommand === "grep") {
      const query = readPositional(argv, 1, "query");
      return callUnifiedService(env, {
        method: "GET",
        path: workspacePath("grep", { query, glob: readOption(argv, "--glob") ?? "**/*" }),
      });
    }
    if (subcommand === "write") {
      const path = readPositional(argv, 1, "path");
      return callUnifiedService(env, {
        method: "PUT",
        path: workspacePath("file"),
        body: workspaceWriteBody(path, argv, commandLabel),
      });
    }
    if (subcommand === "git-status") {
      return callUnifiedService(env, {
        method: "GET",
        path: workspacePath("git/status"),
      });
    }
    if (subcommand === "git-diff") {
      return callUnifiedService(env, {
        method: "GET",
        path: workspacePath("git/diff"),
      });
    }
    if (subcommand === "git-commit") {
      return callUnifiedService(env, {
        method: "POST",
        path: workspacePath("git/commit"),
        body: { message: readRequiredOption(argv, "--message") },
      });
    }
    return {
      status: "error",
      code: "unknown_workspace_command",
      message: `unknown workspace command: ${workspaceId} ${subcommand ?? ""}`.trim(),
    };
  } catch (error) {
    return { status: "error", code: "workspace_command_failed", message: (error as Error).message };
  }
}
