import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, symlinkSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { prepareRunnerEnvironment } from "@luna/executor/executor/runner-environment";

test("Runner initializes shared tools and caches without replacing files or managed Git identity", () => {
  const home = mkdtempSync(join(tmpdir(), "luna-init-"));
  try {
    const assets = { gradleWrapper: join(home, "assets"), fswatch: join(home, "fswatch") };
    const archive = "dists/gradle-8.2-bin/ectwm6q8tc3mcov8rkhorls2s/gradle-8.2-bin.zip";
    mkdirSync(dirname(join(assets.gradleWrapper, archive)), { recursive: true });
    writeFileSync(join(assets.gradleWrapper, archive), "archive"); writeFileSync(assets.fswatch, "binary");
    const config = join(home, "gitconfig"); writeFileSync(config, '[user]\nname = Luna\n', { mode: 0o444 });
    const base = { HOME: home, LUNA_RUNNER_HOME: join(home, "session-a"), PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: config, GIT_SSH_COMMAND: "ssh -i managed-key", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "test.preserved", GIT_CONFIG_VALUE_0: "yes" };
    const env = prepareRunnerEnvironment(base, assets);
    expect(env.npm_config_prefix).toBe(join(home, ".npm-global"));
    expect(env.PATH!.split(":")).toContain(join(home, ".npm-global/bin"));
    for (const name of [".gradle", ".konan", ".android"]) expect(existsSync(join(home, name))).toBe(true);
    expect(readlinkSync(join(home, ".gradle/wrapper", archive))).toBe(join(assets.gradleWrapper, archive));
    expect(readlinkSync(join(home, ".remoteX/fswatch/linux-amd64/fswatch"))).toBe(assets.fswatch);
    expect(env.GIT_SSH_COMMAND).toBe(base.GIT_SSH_COMMAND);
    expect(execFileSync("git", ["config", "user.name"], { env, encoding: "utf8" }).trim()).toBe("Luna");
    expect(execFileSync("git", ["config", "--get-all", "safe.directory"], { env, encoding: "utf8" }).trim()).toBe("*");
    expect(execFileSync("git", ["config", "test.preserved"], { env, encoding: "utf8" }).trim()).toBe("yes");
    expect(readFileSync(config, "utf8")).toBe('[user]\nname = Luna\n');
    expect(prepareRunnerEnvironment({ ...base, LUNA_RUNNER_HOME: join(home, "session-b") }, assets)).toEqual({ ...env, LUNA_RUNNER_HOME: join(home, "session-b") });
    const custom = prepareRunnerEnvironment({ ...base, NPM_CONFIG_PREFIX: join(home, "npm"), GRADLE_USER_HOME: join(home, "gradle"), KONAN_DATA_DIR: join(home, "konan"), ANDROID_USER_HOME: join(home, "android") }, assets);
    expect(custom.npm_config_prefix).toBe(join(home, "npm"));
    expect(existsSync(join(home, "gradle/wrapper", archive))).toBe(true);
    // Existing user files and dangling symlinks are never overwritten.
    rmSync(join(home, ".gradle/wrapper", archive)); writeFileSync(join(home, ".gradle/wrapper", archive), "user archive");
    const fswatchTarget = join(home, ".remoteX/fswatch/linux-amd64/fswatch");
    rmSync(fswatchTarget); symlinkSync(join(home, "missing-user-binary"), fswatchTarget);
    prepareRunnerEnvironment(base, assets);
    expect(readlinkSync(fswatchTarget)).toBe(join(home, "missing-user-binary"));
    expect(readFileSync(join(home, ".gradle/wrapper", archive), "utf8")).toBe("user archive");
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test.skipIf(process.env.LUNA_DOCKER_INTEGRATION !== "1")("real non-root Runner restores entrypoint setup in a read-only image", () => {
  const output = execFileSync("docker", ["run", "--rm", "--platform", "linux/amd64", "--read-only",
    "--tmpfs", "/tmp:rw,mode=1777", "--tmpfs", "/runner-home:rw,exec,mode=1777",
    "-e", "HOME=/runner-home", "-e", "LUNA_RUNNER_HOME=/runner-home/session",
    "-e", "PATH=/runner-home/.luna-bin:/usr/local/bin:/usr/bin:/bin",
    "-v", `${join(import.meta.dir, "../fixtures/runner-environment-check.sh")}:/verify/check.sh:ro`,
    "--entrypoint", "sh", process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:latest", "/verify/check.sh",
  ], { encoding: "utf8", timeout: 60000 });
  expect(output).toContain('"text":"runner-initialization-ok"');
  expect(output).toContain('"status":"success"');
  expect(output).not.toContain('"status":"error"');
}, 65000);
