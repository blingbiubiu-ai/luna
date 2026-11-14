import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { config } from "@/shared";

export interface MaterializeRunnerPromptsInput {
  readonly outputDirectory?: string;
  readonly promptAssetsDirectory?: string;
}

export function defaultRunnerPromptsDirectory(): string {
  return join(config.paths.home, ".runner_prompt");
}

export function resolvePromptAssetsRoot(moduleDir = import.meta.dir): string {
  const candidates = [
    resolve(moduleDir, "..", "prompts"),
    resolve(moduleDir, "..", "src", "prompts"),
  ];
  const promptAssetsRoot = candidates.find((candidate) => existsSync(candidate));
  if (promptAssetsRoot === undefined) {
    throw new Error(
      `Luna prompt assets not found: ${candidates.join(", ")}`,
    );
  }
  return promptAssetsRoot;
}

export function materializeRunnerPrompts(
  input: MaterializeRunnerPromptsInput = {},
): string {
  const outputDirectory = input.outputDirectory ?? defaultRunnerPromptsDirectory();
  const promptAssetsDirectory = input.promptAssetsDirectory ?? resolvePromptAssetsRoot();
  const tempDirectory = `${outputDirectory}.tmp-${process.pid}-${Date.now()}`;

  rmSync(tempDirectory, { recursive: true, force: true });
  mkdirSync(tempDirectory, { recursive: true });

  try {
    for (const entry of readdirSync(promptAssetsDirectory)) {
      cpSync(
        join(promptAssetsDirectory, entry),
        join(tempDirectory, entry),
        {
          recursive: true,
          dereference: true,
          errorOnExist: true,
          force: false,
        },
      );
    }
    replaceDirectoryContents(tempDirectory, outputDirectory);
    return outputDirectory;
  } catch (err) {
    rmSync(tempDirectory, { recursive: true, force: true });
    throw err;
  }
}

export function resolveRunnerPromptsRoot(): string {
  const generated = defaultRunnerPromptsDirectory();
  return existsSync(generated) ? generated : materializeRunnerPrompts();
}

function replaceDirectoryContents(
  sourceDirectory: string,
  outputDirectory: string,
): void {
  const outputExists = existsSync(outputDirectory);
  if (outputExists && !lstatSync(outputDirectory).isDirectory()) {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
  mkdirSync(outputDirectory, { recursive: true });
  for (const entry of readdirSync(outputDirectory)) {
    rmSync(join(outputDirectory, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(sourceDirectory)) {
    cpSync(join(sourceDirectory, entry), join(outputDirectory, entry), {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
  }
  rmSync(sourceDirectory, { recursive: true, force: true });
}
