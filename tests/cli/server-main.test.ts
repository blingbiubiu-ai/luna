import { describe, expect, test } from "bun:test";

import { isLunaCliProcessArgs } from "../../src/cli/daemon";
import { runServerCli } from "../../src/cli/server-main";

describe("Luna Service CLI", () => {
  test("uses service-oriented command names for daemon dry-runs", async () => {
    const result = await runServerCli(
      [
        "start",
        "--dry-run",
        "--host",
        "127.0.0.1",
        "--port",
        "9001",
        "--runtime-dir",
        "/tmp/luna-runtime",
      ],
      { LUNA_HOME: "/tmp/luna-home" },
    );

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.output ?? "{}")).toMatchObject({
      command: "luna-service start",
      host: "127.0.0.1",
      port: 9001,
      home: "/tmp/luna-home",
      pidFile: "/tmp/luna-runtime/agent.pid",
      logFile: "/tmp/luna-runtime/agent.log",
    });
  });

  test("lifecycle dry-runs report service commands directly", async () => {
    for (const command of ["stop", "restart", "status"]) {
      const result = await runServerCli([command, "--dry-run"], {});
      expect(result.status).toBe("ok");
      expect(JSON.parse(result.output ?? "{}").command).toBe(`luna-service ${command}`);
    }
  });

  test("lifecycle help never starts, stops, or resets the service", async () => {
    for (const args of [["start", "--foreground"], ["stop"], ["restart"], ["status"], ["db", "reset", "--yes"]]) {
      for (const flag of ["--help", "-h"]) {
        const result = await runServerCli([...args, flag], {});
        expect(result.status).toBe("ok");
        expect(result.output).toContain("Luna Service CLI");
      }
    }
  });

  test("foreground executable honors help before resolving startup options", () => {
    const result = Bun.spawnSync([process.execPath, "src/cli/server-main.ts", "start", "--foreground", "--host", "0.0.0.0", "--help"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, LUNA_DASHBOARD_TOKEN: "luna-local-dev" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Luna Service CLI");
  });

  test("does not expose client workflow commands", async () => {
    await expect(runServerCli(["auth"], {})).resolves.toMatchObject({
      status: "error",
      code: "unknown_luna_service_command",
    });
    await expect(runServerCli(["knowledge"], {})).resolves.toMatchObject({
      status: "error",
      code: "unknown_luna_service_command",
    });
    await expect(runServerCli(["workspace"], {})).resolves.toMatchObject({
      status: "error",
      code: "unknown_luna_service_command",
    });
  });

  test("recognizes luna-service daemon process args", () => {
    expect(
      isLunaCliProcessArgs(
        "/usr/local/bin/bun /usr/local/bin/luna-service start --foreground --port 9000",
      ),
    ).toBe(true);
    expect(
      isLunaCliProcessArgs(
        "/usr/local/bin/bun /app/dist/luna-service.js start --foreground --port 9000",
      ),
    ).toBe(true);
  });
});
