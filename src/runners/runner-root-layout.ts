import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { config } from "@/shared";

export interface EnsureRunnerRootLayoutInput {
  readonly runnerRootPath: string;
  readonly workspacePath: string;
}

export function ensureRunnerRootLayout(
  input: EnsureRunnerRootLayoutInput,
): void {
  mkdirSync(input.runnerRootPath, { recursive: true });
  mkdirSync(input.workspacePath, { recursive: true });
  mkdirSync(join(input.runnerRootPath, ".luna"), { recursive: true });

  _removeStaleSymlink(join(input.runnerRootPath, "skills"));
  _removeStaleSymlink(join(input.runnerRootPath, ".luna-prompts"));

}

export function resolveBundledSkillsRoot(
  moduleDir = import.meta.dir,
): string {
  const candidates = [
    resolve(moduleDir, "..", "..", "skills"),
    resolve(moduleDir, "..", "skills"),
  ];
  const skillsRoot = candidates.find((candidate) => existsSync(candidate));
  if (skillsRoot === undefined) {
    throw new Error(`Luna skills root not found: ${candidates.join(", ")}`);
  }
  return skillsRoot;
}

export function resolveRunnerSkillsRoot(): string {
  const generated = resolve(config.paths.home, ".runner-skills");
  return existsSync(generated) ? generated : resolveBundledSkillsRoot();
}

export function resolveRunnerBinDir(): string {
  const generated = resolve(config.paths.home, ".runner-bin");
  mkdirSync(generated, { recursive: true });
  return generated;
}

function _removeStaleSymlink(linkPath: string): void {
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      rmSync(linkPath, { force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
