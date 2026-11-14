import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { Skill } from "@/shared";

import type { SkillContribution } from "./manifest";
import type { PluginRegistry } from "./registry";

export interface ReadMergedSkillsInput {
  readonly filesystemSkillsDirectory: string;
  readonly pluginRegistry: PluginRegistry;
  readonly repoRoot?: string;
  readonly onReadError?: (input: { readonly slug: string; readonly error: unknown }) => void;
}

interface SkillWithMtime {
  readonly skill: Skill;
  readonly mtime: number;
}

export async function readMergedSkills(input: ReadMergedSkillsInput): Promise<Skill[]> {
  const seen = new Set<string>();
  const pluginSkills = await readPluginSkills(input, seen);
  const filesystemSkills = await readFilesystemSkills(input, seen);
  return [...pluginSkills, ...filesystemSkills];
}

export function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const block = match?.[1];
  if (!block) {
    return {};
  }
  try {
    const parsed = Bun.YAML.parse(block) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      } else if (value !== null && value !== undefined) {
        result[key] = String(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function readPluginSkills(
  input: ReadMergedSkillsInput,
  seen: Set<string>,
): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const contribution of input.pluginRegistry.listSkills()) {
    if (seen.has(contribution.id)) {
      throw new Error(`duplicate skill id: ${contribution.id}`);
    }
    seen.add(contribution.id);
    const skill = await readPluginSkill(input, contribution);
    if (skill !== undefined) {
      skills.push(skill);
    }
  }
  return skills;
}

async function readPluginSkill(
  input: ReadMergedSkillsInput,
  contribution: SkillContribution,
): Promise<Skill | undefined> {
  const skillPath = contribution.path;
  if (skillPath === undefined) {
    return contribution.description === undefined
      ? undefined
      : {
          slug: contribution.id,
          name: contribution.title ?? contribution.id,
          description: contribution.description,
        };
  }
  try {
    const path = resolveSkillPath(input.repoRoot, skillPath);
    const content = await Bun.file(path).text();
    const frontmatter = parseSkillFrontmatter(content);
    const description = frontmatter.description ?? contribution.description;
    if (description === undefined) {
      return undefined;
    }
    return {
      slug: contribution.id,
      name: frontmatter.name ?? contribution.title ?? contribution.id,
      description,
      ...(frontmatter.license === undefined ? {} : { license: frontmatter.license }),
    };
  } catch (error) {
    input.onReadError?.({ slug: contribution.id, error });
    return undefined;
  }
}

async function readFilesystemSkills(
  input: ReadMergedSkillsInput,
  seen: Set<string>,
): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = readdirSync(input.filesystemSkillsDirectory);
  } catch (error) {
    input.onReadError?.({
      slug: input.filesystemSkillsDirectory,
      error,
    });
    return [];
  }

  const skills: SkillWithMtime[] = [];
  for (const entry of entries) {
    const entryPath = join(input.filesystemSkillsDirectory, entry);
    try {
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }
      if (seen.has(entry)) {
        throw new Error(`duplicate skill id: ${entry}`);
      }
      const skillMdPath = join(entryPath, "SKILL.md");
      const mtime = statSync(skillMdPath).mtimeMs;
      const content = await Bun.file(skillMdPath).text();
      const frontmatter = parseSkillFrontmatter(content);
      if (!frontmatter.name || !frontmatter.description) {
        continue;
      }
      seen.add(entry);
      skills.push({
        skill: {
          slug: entry,
          name: frontmatter.name,
          description: frontmatter.description,
          ...(frontmatter.license === undefined ? {} : { license: frontmatter.license }),
        },
        mtime,
      });
    } catch (error) {
      input.onReadError?.({ slug: entry, error });
    }
  }

  skills.sort((a, b) => b.mtime - a.mtime);
  return skills.map(({ skill }) => skill);
}

export function resolveSkillPath(repoRoot: string | undefined, path: string): string {
  if (isAbsolute(path)) {
    return path;
  }
  const roots = [
    repoRoot,
    process.cwd(),
    resolve(import.meta.dir, "..", ".."),
    resolve(import.meta.dir, ".."),
  ].filter((value): value is string => value !== undefined);
  for (const root of roots) {
    const candidate = resolve(root, path);
    if (statExists(candidate)) {
      return candidate;
    }
  }
  return resolve(roots[0] ?? process.cwd(), path);
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
