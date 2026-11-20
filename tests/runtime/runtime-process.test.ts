import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { writePrivateJson } from "@luna/execution-store";
import { ExecutionClient } from "@luna/execution-transport";
import { RuntimeConfig } from "../../src/runtime/config";

test("Service-owned Runtime preserves mode and drain across process restart", async () => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const root = mkdtempSync(join(tmpdir(), "luna-runtime-process-")); const file = join(root, "runtime.json");
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", dataRoot: root, port, homeWorkerId: "home",  serviceToken: "s".repeat(43), adminToken: "a".repeat(43) });
  writePrivateJson(file, config);
  const client = new ExecutionClient(`http://127.0.0.1:${port}`, config.adminToken);
  writeFileSync(join(root, "config.yaml"), `sandbox:\n  runtimeConfigFile: ${JSON.stringify(file)}\n`);
  const apiProbe = createServer(); await new Promise<void>(resolve => apiProbe.listen(0, "127.0.0.1", resolve));
  const apiPort = (apiProbe.address() as { port: number }).port; await new Promise<void>(resolve => apiProbe.close(() => resolve()));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const start = async () => {
    child = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/cli/server-main.ts"), "start", "--foreground", "--host", "127.0.0.1", "--home", root, "--port", String(apiPort)], { stdout: "ignore", stderr: "ignore" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Runtime exited before listening: ${child.exitCode}`);
      try { await client.call("GET", "/v1/health", undefined, AbortSignal.timeout(500)); return; } catch { await delay(50); }
    }
    throw new Error("Runtime did not listen within 10 seconds");
  };
  const stop = async () => {
    if (!child) return;
    child.kill("SIGTERM"); const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
    try { await child.exited; } finally { clearTimeout(timer); child = undefined; }
  };
  try {
    await start();
    expect(await client.call<{ mode: string; draining: boolean }>("GET", "/v1/mode")).toEqual({ mode: "shared", draining: false });
    await client.call("POST", "/v1/mode/drain");
    await client.call("PUT", "/v1/mode", { mode: "shared" });
    await stop(); await start();
    expect(await client.call<{ mode: string; draining: boolean }>("GET", "/v1/mode")).toEqual({ mode: "shared", draining: true });
    expect(await client.call<{ mode: string; draining: boolean }>("POST", "/v1/mode/resume")).toEqual({ mode: "shared", draining: false });
  } finally { await stop(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
