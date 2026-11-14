import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag } from "@luna/cli-support/options";
import { mcpHelpText, mcpSubcommandHelpText } from "@luna/cli-support/help";
import { loadKnowledgeConfig } from "@luna/service-client/config";
import { createWorkspaceClient } from "@luna/service-client/workspace-client";

export async function runMcpCli(argv: string[], env: Env): Promise<CliResult> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    const requested = subcommand === "help" ? rest[0] : subcommand;
    if (requested && requested !== "help" && !requested.startsWith("-")) {
      const subcommandHelp = mcpSubcommandHelpText(requested);
      if (subcommandHelp) {
        return { status: "ok", output: subcommandHelp };
      }
    }
    return { status: "ok", output: mcpHelpText() };
  }
  if (subcommand === "bridge") {
    const config = loadKnowledgeConfig(rest, env);
    if (hasFlag(rest, "--dry-run")) {
      return {
        status: "ok",
        output: JSON.stringify({
          command: "mcp bridge",
          serviceUrl: config.serviceUrl,
          agentId: config.agentId,
          mode: "stdio",
          transport: "stdio"
        })
      };
    }
    if (hasFlag(rest, "--stdio")) {
      return {
        status: "error",
        code: "mcp_bridge_stdio_requires_executable",
        message: "mcp bridge --stdio is a long-running stdio process; run the luna executable or pass --dry-run"
      };
    }
    return {
      status: "error",
      code: "mcp_bridge_requires_stdio",
      message: "mcp bridge requires --stdio; HTTP MCP is served by Luna Service /mcp"
    };
  }

  return {
    status: "error",
    code: "unknown_mcp_command",
    message: `unknown mcp command: ${subcommand ?? ""}`.trim()
  };
}

export async function startMcpStdioBridge(argv: readonly string[], env: Env = process.env): Promise<void> {
  const config = loadKnowledgeConfig(argv, env);
  const workspaceClient = createWorkspaceClient(config);
  const { connectKnowledgeMcpStdio } = await import(
    "../../mcp/knowledge-server"
  );
  await connectKnowledgeMcpStdio(workspaceClient);
}
