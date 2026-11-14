import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkerCli } from "../../apps/worker/src/cli";

describe("Luna Worker CLI help", () => {
  test("subcommand help returns without configuration or side effects", async () => {
    const home = mkdtempSync(join(tmpdir(), "luna-worker-help-"));
    try {
      for (const command of ["start", "status", "bind", "init"]) {
        for (const flag of ["--help", "-h"]) {
          const result = await runWorkerCli([command, "--home", home, flag], { PATH: "" });
          expect(result.status).toBe("ok");
          expect(result.output).toContain("luna worker start|status");
          expect(readdirSync(home)).toEqual([]);
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("executable help exits before parsing startup options", () => {
    for (const flag of ["--help", "-h"]) {
      const result = Bun.spawnSync([process.execPath, "apps/worker/src/main.ts", "start", "--home", flag], {
        cwd: new URL("../..", import.meta.url).pathname,
        stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("luna worker start|status");
    }
  });
});
