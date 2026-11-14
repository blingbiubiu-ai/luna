import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Hono } from "hono";

import {
  PluginRegistry,
  defaultRunnerSkillsDirectory,
  readMergedSkills,
} from "@/plugins";
import { createLogger, type Skill } from "@/shared";

const logger = createLogger("skills-route");

export interface SkillsRouteOptions {
  readonly runnerSkillsDirectory?: string;
}

/**
 * Skills route group. Returns installed runner skills as a list plus per-skill
 * detail records.
 */
export function createSkillsRoutes(options: SkillsRouteOptions = {}) {
  const getRunnerSkillsDirectory = () =>
    options.runnerSkillsDirectory ?? defaultRunnerSkillsDirectory();
  const readSkills = () =>
    readMergedSkills({
      filesystemSkillsDirectory: getRunnerSkillsDirectory(),
      pluginRegistry: new PluginRegistry(),
      onReadError: ({ slug, error }) => {
        logger.debug({ slug, error }, "Failed to read skill, skipping");
      },
    });

  return new Hono().get("/", async (c) => {
    const skills = await readSkills();
    return c.json({ entries: skills });
  }).get("/:slug", async (c) => {
    const skills = await readSkills();
    const skill = skills.find((entry) => entry.slug === c.req.param("slug"));
    if (skill === undefined) {
      return c.json(
        {
          status: "error",
          code: "skill_not_found",
          message: `skill not found: ${c.req.param("slug")}`,
        },
        404,
      );
    }
    return c.json({
      ...skill,
      content: readSkillMarkdown(getRunnerSkillsDirectory(), skill),
    });
  });
}

export const skillsRoutes = createSkillsRoutes();

function readSkillMarkdown(
  runnerSkillsDirectory: string,
  skill: Skill,
): string {
  const skillMdPath = join(runnerSkillsDirectory, skill.slug, "SKILL.md");
  if (existsSync(skillMdPath)) {
    return readFileSync(skillMdPath, "utf-8");
  }
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    ...(skill.license === undefined ? [] : [`license: ${skill.license}`]),
    "---",
    "",
  ].join("\n");
}
