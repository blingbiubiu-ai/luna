import type { CliResult, Env } from "@luna/cli-support/types";
import { KNOWLEDGE_WORKSPACE_ID } from "@luna/service-client/knowledge";
import { knowledgeHelpText, knowledgeSubcommandHelpText } from "@luna/cli-support/help";
import { hasFlag } from "@luna/cli-support/options";
import { runServiceWorkspaceCli } from "./workspace";

export async function runKnowledgeCli(argv: string[], env: Env): Promise<CliResult> {
  const [subcommand, nested] = argv;
  if (!subcommand || subcommand === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    if (subcommand && subcommand !== "help") {
      const subcommandHelp = knowledgeSubcommandHelpText(subcommand, nested);
      if (subcommandHelp) {
        return { status: "ok", output: subcommandHelp };
      }
    }
    return { status: "ok", output: knowledgeHelpText() };
  }

  return runServiceKnowledgeCli(argv, env);
}

export async function runServiceKnowledgeCli(argv: readonly string[], env: Env): Promise<CliResult> {
  const [subcommand] = argv;
  try {
    if (subcommand === "read") {
      return runServiceWorkspaceCli(KNOWLEDGE_WORKSPACE_ID, argv, env, "luna knowledge");
    }
    if (subcommand === "glob") {
      return runServiceWorkspaceCli(KNOWLEDGE_WORKSPACE_ID, argv, env, "luna knowledge");
    }
    if (subcommand === "grep") {
      return runServiceWorkspaceCli(KNOWLEDGE_WORKSPACE_ID, argv, env, "luna knowledge");
    }
    if (subcommand === "write") {
      return runServiceWorkspaceCli(KNOWLEDGE_WORKSPACE_ID, argv, env, "luna knowledge");
    }
    if (subcommand === "git-status") {
      return runServiceWorkspaceCli(KNOWLEDGE_WORKSPACE_ID, argv, env, "luna knowledge");
    }
    if (subcommand === "git-diff") {
      return runServiceWorkspaceCli(KNOWLEDGE_WORKSPACE_ID, argv, env, "luna knowledge");
    }
    if (subcommand === "git-commit") {
      return runServiceWorkspaceCli(KNOWLEDGE_WORKSPACE_ID, argv, env, "luna knowledge");
    }
    return { status: "error", code: "unknown_knowledge_command", message: `unknown knowledge command: ${subcommand}` };
  } catch (error) {
    return { status: "error", code: "knowledge_command_failed", message: (error as Error).message };
  }
}
