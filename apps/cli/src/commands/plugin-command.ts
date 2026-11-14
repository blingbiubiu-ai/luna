import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag } from "@luna/cli-support/options";
import {
  callUnifiedService,
  downloadArtifactsFromOutput,
  parseJsonPayload,
  queryString,
} from "@luna/cli-support/service-client";

export async function runPluginCommandCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult | undefined> {
  const namespace = argv[0];
  if (
    namespace === undefined ||
    argv.length < 2
  ) {
    return undefined;
  }
  const help = requestsHelp(argv);
  const scope = help ? "" : queryString({
    ...(env.LUNA_AGENT_ID ? { agentId: env.LUNA_AGENT_ID } : {}),
    ...(env.LUNA_SHADOW_ID ? { shadowId: env.LUNA_SHADOW_ID } : {}),
  });

  const result = await callUnifiedService(env, {
    method: "POST",
    path: `/api/plugins/commands/resolve-and-invoke${scope ? `?${scope}` : ""}`,
    body: {
      path: [namespace],
      args: argv.slice(1),
      ...(help ? { help: true } : {}),
    },
  });
  if (help && result.status === "ok") {
    const payload = parseJsonPayload(result.output ?? "{}");
    if (
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof (payload as { output?: unknown }).output === "string"
    ) {
      return {
        status: "ok",
        output: (payload as { output: string }).output,
      };
    }
  }
  if (result.status === "error" || !hasFlag(argv, "--download-artifacts")) {
    return result;
  }
  try {
    return await downloadArtifactsFromOutput(env, result.output);
  } catch (error) {
    return {
      status: "error",
      code: "artifact_download_failed",
      message: error instanceof Error ? error.message : "failed to download artifact",
      ...(result.output === undefined ? {} : { output: result.output }),
    };
  }
}

export async function pluginCommandsHelpText(_env: Env): Promise<string | undefined> {
  return [
    "Plugin Commands:",
    "",
    "Run `luna <plugin> <command> --help` for enabled plugin commands.",
    "Set LUNA_AGENT_ID and LUNA_SHADOW_ID when invoking a plugin with a personal token.",
    "Run `luna auth login` if plugin commands return unauthorized.",
  ].join("\n");
}

function requestsHelp(argv: readonly string[]): boolean {
  return hasFlag(argv, "--help") || hasFlag(argv, "-h") || argv.at(-1) === "help";
}
