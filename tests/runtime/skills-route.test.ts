import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createSkillsRoutes } from "@/server/routes/skills";

describe("skills route", () => {
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
