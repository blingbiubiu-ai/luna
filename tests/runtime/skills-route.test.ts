import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createSkillsRoutes } from "@/server/routes/skills";
import { materializeRunnerSkills, PluginRegistry } from "@/plugins";
import { resolveBundledSkillsRoot } from "@/runners/runner-root-layout";

describe("skills route", () => {
  test("every bundled skill is discoverable after materialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-bundled-skills-route-"));
    try {
      const bundledSkillsDirectory = resolveBundledSkillsRoot();
      const expected = readdirSync(bundledSkillsDirectory)
        .filter(slug => existsSync(join(bundledSkillsDirectory, slug, "SKILL.md"))).sort();
      expect(expected.length).toBeGreaterThan(0);
      const runnerSkillsDirectory = materializeRunnerSkills({
        pluginRegistry: new PluginRegistry(),
        bundledSkillsDirectory,
        filesystemSkillsDirectory: join(root, "user-skills"),
        outputDirectory: join(root, "runner-skills"),
      });
      const app = createSkillsRoutes({ runnerSkillsDirectory });
      const response = await app.request("/");
      expect(response.status).toBe(200);
      const { entries } = await response.json() as { entries: Array<{ slug: string; name: string; description: string }> };
      expect(entries.map(entry => entry.slug).sort()).toEqual(expected);
      for (const entry of entries) {
        expect(entry.name.trim().length).toBeGreaterThan(0);
        expect(entry.description.trim().length).toBeGreaterThan(0);
        const detail = await app.request(`/${encodeURIComponent(entry.slug)}`);
        expect(detail.status).toBe(200);
        expect((await detail.json() as { content: string }).content)
          .toBe(readFileSync(join(bundledSkillsDirectory, entry.slug, "SKILL.md"), "utf8"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lists skills from the materialized runner skills directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-skills-route-"));
    try {
      const runnerSkills = join(root, ".runner-skills");
      const visibleSkill = join(runnerSkills, "runner-visible");
      mkdirSync(visibleSkill, { recursive: true });
      writeFileSync(
        join(visibleSkill, "SKILL.md"),
        [
          "---",
          "name: runner-visible",
          "description: Visible from runner snapshot",
          "---",
          "",
        ].join("\n"),
      );

      const legacySkills = join(root, "legacy-skills");
      const hiddenSkill = join(legacySkills, "legacy-only");
      mkdirSync(hiddenSkill, { recursive: true });
      writeFileSync(
        join(hiddenSkill, "SKILL.md"),
        [
          "---",
          "name: legacy-only",
          "description: Should not be listed",
          "---",
          "",
        ].join("\n"),
      );

      const app = createSkillsRoutes({
        runnerSkillsDirectory: runnerSkills,
      });

      const response = await app.request("/");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        entries: [
          {
            slug: "runner-visible",
            name: "runner-visible",
            description: "Visible from runner snapshot",
          },
        ],
      });

      const detail = await app.request("/runner-visible");
      expect(detail.status).toBe(200);
      expect(await detail.json()).toEqual({
        slug: "runner-visible",
        name: "runner-visible",
        description: "Visible from runner snapshot",
        content: [
          "---",
          "name: runner-visible",
          "description: Visible from runner snapshot",
          "---",
          "",
        ].join("\n"),
      });

      const missing = await app.request("/legacy-only");
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        status: "error",
        code: "skill_not_found",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
