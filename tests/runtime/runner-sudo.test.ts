import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureRunnerSudo, RUNNER_SUDOERS, runnerSetprivArgs } from "../../apps/executor/src/executor/runner-sudo";
import { ensureRunnerWorkspaceInstructionFiles } from "@luna/host-runtime/runner-instructions";
import { nosuidStartupWarning, rootHostCheck } from "../../apps/worker/src/root-host";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "luna-runner-sudo-"));
  mkdirSync(join(root, "etc/sudoers.d"), { recursive: true });
  writeFileSync(join(root, "etc/passwd"), "root:x:0:0:root:/root:/bin/bash\nrunner:x:1000:1000::/home/runner:/bin/sh\n");
  writeFileSync(join(root, "etc/group"), "root:x:0:\nrunner:x:1000:\n");
  writeFileSync(join(root, "etc/shadow"), "root:*:19000:0:99999:7:::\nrunner:*:19000:0:99999:7:::\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("restricted Runners keep an empty bounding set and no_new_privs; sudo Runners keep only a cleared inheritable set", () => {
  expect(runnerSetprivArgs("502", "20", false)).toEqual(["--reuid=502", "--regid=20", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs"]);
  expect(runnerSetprivArgs("502", "20", true)).toEqual(["--reuid=502", "--regid=20", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all"]);
});

test("enabling sudo adds an account for the host UID and a 0440 rule; disabling removes the rule", () => {
  configureRunnerSudo({ root, uid: 502, gid: 20, home: "/data/home", enabled: true });
  expect(readFileSync(join(root, "etc/passwd"), "utf8")).toContain("luna:x:502:20:Luna Runner:/data/home:/bin/bash\n");
  expect(readFileSync(join(root, "etc/group"), "utf8")).toContain("luna:x:20:\n");
  expect(readFileSync(join(root, "etc/shadow"), "utf8")).toContain("luna:*:19000:0:99999:7:::\n");
  expect(readFileSync(join(root, RUNNER_SUDOERS), "utf8")).toBe("#502 ALL=(ALL) NOPASSWD:ALL\n");
  expect(statSync(join(root, RUNNER_SUDOERS)).mode & 0o777).toBe(0o440);
  // Restarting the container must not duplicate accounts.
  configureRunnerSudo({ root, uid: 502, gid: 20, home: "/data/home", enabled: true });
  expect(readFileSync(join(root, "etc/passwd"), "utf8").match(/:502:/g)).toHaveLength(1);
  expect(readFileSync(join(root, "etc/shadow"), "utf8").match(/^luna:/gm)).toHaveLength(1);
  configureRunnerSudo({ root, uid: 502, gid: 20, home: "/data/home", enabled: false });
  expect(existsSync(join(root, RUNNER_SUDOERS))).toBe(false);
});

test("an id the image already knows is reused instead of adding a second account", () => {
  configureRunnerSudo({ root, uid: 1000, gid: 1000, home: "/data/home", enabled: true });
  expect(readFileSync(join(root, "etc/passwd"), "utf8").match(/:1000:/g)).toHaveLength(1);
  expect(readFileSync(join(root, RUNNER_SUDOERS), "utf8")).toBe("#1000 ALL=(ALL) NOPASSWD:ALL\n");
});

test("root-access rules are appended to Runner instructions only when the Worker enables sudo", () => {
  const render = (runnerSudo: boolean) => {
    const cwd = mkdtempSync(join(root, "runner-"));
    const result = ensureRunnerWorkspaceInstructionFiles({ home: "/data/home", promptsRoot: join(import.meta.dir, "../../src/prompts"), runnerKind: "work", runnerRootPath: cwd, previousFingerprint: null, runnerSudo });
    return { text: readFileSync(join(cwd, "AGENTS.md"), "utf8"), fingerprint: result.instructionFingerprint };
  };
  const off = render(false), on = render(true);
  expect(off.text).not.toContain("## Root access");
  expect(on.text).toContain("## Root access");
  expect(on.text).toContain("luna root status --user");
  expect(on.fingerprint).not.toBe(off.fingerprint);
});

test("root needs a nosuid HOME on Linux, is allowed on Docker Desktop and refused elsewhere", () => {
  expect(rootHostCheck("/h", "darwin", () => { throw new Error("unused"); })).toEqual({ allowed: true });
  expect(rootHostCheck("/h", "linux", () => "rw,nosuid,nodev,relatime")).toEqual({ allowed: true });
  expect(rootHostCheck("/h", "linux", () => "rw,relatime")).toEqual({ allowed: false, reason: "home_requires_nosuid" });
  expect(rootHostCheck("/h", "linux", () => { throw new Error("findmnt missing"); })).toEqual({ allowed: false, reason: "home_requires_nosuid" });
  expect(rootHostCheck("/h", "win32")).toEqual({ allowed: false, reason: "unsupported_host" });
});

test("Worker startup warns with the fix when its data root is not nosuid", () => {
  const warning = nosuidStartupWarning("/var/lib/luna-worker", "linux", () => "rw,relatime");
  expect(warning).toContain("mount -o remount,bind,nosuid /var/lib/luna-worker");
  expect(warning).toContain("/var/lib/luna-worker /var/lib/luna-worker none bind,nosuid 0 0");
  expect(nosuidStartupWarning("/var/lib/luna-worker", "linux", () => "rw,nosuid,relatime")).toBeUndefined();
  expect(nosuidStartupWarning("/w", "darwin")).toBeUndefined();
  expect(nosuidStartupWarning("/w", "win32")).toBeUndefined();
});
