export function helpText(): string {
  return [
    "Luna agent workflow CLI",
    "",
    "Usage:",
    "  luna auth <command>",
    "  luna knowledge <command>",
    "  luna workspace <workspace-id> <command>",
    "  luna service start",
    "  luna artifacts materialize artifact:<id>",
    "  luna artifacts download artifact:<id> --output <path>",
    "  luna artifacts register <path>",
    "  luna mcp bridge --stdio",
    "  luna version",
    "",
    "Commands:",
    "  auth               Authenticate Luna CLI",
    "  knowledge          Query and administer Luna knowledge",
    "  workspace          Read and write managed Luna workspaces",
    "  agent              Start the Luna agent runtime",
    "  artifacts          Register, materialize, and download Luna artifacts",
    "  mcp                Run local Luna MCP bridges",
    "  version            Print CLI version",
    "",
    "Plugin commands are resolved by the Luna Service. Use the Dashboard Plugin Marketplace to enable commands."
  ].join("\n");
}

export function versionHelpText(): string {
  return ["Usage:", "  luna version", "", "Print CLI version."].join("\n");
}

export function authHelpText(): string {
  return [
    "Luna auth CLI",
    "",
    "Usage:",
    "  luna auth login",
    "  luna auth status",
    "  luna auth logout",
    "",
    "Commands:",
    "  login              Authorize this CLI with Luna Service",
    "  status             Show current authentication status",
    "  logout             Revoke and delete stored CLI credentials",
  ].join("\n");
}

export function authSubcommandHelpText(
  subcommand: string,
): string | undefined {
  if (subcommand === "login") {
    return [
      "Usage:",
      "  luna auth login",
      "",
      "Authorize this CLI with Luna Service.",
    ].join("\n");
  }
  if (subcommand === "status") {
    return [
      "Usage:",
      "  luna auth status",
      "",
      "Show current authentication status.",
    ].join("\n");
  }
  if (subcommand === "logout") {
    return [
      "Usage:",
      "  luna auth logout",
      "",
      "Revoke and delete stored CLI credentials.",
    ].join("\n");
  }
  return undefined;
}

export function artifactsHelpText(): string {
  return [
    "Luna artifacts CLI",
    "",
    "Usage:",
    "  luna artifacts materialize artifact:<id> [--output-dir <dir>] [--json]",
    "  luna artifacts download artifact:<id> --output <path>",
    "  luna artifacts register <path> [--scope-type <type>] [--scope-id <id>] [--kind <kind>] [--name <name>] [--json]",
    "  luna artifacts cat artifact:<id>",
    "",
    "Commands:",
    "  materialize        Download an artifact into the Luna local artifact cache",
    "  download           Download an artifact to an explicit output path",
    "  register           Upload a local file as a Luna artifact",
    "  cat                Print artifact text content to stdout",
  ].join("\n");
}

export function artifactsSubcommandHelpText(
  subcommand: string,
): string | undefined {
  if (subcommand === "materialize") {
    return [
      "Usage:",
      "  luna artifacts materialize artifact:<id> [--output-dir <dir>] [--json]",
      "",
      "Download an artifact into the Luna local artifact cache.",
    ].join("\n");
  }
  if (subcommand === "download") {
    return [
      "Usage:",
      "  luna artifacts download artifact:<id> --output <path>",
      "",
      "Download an artifact to an explicit output path.",
    ].join("\n");
  }
  if (subcommand === "register") {
    return [
      "Usage:",
      "  luna artifacts register <path> [--scope-type <type>] [--scope-id <id>] [--kind <kind>] [--name <name>] [--json]",
      "",
      "Upload a local file as a Luna artifact.",
    ].join("\n");
  }
  if (subcommand === "cat") {
    return [
      "Usage:",
      "  luna artifacts cat artifact:<id>",
      "",
      "Print artifact text content to stdout.",
    ].join("\n");
  }
  return undefined;
}

export function mcpHelpText(): string {
  return [
    "Luna MCP CLI",
    "",
    "Usage:",
    "  luna mcp bridge --stdio [--dry-run]",
    "",
    "Commands:",
    "  bridge             Run the local stdio MCP bridge",
  ].join("\n");
}

export function mcpSubcommandHelpText(
  subcommand: string,
): string | undefined {
  if (subcommand === "bridge") {
    return [
      "Usage:",
      "  luna service mcp bridge --stdio [--agent-id <id>] [--dry-run]",
      "",
      "Run the local stdio MCP bridge.",
      "Select an Agent with --agent-id or LUNA_AGENT_ID when using a personal token.",
    ].join("\n");
  }
  return undefined;
}

export function workspaceHelpText(workspaceId = "<workspace-id>"): string {
  return [
    "Luna workspace CLI",
    "",
    "Usage:",
    `  luna workspace ${workspaceId} glob <pattern>`,
    `  luna workspace ${workspaceId} grep <query> [--glob <pattern>]`,
    `  luna workspace ${workspaceId} read <path>`,
    `  luna workspace ${workspaceId} write <path> --body <content>`,
    `  luna workspace ${workspaceId} write <path> --body-file <file>`,
    `  luna workspace ${workspaceId} git-status`,
    `  luna workspace ${workspaceId} git-diff`,
    `  luna workspace ${workspaceId} git-commit --message <message>`,
    "",
    "For the knowledge workspace, select an Agent with --agent-id <id> or LUNA_AGENT_ID.",
    "",
    "Examples:",
    "  luna workspace knowledge glob \"wiki/**/*.md\"",
    "  luna workspace knowledge read wiki/domains/playback.md",
    "  luna workspace knowledge write wiki/domains/playback.md --body-file /tmp/playback.md",
    "  luna workspace knowledge git-commit --message \"docs: update playback\""
  ].join("\n");
}

export function workspaceSubcommandHelpText(workspaceId: string, subcommand: string): string | undefined {
  if (subcommand === "glob") {
    return ["Usage:", `  luna workspace ${workspaceId} glob <pattern>`, "", "List files in a managed Luna workspace."].join("\n");
  }
  if (subcommand === "grep") {
    return [
      "Usage:",
      `  luna workspace ${workspaceId} grep <query> [--glob <pattern>]`,
      "",
      "Search text in a managed Luna workspace.",
      "Default --glob is **/*."
    ].join("\n");
  }
  if (subcommand === "read") {
    return ["Usage:", `  luna workspace ${workspaceId} read <path>`, "", "Read a file from a managed Luna workspace."].join("\n");
  }
  if (subcommand === "write") {
    return [
      "Usage:",
      `  luna workspace ${workspaceId} write <path> --body <content>`,
      `  luna workspace ${workspaceId} write <path> --body-file <file>`,
      "",
      "Write a file in a managed Luna workspace.",
      "write does not commit; use git-commit explicitly."
    ].join("\n");
  }
  if (subcommand === "git-status") {
    return ["Usage:", `  luna workspace ${workspaceId} git-status`, "", "Show workspace git status."].join("\n");
  }
  if (subcommand === "git-diff") {
    return ["Usage:", `  luna workspace ${workspaceId} git-diff`, "", "Show workspace git diff."].join("\n");
  }
  if (subcommand === "git-commit") {
    return ["Usage:", `  luna workspace ${workspaceId} git-commit --message <message>`, "", "Commit workspace changes explicitly."].join("\n");
  }
  return undefined;
}

export function knowledgeHelpText(): string {
  return [
    "Luna knowledge CLI",
    "",
    "Usage:",
    "  luna knowledge read <path>",
    "  luna knowledge glob <pattern>",
    "  luna knowledge grep <query> [--glob <pattern>]",
    "  luna knowledge write <path> --body <content>",
    "  luna knowledge write <path> --body-file <file>",
    "  luna knowledge git-status",
    "  luna knowledge git-diff",
    "  luna knowledge git-commit --message <message>",
    "",
    "Select an Agent with --agent-id <id> or LUNA_AGENT_ID when using a personal token.",
    "",
    "Commands:",
    "  read               Read a file from the managed knowledge workspace",
    "  glob               List files in the managed knowledge workspace",
    "  grep               Search text in the managed knowledge workspace",
    "  write              Write a workspace file; write does not commit",
    "  git-status         Show workspace git status",
    "  git-diff           Show workspace git diff",
    "  git-commit         Commit workspace changes explicitly"
  ].join("\n");
}

export function knowledgeSubcommandHelpText(subcommand: string, nested?: string): string | undefined {
  if (subcommand === "read") {
    return ["Usage:", "  luna knowledge read <path>", "", "Read a file from the managed knowledge workspace."].join("\n");
  }
  if (subcommand === "glob") {
    return ["Usage:", "  luna knowledge glob <pattern>", "", "List files in the managed knowledge workspace."].join("\n");
  }
  if (subcommand === "grep") {
    return [
      "Usage:",
      "  luna knowledge grep <query> [--glob <pattern>]",
      "",
      "Search text in the managed knowledge workspace.",
      "Default --glob is **/*."
    ].join("\n");
  }
  if (subcommand === "write") {
    return [
      "Usage:",
      "  luna knowledge write <path> --body <content>",
      "  luna knowledge write <path> --body-file <file>",
      "",
      "Write a file in the managed knowledge workspace.",
      "write does not commit; use luna knowledge git-commit --message <message>."
    ].join("\n");
  }
  if (subcommand === "git-status") {
    return ["Usage:", "  luna knowledge git-status", "", "Show git status for the managed knowledge workspace."].join("\n");
  }
  if (subcommand === "git-diff") {
    return ["Usage:", "  luna knowledge git-diff", "", "Show git diff for the managed knowledge workspace."].join("\n");
  }
  if (subcommand === "git-commit") {
    return [
      "Usage:",
      "  luna knowledge git-commit --message <message>",
      "",
      "Commit managed knowledge workspace changes explicitly."
    ].join("\n");
  }
  return undefined;
}
