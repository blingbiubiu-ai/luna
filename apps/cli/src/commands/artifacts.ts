import type { CliResult, Env } from "@luna/cli-support/types";
import { artifactsHelpText, artifactsSubcommandHelpText } from "@luna/cli-support/help";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  catArtifact,
  downloadArtifactToPath,
  materializeArtifact,
  registerArtifactFile,
} from "@luna/cli-support/service-client";

export async function runArtifactsCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const [command, ref] = argv;
  try {
    if (!command || command === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
      const requested = command === "help" ? ref : command;
      if (requested && requested !== "help" && !requested.startsWith("-")) {
        const subcommandHelp = artifactsSubcommandHelpText(requested);
        if (subcommandHelp) {
          return { status: "ok", output: subcommandHelp };
        }
      }
      return { status: "ok", output: artifactsHelpText() };
    }
    if (command === "materialize") {
      if (ref === undefined) {
        return missingRef();
      }
      const outputDir = readOption(argv, "--output-dir");
      const result = await materializeArtifact(env, {
        ref,
        ...(outputDir === undefined ? {} : { outputDir }),
      });
      return {
        status: "ok",
        output: hasFlag(argv, "--json") ? JSON.stringify(result) : result.path,
      };
    }
    if (command === "download") {
      if (ref === undefined) {
        return missingRef();
      }
      const output = readOption(argv, "--output");
      if (output === undefined) {
        return {
          status: "error",
          code: "missing_output",
          message: "--output is required",
        };
      }
      return {
        status: "ok",
        output: await downloadArtifactToPath(env, { ref, output }),
      };
    }
    if (command === "register") {
      if (ref === undefined) {
        return {
          status: "error",
          code: "missing_artifact_path",
          message: "artifact path is required",
        };
      }
      const result = await registerArtifactFile(env, {
        path: ref,
        ...optionalOption("scopeType", readOption(argv, "--scope-type")),
        ...optionalOption("scopeId", readOption(argv, "--scope-id")),
        ...optionalOption("kind", readOption(argv, "--kind")),
        ...optionalOption("name", readOption(argv, "--name")),
      });
      return {
        status: "ok",
        output: hasFlag(argv, "--json") ? JSON.stringify(result) : result.ref,
      };
    }
    if (command === "cat") {
      if (ref === undefined) {
        return missingRef();
      }
      return {
        status: "ok",
        output: await catArtifact(env, { ref }),
      };
    }
    return {
      status: "error",
      code: "unknown_artifacts_command",
      message: `unknown artifacts command: ${command ?? ""}`.trimEnd(),
    };
  } catch (error) {
    return {
      status: "error",
      code: "artifact_command_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function optionalOption<T extends string>(
  key: T,
  value: string | undefined,
): Record<T, string> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<T, string>;
}

function missingRef(): CliResult {
  return {
    status: "error",
    code: "missing_artifact_ref",
    message: "artifact ref is required",
  };
}
