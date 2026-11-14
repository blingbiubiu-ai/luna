import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { config } from "@/shared";
import { resolveBundledSkillsRoot } from "@/runners/runner-root-layout";

import type { PluginRegistry } from "./registry";
import { resolveSkillPath } from "./skills";

export interface MaterializeRunnerSkillsInput {
  readonly pluginRegistry: PluginRegistry;
  readonly outputDirectory?: string;
  readonly bundledSkillsDirectory?: string;
  readonly filesystemSkillsDirectory?: string;
  readonly repoRoot?: string;
}

export function defaultRunnerSkillsDirectory(): string {
  return join(config.paths.home, ".runner-skills");
}

export function materializeRunnerSkills(input: MaterializeRunnerSkillsInput): string {
  const outputDirectory = input.outputDirectory ?? defaultRunnerSkillsDirectory();
  const tempDirectory = `${outputDirectory}.tmp-${process.pid}-${Date.now()}`;
  const seen = new Set<string>();

  rmSync(tempDirectory, { recursive: true, force: true });
  mkdirSync(tempDirectory, { recursive: true });

  try {
    const bundledSkillsDirectory = input.bundledSkillsDirectory ?? resolveBundledSkillsRoot();
    linkSkillDirectories({
      sourceDirectory: bundledSkillsDirectory,
      outputDirectory: tempDirectory,
      seen,
      sourceLabel: "bundled skills",
    });

    for (const skill of input.pluginRegistry.listSkills()) {
      if (skill.path === undefined && skill.description === undefined) {
        continue;
      }
      if (skill.path === undefined) {
        const description = skill.description;
        if (description === undefined) {
          continue;
        }
        const skillDirectoryName = safeSkillDirectoryName(skill.id);
        assertUniqueSkill(seen, skillDirectoryName, `plugin skill "${skill.id}"`);
        const targetPath = join(tempDirectory, skillDirectoryName);
        mkdirSync(targetPath, { recursive: true });
        writeFileSync(
          join(targetPath, "SKILL.md"),
          generatedSkillMarkdown({
            name: skill.title ?? skill.id,
            description,
          }),
          "utf-8",
        );
        continue;
      }

      const skillPath = resolveSkillPath(input.repoRoot, skill.path);
      const sourceDirectory = dirname(skillPath);
      const skillDirectoryName = safeSkillDirectoryName(basename(sourceDirectory));
      assertUniqueSkill(seen, skillDirectoryName, `plugin skill "${skill.id}"`);
      copySkillDirectory(sourceDirectory, join(tempDirectory, skillDirectoryName));
    }

    const filesystemSkillsDirectory = input.filesystemSkillsDirectory ?? config.paths.skills;
    if (existsSync(filesystemSkillsDirectory)) {
      linkSkillDirectories({
        sourceDirectory: filesystemSkillsDirectory,
        outputDirectory: tempDirectory,
        seen,
        sourceLabel: "filesystem skills",
        duplicatePolicy: "skip",
      });
    }

    replaceDirectoryContents(tempDirectory, outputDirectory);
    return outputDirectory;
  } catch (err) {
    rmSync(tempDirectory, { recursive: true, force: true });
    throw err;
  }
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
    copySkillDirectory(join(sourceDirectory, entry), join(outputDirectory, entry));
  }
  rmSync(sourceDirectory, { recursive: true, force: true });
}

export function resolveRunnerSkillsRoot(): string {
  const generated = defaultRunnerSkillsDirectory();
  return existsSync(generated) ? generated : resolveBundledSkillsRoot();
}

function linkSkillDirectories(input: {
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
  readonly seen: Set<string>;
  readonly sourceLabel: string;
  readonly duplicatePolicy?: "error" | "skip";
}): void {
  for (const entry of readdirSync(input.sourceDirectory)) {
    const sourcePath = join(input.sourceDirectory, entry);
    if (!lstatSync(sourcePath).isDirectory()) {
      continue;
    }
    const skillPath = join(sourcePath, "SKILL.md");
    if (!existsSync(skillPath)) {
      continue;
    }
    if (input.duplicatePolicy === "skip" && input.seen.has(entry)) {
      continue;
    }
    assertUniqueSkill(input.seen, entry, `${input.sourceLabel} "${entry}"`);
    copySkillDirectory(realpathSync(sourcePath), join(input.outputDirectory, entry));
  }
}

function assertUniqueSkill(
  seen: Set<string>,
  id: string,
  sourceLabel: string,
): void {
  if (seen.has(id)) {
    throw new Error(`Duplicate runner skill "${id}" from ${sourceLabel}.`);
  }
  seen.add(id);
}

function safeSkillDirectoryName(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`Plugin skill id "${id}" is not safe as a runner skill directory name.`);
  }
  return id;
}

function generatedSkillMarkdown(input: {
  readonly name: string;
  readonly description: string;
}): string {
  return [
    "---",
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
    "---",
    "",
  ].join("\n");
}

function copySkillDirectory(sourcePath: string, targetPath: string): void {
  cpSync(sourcePath, targetPath, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
}
