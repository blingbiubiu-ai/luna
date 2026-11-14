import { expect, test } from "bun:test";
import { RuntimeConfig } from "../../src/runtime/config";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Worker init selects its own image; Runtime init needs no Docker", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-variant-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$3" > "$IMAGE_RECORD"\nprintf "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n"\n', { mode: 0o755 });
    for (const [name, args, image] of [
      ["default", [], "luna-runner:latest"],
      ["android", ["--image", "luna-runner-android:latest"], "luna-runner-android:latest"],
      ["custom", ["--image", "custom:dev"], "custom:dev"],
    ] as const) {
      const record = join(root, `${name}.image`);
      const result = Bun.spawnSync([process.execPath, resolve("apps/worker/src/main.ts"), "init", "--home", join(root, name), ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, IMAGE_RECORD: record } });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(record, "utf8").trim()).toBe(image);
    }
    writeFileSync(join(bin, "docker"), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const home = join(root, "service");
    const runtime = Bun.spawnSync([process.execPath, resolve("src/cli/server-main.ts"), "runtime", "init", "--home", home], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(runtime.exitCode).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, "runtime/runtime.json"), "utf8"));
    expect(saved.imageDigest).toBeUndefined();
    expect(RuntimeConfig.safeParse({ ...saved, imageDigest: `sha256:${"a".repeat(64)}` }).success).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
