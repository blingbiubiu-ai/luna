import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { resolveAgentRuntimeOptions } from "../../src/runtime";
import { resolveAgentRuntimeStartOptions } from "../../src/cli/commands/agent";
import { stripProcessManagerArgs } from "../../src/cli/daemon";
import { loadDefaultLunaEnv } from "@luna/host-runtime/env";
import { AppConfig } from "../../src/shared/config/schema";
import * as shared from "../../src/shared";

type RunnerRootBaseModule = {
  resolveRunnerRootBase(input: {
    readonly home: string;
    readonly configured?: string;
  }): string;
  ensureRunnerRootBase(path: string): void;
  isPathContainedByRunnerRootBase(path: string, base?: string): boolean;
};

function runnerRootBaseModule(): RunnerRootBaseModule | undefined {
  const candidate = shared as typeof shared & Partial<RunnerRootBaseModule>;
  return typeof candidate.resolveRunnerRootBase === "function" &&
      typeof candidate.ensureRunnerRootBase === "function" &&
      typeof candidate.isPathContainedByRunnerRootBase === "function"
    ? candidate as RunnerRootBaseModule
    : undefined;
}

describe("runner root base configuration", () => {
  test("defaults runnersDir under LUNA_HOME", () => {
    const options = resolveAgentRuntimeOptions({
      HOME: "/home/test",
      LUNA_HOME: "/luna",
    });

    expect((options as { runnersDir?: string }).runnersDir).toBe(
      "/luna/runners",
    );
  });

  test("CLI runners-dir wins over process environment", () => {
    const options = resolveAgentRuntimeStartOptions(
      ["--runners-dir", "/cli/runners"],
      {
        HOME: "/home/test",
        LUNA_HOME: "/luna",
        LUNA_RUNNERS_DIR: "/env/runners",
      },
    );

    expect((options as { runnersDir?: string }).runnersDir).toBe(
      "/cli/runners",
    );
  });

  test("maps paths.runnersDir from config.yaml", () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-runners-yaml-"));
    writeFileSync(
      join(testHome, "config.yaml"),
      "paths:\n  runnersDir: /yaml/runners\n",
    );
    const env: Record<string, string | undefined> = {
      HOME: testHome,
      LUNA_HOME: testHome,
    };

    try {
      loadDefaultLunaEnv(env);
      expect(env.LUNA_RUNNERS_DIR).toBe("/yaml/runners");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("dotenv overrides config and explicit env overrides dotenv", () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-runners-env-"));
    writeFileSync(
      join(testHome, "config.yaml"),
      "paths:\n  runnersDir: /yaml/runners\n",
    );
    writeFileSync(
      join(testHome, ".env"),
      "LUNA_RUNNERS_DIR=/dotenv/runners\n",
    );

    try {
      const loaded: Record<string, string | undefined> = {
        HOME: testHome,
        LUNA_HOME: testHome,
      };
      loadDefaultLunaEnv(loaded);
      expect(loaded.LUNA_RUNNERS_DIR).toBe("/dotenv/runners");

      const explicit: Record<string, string | undefined> = {
        HOME: testHome,
        LUNA_HOME: testHome,
        LUNA_RUNNERS_DIR: "/process/runners",
      };
      loadDefaultLunaEnv(explicit);
      expect(explicit.LUNA_RUNNERS_DIR).toBe("/process/runners");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("schema accepts paths.runnersDir", () => {
    const parsed = AppConfig.parse({
      paths: { runnersDir: "/data/luna-runners" },
      messaging: { default_channel_id: "", channels: [] },
    });

    expect((parsed.paths as { runnersDir?: string }).runnersDir).toBe(
      "/data/luna-runners",
    );
  });

  test("resolves a configured shared workspace directory", () => {
    const options = resolveAgentRuntimeOptions({
      HOME: "/home/test",
      LUNA_HOME: "/luna",
      LUNA_SHARED_WORKSPACE_DIR: "/shared/workspace",
    });
    expect(options.sharedWorkspaceDir).toBe("/shared/workspace");

    const parsed = AppConfig.parse({
      paths: { sharedWorkspaceDir: "/shared/workspace" },
      messaging: { default_channel_id: "", channels: [] },
    });
    expect(parsed.paths.sharedWorkspaceDir).toBe("/shared/workspace");
  });

  test("maps paths.sharedWorkspaceDir from config.yaml", () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-workspace-yaml-"));
    writeFileSync(
      join(testHome, "config.yaml"),
      "paths:\n  sharedWorkspaceDir: /yaml/workspace\n",
    );
    const env: Record<string, string | undefined> = {
      HOME: testHome,
      LUNA_HOME: testHome,
    };

    try {
      loadDefaultLunaEnv(env);
      expect(env.LUNA_SHARED_WORKSPACE_DIR).toBe("/yaml/workspace");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("rejects removed shared workspace keys", () => {
    expect(
      AppConfig.safeParse({
        paths: { projectsDir: "/legacy/projects" },
        messaging: { default_channel_id: "", channels: [] },
      }).success,
    ).toBe(false);
    expect(
      AppConfig.safeParse({
        paths: { workspaceDir: "/legacy/workspace" },
        messaging: { default_channel_id: "", channels: [] },
      }).success,
    ).toBe(false);
  });

  test("daemon child arguments preserve runners-dir", () => {
    expect(
      stripProcessManagerArgs([
        "--runtime-dir",
        "/tmp/luna",
        "--runners-dir",
        "/data/runners",
        "--dry-run",
      ]),
    ).toEqual(["--runners-dir", "/data/runners"]);
  });
});

describe("runner root base validation", () => {
  test("exports runner root base helpers", () => {
    expect(runnerRootBaseModule()).toBeDefined();
  });

  test("rejects relative paths and the filesystem root", () => {
    const module = runnerRootBaseModule();
    if (module === undefined) return;

    expect(() =>
      module.resolveRunnerRootBase({
        home: "/luna",
        configured: "relative/runners",
      })
    ).toThrow(/absolute/i);
    expect(() =>
      module.resolveRunnerRootBase({ home: "/luna", configured: "/" })
    ).toThrow(/filesystem root/i);
  });

  test("creates a writable runner root and checks containment", () => {
    const module = runnerRootBaseModule();
    if (module === undefined) return;
    const testHome = mkdtempSync(join(tmpdir(), "luna-runner-root-"));
    const base = join(testHome, "runners");

    try {
      module.ensureRunnerRootBase(base);
      expect(module.isPathContainedByRunnerRootBase(join(base, "task_1"), base))
        .toBe(true);
      expect(module.isPathContainedByRunnerRootBase(join(testHome, "outside"), base))
        .toBe(false);
      expect(module.isPathContainedByRunnerRootBase(base, base)).toBe(false);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("rejects a non-directory and an unwritable runner root", () => {
    const module = runnerRootBaseModule();
    if (module === undefined) return;
    const testHome = mkdtempSync(join(tmpdir(), "luna-runner-invalid-"));
    const filePath = join(testHome, "file");
    const readOnlyPath = join(testHome, "read-only");
    writeFileSync(filePath, "not a directory");
    mkdirSync(readOnlyPath);
    chmodSync(readOnlyPath, 0o500);

    try {
      expect(() => module.ensureRunnerRootBase(filePath)).toThrow(
        /not a directory|EEXIST/i,
      );
      expect(() => module.ensureRunnerRootBase(readOnlyPath)).toThrow(
        /writable|EACCES/i,
      );
    } finally {
      chmodSync(readOnlyPath, 0o700);
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
