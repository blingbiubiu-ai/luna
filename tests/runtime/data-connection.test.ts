import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { migrationFolderCandidates } from "../../src/data/data-connection";

describe("data connection", () => {
  test("resolves migrations from source CLI and outer repo layouts", () => {
    const candidates = migrationFolderCandidates({
      moduleDir: "/repo/luna/src/cli",
      cwd: "/repo",
      env: {
        LUNA_MIGRATIONS_DIR: "/override/drizzle",
      },
    });

    expect(candidates[0]).toBe("/override/drizzle");
    expect(candidates).toContain(join("/repo/luna/src/data/drizzle"));
  });

  test("resolves migrations from root dist layout", () => {
    const candidates = migrationFolderCandidates({
      moduleDir: "/repo/luna/dist",
      cwd: "/repo",
      env: {},
    });

    expect(candidates).toContain(join("/repo/luna/src/data/drizzle"));
  });

  test("resolves migrations from direct source module layout", () => {
    const candidates = migrationFolderCandidates({
      moduleDir: "/repo/luna/src/data",
      cwd: "/tmp",
      env: {},
    });

    expect(candidates[0]).toBe(join("/repo/luna/src/data/drizzle"));
    expect(candidates).toContain(join("/repo/luna/src/data/drizzle"));
  });
});
