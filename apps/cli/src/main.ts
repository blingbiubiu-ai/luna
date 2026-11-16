#!/usr/bin/env bun
import { runDeployment } from "./deployment";
import { runTaskReportCli } from "./commands/task-report";
import { runGroupsCli } from "./commands/groups";
import { runUsersCli } from "./commands/users";

import type { CliResult, Env, NormalizedCliInput } from "@luna/cli-support/types";
import { versionHelpText } from "@luna/cli-support/help";
import { loadDefaultLunaEnv } from "@luna/cli-support/env";
import { hasFlag } from "@luna/cli-support/options";
import { runSchedulesCli } from "./commands/schedules";
import { runRunnerOperationsCli } from "./commands/runner-operations";
import { runMessagesCli } from "./commands/messages";
import { runMemoryCli } from "./commands/memory";
import { runAuthCli } from "./commands/auth";
import { runKnowledgeCli } from "./commands/knowledge";
import { runWorkspaceCli } from "./commands/workspace";
import { runArtifactsCli } from "./commands/artifacts";
import {
  pluginCommandsHelpText,
  runPluginCommandCli,
} from "./commands/plugin-command";

export { loadDefaultLunaEnv } from "@luna/cli-support/env";

export async function runClientCli(
  argv: string[],
  env: Env = process.env,
): Promise<CliResult> {
  let normalized: NormalizedCliInput;
  try {
    normalized = applyGlobalAuthOptions(argv, env);
  } catch (error) {
    return {
      status: "error",
      code: "invalid_global_option",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const [command, ...rest] = normalized.argv;
  env = normalized.env;
  if (!command || command === "--help" || command === "-h") {
    return { status: "ok", output: await clientHelpTextWithPlugins(env) };
  }
  if (command === "service" || command === "worker") {
    try {
      const result = await runDeployment(command, rest, env);
      return { status: result.exitCode === 0 ? "ok" : "error", output: result.stdout || result.stderr };
    } catch (error) {
      return { status: "error", code: "component_unavailable", message: String(error) };
    }
  }
  if (command === "version") {
    if (rest[0] === "help" || hasFlag(rest, "--help") || hasFlag(rest, "-h")) {
      return { status: "ok", output: versionHelpText() };
    }
    return { status: "ok", output: "0.1.0" };
  }
  if (command === "schedules") return runSchedulesCli(rest, env);
  if (command === "groups") return runGroupsCli(rest, env);
  if (command === "users") return runUsersCli(rest, env);
  if (command === "task" && rest[0] === "report") return runTaskReportCli(rest.slice(1), env);
  if (command === "task" || command === "session") return runRunnerOperationsCli(command, rest, env);
  if (command === "messages") return runMessagesCli(rest, env);
  if (command === "memory") return runMemoryCli(rest, env);
  if (command === "auth") {
    return runAuthCli(rest, env);
  }
  if (command === "knowledge") {
    return runKnowledgeCli(rest, env);
  }
  if (command === "workspace") {
    return runWorkspaceCli(rest, env);
  }
  if (command === "artifacts") {
    return runArtifactsCli(rest, env);
  }
  const pluginCommandResult = await runPluginCommandCli(normalized.argv, env);
  if (pluginCommandResult !== undefined) {
    return pluginCommandResult;
  }
  return {
    status: "error",
    code: "unknown_command",
    message: `unknown command: ${command}`,
  };
}

async function clientHelpTextWithPlugins(env: Env): Promise<string> {
  const pluginHelp = await pluginCommandsHelpText(env);
  return pluginHelp === undefined ? clientHelpText() : `${clientHelpText()}\n\n${pluginHelp}`;
}

function clientHelpText(): string {
  return [
    "Luna CLI",
    "",
    "Usage:",
    "  luna service <command>",
    "  luna worker <command>",
    "  luna auth <command>",
    "  luna knowledge <command>",
    "  luna workspace <workspace-id> <command>",
    "  luna task list [--agent-id <id>] | get --task-id <id>",
    "  luna session messages|read_session_timeline --session-id <id>",
    "  luna artifacts materialize artifact:<id>",
    "  luna artifacts download artifact:<id> --output <path>",
    "  luna artifacts register <path>",
    "  luna groups search [--query <name>] [--user-id <Luna-user-id>]; luna groups get|lookup|status",
    "  luna groups create|invite --json '<object>' [--request-id <id>]",
    "  luna session create-thread [--json '<object>' | --stdin] [--request-id <id>]",
    "  luna users search --query <name> [--kind user|bot] | get <user-id> | lookup --channel-id <id> --feishu-user-id <id>",
    "  luna messages send (--text <text> | --stdin) [--json] [--request-id <id>] [--purpose progress|answer|notification] [--session-id <id> | --user-id <id> | --feishu-user-id <id> --channel-id <id>]",
    "  luna memory list|search|get|add|update|delete (see `luna memory help`)",
    "  luna task create|update|restart|cancel (--stdin | --json <JSON>) --request-id <id>",
    "  luna task status <command-id>",
    "  luna task status-card --task-id <id> --request-id <id> [--resend] [--style card|native]",
    "  luna task report (--stdin | --text <report>) --request-id <id>",
    "  luna task report status <command-id>",
    "  luna session clarify|release (--stdin | --json <JSON>) --request-id <id>",
    "  luna session status <command-id>",
    "  luna version",
    "",
    "Commands:",
    "  service            Manage the local Luna Service",
    "  worker             Bind and manage the local Worker",
    "  auth               Authenticate this client with Luna Service",
    "  knowledge          Query and administer Luna knowledge through Luna Service",
    "  workspace          Read and write managed Luna workspaces through Luna Service",
    "  task               Query and manage Agent tasks",
    "  session            Query and manage Agent sessions",
    "  artifacts          Register, materialize, and download Luna artifacts",
    "  memory             Read and write the Agent's long-term memory",
    "  version            Print CLI version",
    "",
    "Run `luna auth login` before using protected Luna Service commands.",
  ].join("\n");
}

function applyGlobalAuthOptions(argv: readonly string[], env: Env): NormalizedCliInput {
  const nextArgv: string[] = [];
  let accessToken: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--access-token") {
      const token = argv[index + 1];
      if (!token || token.startsWith("--")) {
        throw new Error("missing value for --access-token");
      }
      accessToken = token;
      index += 1;
      continue;
    }
    if (value !== undefined) {
      nextArgv.push(value);
    }
  }
  return {
    argv: nextArgv,
    env: accessToken === undefined ? env : { ...env, LUNA_ACCESS_TOKEN: accessToken },
  };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let normalized: NormalizedCliInput;
  try { normalized = applyGlobalAuthOptions(args, process.env); }
  catch (error) {
    console.error(JSON.stringify({ status: "error", code: "invalid_global_option", message: String(error) }));
    process.exit(1);
  }
  if (normalized.argv[0] !== "worker") {
    loadDefaultLunaEnv(process.env);
    normalized = applyGlobalAuthOptions(args, process.env);
  }
  const [component, ...rest] = normalized.argv;
  if (component === "service" || component === "worker") {
    try {
      process.exit((await runDeployment(component, rest, normalized.env, true)).exitCode);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
  const result = await runClientCli(args);
  if (result.output) {
    process.stdout.write(`${result.output}\n`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (result.status === "error") {
    process.exit(1);
  }
}
