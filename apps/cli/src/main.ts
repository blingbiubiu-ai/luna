#!/usr/bin/env bun
import { runDeployment } from "./deployment";
import { runGroupsCli } from "./commands/groups";
import { runUsersCli } from "./commands/users";
import { runRootCli } from "./commands/root";

import type { CliResult, Env, NormalizedCliInput } from "@luna/cli-support/types";
import { versionHelpText } from "@luna/cli-support/help";
import { loadDefaultLunaEnv, resolveTurnLunaEnv } from "@luna/cli-support/env";
import { hasFlag } from "@luna/cli-support/options";
import { runSchedulesCli } from "./commands/schedules";
import { runSayCli } from "./commands/say";
import { runAskCli } from "./commands/ask";
import { runInternalCli } from "./commands/internal";
import { runCommandsCli } from "./commands/commands";
import { runWhoamiCli } from "./commands/whoami";
import { runActivityCli } from "./commands/activity";
import { runTasksCli } from "./commands/tasks";
import { runSessionsCli } from "./commands/sessions";
import { runMemoryCli } from "./commands/memory";
import { runChatCli } from "./commands/chat";
import { runAuthCli } from "./commands/auth";
import { runKnowledgeCli } from "./commands/knowledge";
import { runWorkspaceCli } from "./commands/workspace";
import { runArtifactsCli } from "./commands/artifacts";
import {
  pluginCommandsHelpText,
  runPluginCommandCli,
} from "./commands/plugin-command";

export { loadDefaultLunaEnv } from "@luna/cli-support/env";

const LEGACY_REMOVED_TOP_LEVEL: Record<string, string> = {
  messages: "`luna messages` is removed; use `luna say` or `luna ask`",
  asks: "`luna asks` is removed; use `luna ask` (`luna ask --to ...` or `luna ask reply|message|wait|cancel|get|list`)",
  requests: "`luna requests` is removed; use `luna ask` (`luna ask --to ...` or `luna ask reply|message|wait|cancel|get|list`)",
  handoff: "`luna handoff` is removed; use `luna say --to <address> --via-main` (one-way) or `luna ask --to <address> --text ...` (tracked response)",
  handoffs: "`luna handoffs` is removed; use `luna ask reply <id> --done|--declined --text ...`",
  task: "`luna task` is removed in Protocol v2; use `luna tasks`",
  session: "`luna session` is removed in Protocol v2; use `luna sessions`",
};

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
  if (command in LEGACY_REMOVED_TOP_LEVEL) {
    return {
      status: "error",
      code: "legacy_command_removed",
      message: LEGACY_REMOVED_TOP_LEVEL[command]!,
    };
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
    return { status: "ok", output: "0.2.0" };
  }
  if (command === "internal") return runInternalCli(rest, env);
  if (command === "say") return runSayCli(rest, env);
  if (command === "ask") return runAskCli(rest, env);
  if (command === "commands") return runCommandsCli(rest, env);
  if (command === "whoami") return runWhoamiCli(rest, env);
  if (command === "activity") return runActivityCli(rest, env);
  if (command === "tasks") return runTasksCli(rest, env);
  if (command === "sessions") return runSessionsCli(rest, env);
  if (command === "schedules") return runSchedulesCli(rest, env);
  if (command === "groups") return runGroupsCli(rest, env);
  if (command === "users") return runUsersCli(rest, env);
  if (command === "root") return runRootCli(rest, env);
  if (command === "memory") return runMemoryCli(rest, env);
  if (command === "chat") return runChatCli(rest, env);
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
    "Luna CLI (Protocol v2)",
    "",
    "Usage:",
    "  luna service <command>",
    "  luna worker <command>",
    "  luna auth <command>",
    "  luna whoami",
    "  luna say [--to <address>] [--via-main [--task-id <id>]] (--text <text> | --stdin) [--json] [--purpose progress|answer|notification] [--repeat]",
    "  luna ask --to <address|main> (--text <text> | --stdin) [--context <text>] [--options '<json-array>'] [--expires-in <duration>] [--wait [<duration>]]",
    "  luna ask reply|message|wait|cancel|get|list ...",
    "  luna commands status|wait <command-id> [--timeout-ms <ms>]",
    "  luna tasks list|get|progress|create|update|restart|cancel|transfer|watch|unwatch|status-card|pause|report",
    "  luna sessions list|timeline|messages|create-thread|clarify|release",
    "  luna schedules create|list|get|update|pause|resume|cancel",
    "  luna activity --since <ISO-8601-or-epoch-ms> [--limit <n>]",
    "  luna groups search|get|lookup|create|invite",
    "  luna users search --query <name> [--kind user|bot] | get <user-id> | lookup --channel-id <id> --feishu-user-id <id>",
    "  luna memory list|search|timeline|get|add|update|delete|restore (see `luna memory help`)",
    "  luna chat listen status|on|off",
    "  luna root status [--user <user-id>]",
    "  luna knowledge <command>",
    "  luna workspace <workspace-id> <command>",
    "  luna artifacts materialize|download|register|cat",
    "  luna version",
    "",
    "Addresses: current, self, owner, main, task:<id>, user:<id>, session:<id>, group:<id>",
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
  const effectiveEnv = resolveTurnLunaEnv(env);
  return {
    argv: nextArgv,
    env: accessToken === undefined ? effectiveEnv : { ...effectiveEnv, LUNA_ACCESS_TOKEN: accessToken },
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
  if (result.output !== undefined) {
    if (result.output.length > 0) {
      process.stdout.write(`${result.output}\n`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (result.status === "error") {
    process.exit(1);
  }
}
