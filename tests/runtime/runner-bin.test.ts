import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { materializeRunnerBin } from "../../src/plugins/runner-bin";
import { PluginRegistry } from "../../src/plugins";
import { setLunaHome } from "../../src/shared";

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-runner-bin-"));
  setLunaHome(testHome);
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe("materializeRunnerBin", () => {
  test("copies each containerCommands shim to .runner-bin/<binary> as real file", () => {
    const shimDir = join(testHome, "fake-plugin", "container");
    mkdirSync(shimDir, { recursive: true });
    const shimPath = join(shimDir, "lark-cli-shim.js");
    writeFileSync(shimPath, "#!/usr/bin/env node\nconsole.log('hi');\n");
    chmodSync(shimPath, 0o755);

    const registry = new PluginRegistry();
    registry.registerPlugin(
      {
        id: "fake-lark", displayName: "f", version: "1", source: "bundled",
        requestedHostPermissions: [], operations: [],
        containerCommands: [{ binary: "lark-cli", commandPath: ["lark"], shimScript: shimPath }],
      } as never,
      () => ({ async invoke() { return { status: "success" as const, summary: {}, output: {}, artifacts: [] }; } }),
      {},
    );

    const binDir = materializeRunnerBin({ pluginRegistry: registry });
    const copied = join(binDir, "lark-cli");
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, "utf8")).toContain("console.log");
    expect(statSync(copied).mode & 0o111).not.toBe(0);
  });

  test("handles multiple plugins and cleans stale entries", () => {
    const shimA = join(testHome, "a.sh"); writeFileSync(shimA, "#!/bin/sh\necho a\n"); chmodSync(shimA, 0o755);
    const shimB = join(testHome, "b.sh"); writeFileSync(shimB, "#!/bin/sh\necho b\n"); chmodSync(shimB, 0o755);
    const runtime = join(testHome, "runtime");
    mkdirSync(join(runtime, "dist"), { recursive: true });
    writeFileSync(join(runtime, "dist", "cli.js"), "console.log('local cli');");
    const registry = new PluginRegistry();
    registry.registerPlugin(
      { id: "pa", displayName: "pa", version: "1", source: "bundled", requestedHostPermissions: [], operations: [], containerCommands: [{ binary: "a-cli", commandPath: ["a"], shimScript: shimA, runtimeDirectory: runtime }] } as never,
      () => ({ async invoke() { return { status: "success" as const, summary: {}, output: {}, artifacts: [] }; } }),
      {},
    );
    registry.registerPlugin(
      { id: "pb", displayName: "pb", version: "1", source: "bundled", requestedHostPermissions: [], operations: [], containerCommands: [{ binary: "b-cli", commandPath: ["b"], shimScript: shimB }] } as never,
      () => ({ async invoke() { return { status: "success" as const, summary: {}, output: {}, artifacts: [] }; } }),
      {},
    );
    const binDir = materializeRunnerBin({ pluginRegistry: registry });
    expect(existsSync(join(binDir, "a-cli"))).toBe(true);
    expect(existsSync(join(binDir, "b-cli"))).toBe(true);
    expect(readFileSync(join(binDir, ".runtime", "a-cli", "dist", "cli.js"), "utf8")).toBe("console.log('local cli');");
    expect(existsSync(join(binDir, ".runtime", "b-cli"))).toBe(false);
    materializeRunnerBin({ pluginRegistry: new PluginRegistry() });
    expect(existsSync(join(binDir, ".runtime"))).toBe(false);
    expect(existsSync(join(binDir, "a-cli"))).toBe(false);
  });
});
