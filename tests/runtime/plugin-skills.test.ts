import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  PluginRegistry,
  materializeRunnerSkills,
  readMergedSkills,
  type PluginManifest,
  type PluginRuntimeFactory,
} from "@/plugins";

const createRuntime: PluginRuntimeFactory = () => ({
  invoke: async () => ({ status: "success", summary: {}, artifacts: [] }),
});

describe("plugin skills", () => {
  test("merges enabled plugin skills with filesystem skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-plugin-skills-"));
    try {
      const filesystemSkills = join(root, "user-skills");
      const generalSkill = join(filesystemSkills, "general");
      mkdirSync(generalSkill, { recursive: true });
      writeFileSync(
        join(generalSkill, "SKILL.md"),
        [
          "---",
          "name: general",
          "description: General user skill",
          "---",
          "",
        ].join("\n"),
      );

      const pluginSkill = join(
        root,
        "plugins",
        "echo",
        "skills",
        "echo-help",
      );
      mkdirSync(pluginSkill, { recursive: true });
      writeFileSync(
        join(pluginSkill, "SKILL.md"),
        [
          "---",
          "name: echo-help",
          "description: Echo plugin help",
          "---",
          "",
        ].join("\n"),
      );

      const manifest = {
        id: "echo",
        displayName: "Echo",
        version: "1.0.0",
        source: "bundled",
        requestedHostPermissions: [],
        operations: [],
        skills: [
          {
            id: "echo.help",
            path: "plugins/echo/skills/echo-help/SKILL.md",
          },
        ],
      } satisfies PluginManifest;
      const registry = new PluginRegistry();
      registry.registerPlugin(manifest, createRuntime, {});

      const skills = await readMergedSkills({
        filesystemSkillsDirectory: filesystemSkills,
        pluginRegistry: registry,
        repoRoot: root,
      });

      expect(skills.map((skill) => skill.slug)).toEqual([
        "echo.help",
        "general",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializes plugin skills into the runner-visible skills directory", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-runner-plugin-skills-"));
    try {
      const bundledSkills = join(root, "bundled-skills");
      const bundledSkill = join(bundledSkills, "core-skill");
      mkdirSync(bundledSkill, { recursive: true });
      writeFileSync(
        join(bundledSkill, "SKILL.md"),
        [
          "---",
          "name: core-skill",
          "description: Core bundled skill",
          "---",
          "",
        ].join("\n"),
      );

      const pluginSkill = join(root, "plugins", "echo", "skills", "echo-help");
      mkdirSync(pluginSkill, { recursive: true });
      writeFileSync(
        join(pluginSkill, "SKILL.md"),
        [
          "---",
          "name: echo-help",
          "description: Echo plugin help",
          "---",
          "",
        ].join("\n"),
      );

      const registry = new PluginRegistry();
      registry.registerPlugin(
        {
          id: "echo",
          displayName: "Echo",
          version: "1.0.0",
          source: "bundled",
          requestedHostPermissions: [],
          operations: [],
          skills: [
            {
              id: "echo.help",
              path: "plugins/echo/skills/echo-help/SKILL.md",
            },
          ],
        } satisfies PluginManifest,
        createRuntime,
        {},
      );

      const outputDirectory = join(root, "runner-skills");

      const materializedPath = materializeRunnerSkills({
        outputDirectory,
        bundledSkillsDirectory: bundledSkills,
        pluginRegistry: registry,
        repoRoot: root,
      });

      expect(materializedPath).toBe(outputDirectory);
      expect(existsSync(join(outputDirectory, "core-skill", "SKILL.md"))).toBe(true);
      expect(existsSync(join(outputDirectory, "echo-help", "SKILL.md"))).toBe(true);
      expect(lstatSync(join(outputDirectory, "core-skill")).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(outputDirectory, "echo-help")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(outputDirectory, "echo-help", "SKILL.md"), "utf-8"))
        .toContain("Echo plugin help");
      expect(existsSync(join(outputDirectory, "echo.help", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plugin skills take precedence over same-named filesystem skills", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-runner-plugin-skill-precedence-"));
    try {
      const filesystemSkills = join(root, "filesystem-skills");
      const filesystemSkill = join(filesystemSkills, "lark-doc");
      mkdirSync(filesystemSkill, { recursive: true });
      writeFileSync(
        join(filesystemSkill, "SKILL.md"),
        [
          "---",
          "name: lark-doc",
          "description: Old filesystem Lark doc skill",
          "---",
          "",
        ].join("\n"),
      );

      const pluginSkill = join(root, "plugins", "lark", "skills", "lark-doc");
      mkdirSync(pluginSkill, { recursive: true });
      writeFileSync(
        join(pluginSkill, "SKILL.md"),
        [
          "---",
          "name: lark-doc",
          "description: Plugin Lark doc skill",
          "---",
          "",
        ].join("\n"),
      );

      const registry = new PluginRegistry();
      registry.registerPlugin(
        {
          id: "lark",
          displayName: "Lark",
          version: "1.0.0",
          source: "bundled",
          requestedHostPermissions: [],
          operations: [],
          skills: [
            {
              id: "lark-doc",
              path: "plugins/lark/skills/lark-doc/SKILL.md",
            },
          ],
        } satisfies PluginManifest,
        createRuntime,
        {},
      );

      const outputDirectory = join(root, "runner-skills");
      const bundledSkillsDirectory = join(root, "bundled-skills");
      mkdirSync(bundledSkillsDirectory, { recursive: true });
      materializeRunnerSkills({
        outputDirectory,
        bundledSkillsDirectory,
        filesystemSkillsDirectory: filesystemSkills,
        pluginRegistry: registry,
        repoRoot: root,
      });

      expect(readFileSync(join(outputDirectory, "lark-doc", "SKILL.md"), "utf-8"))
        .toContain("Plugin Lark doc skill");
      expect(readFileSync(join(outputDirectory, "lark-doc", "SKILL.md"), "utf-8"))
        .not.toContain("Old filesystem Lark doc skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("updates an existing runner skills directory in place", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-runner-skills-replace-"));
    try {
      const bundledSkills = join(root, "bundled-skills");
      const bundledSkill = join(bundledSkills, "core-skill");
      mkdirSync(bundledSkill, { recursive: true });
      writeFileSync(
        join(bundledSkill, "SKILL.md"),
        [
          "---",
          "name: core-skill",
          "description: Core bundled skill",
          "---",
          "",
        ].join("\n"),
      );

      const outputDirectory = join(root, "runner-skills");
      mkdirSync(join(outputDirectory, "stale-skill"), { recursive: true });
      writeFileSync(join(outputDirectory, "stale-skill", "SKILL.md"), "stale");
      const beforeInode = statSync(outputDirectory).ino;

      materializeRunnerSkills({
        outputDirectory,
        bundledSkillsDirectory: bundledSkills,
        pluginRegistry: new PluginRegistry(),
      });

      expect(statSync(outputDirectory).ino).toBe(beforeInode);
      expect(existsSync(join(outputDirectory, "core-skill", "SKILL.md"))).toBe(true);
      expect(existsSync(join(outputDirectory, "stale-skill", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
