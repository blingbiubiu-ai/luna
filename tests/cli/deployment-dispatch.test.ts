import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deploymentEntrypoint } from "../../apps/cli/src/deployment";

const root = mkdtempSync(join(tmpdir(), "luna-cli-dispatch-"));
const cli = join(root, "luna-client.js");
const source = resolve("apps/cli/src/main.ts");
const env = { ...process.env, LUNA_HOME: root };
beforeAll(async () => {
  const result = await Bun.build({ entrypoints: [source], outdir: root, naming: "luna-client.js", target: "bun" });
  expect(result.success).toBe(true);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function run(file: string, args: string[]) {
  const child = Bun.spawn([process.execPath, file, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

test("unified and legacy source entrypoints share help and service options", async () => {
  for (const [component, legacy] of [["service", "src/cli/server-main.ts"], ["worker", "apps/worker/src/main.ts"]] as const) {
    const unified = await run(source, [component, "--help"]);
    expect(unified).toEqual(await run(resolve(legacy), ["--help"]));
    expect(unified.exitCode).toBe(0);
    expect(unified.stdout).toContain(`luna ${component}`);
  }
  const args = ["start", "--dry-run", "--port", "9123", "--home", join(root, "home with spaces")];
  expect(await run(source, ["service", ...args])).toEqual(await run(resolve("src/cli/server-main.ts"), args));
});

test("packaged forwarding preserves argv, stdin, environment, output and exit status", async () => {
  writeFileSync(join(root, "luna-worker.js"), `console.log(JSON.stringify({args: process.argv.slice(2), value: process.env.LUNA_HOME, input: await Bun.stdin.text()})); console.error('component stderr'); process.exit(42);`);
  const child = Bun.spawn([process.execPath, cli, "worker", "bind", "--service", "https://example.test", "argument with spaces"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write("binding-code\n");
  child.stdin.end();
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ args: ["bind", "--service", "https://example.test", "argument with spaces"], value: root, input: "binding-code\n" });
  expect(await new Response(child.stderr).text()).toBe("component stderr\n");
  expect(await child.exited).toBe(42);
});

test("foreground wrapper forwards termination to the component", async () => {
  writeFileSync(join(root, "luna-service.js"), `process.on('SIGTERM', () => { console.log('stopped'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);`);
  const child = Bun.spawn([process.execPath, cli, "service", "start", "--foreground"], { env, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    child.kill("SIGTERM");
    let remaining = "";
    for (;;) { const next = await reader.read(); if (next.done) break; remaining += new TextDecoder().decode(next.value); }
    expect(remaining).toContain("stopped");
    expect(await child.exited).toBe(0);
  } finally { child.kill(); }
});

test("component resolution supports separate PATH installation and clear missing-component errors", () => {
  const isolated = join(root, "isolated"); mkdirSync(isolated);
  const bin = join(root, "bin"); mkdirSync(bin);
  const worker = join(root, "installed-worker.js"); writeFileSync(worker, "", { mode: 0o755 });
  symlinkSync(worker, join(bin, "luna-worker"));
  expect(deploymentEntrypoint("worker", { PATH: bin }, isolated)).toBe(realpathSync(worker));
  expect(() => deploymentEntrypoint("service", { PATH: "" }, isolated)).toThrow("luna service is not installed");
});
