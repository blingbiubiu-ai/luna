import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { managedGitEnvironment, managedGitSsh } from "@luna/host-runtime/managed-git";

test("managed Git restores explicit SSH credentials and a correctly quoted author without copying keys", () => {
  const home = mkdtempSync(join(tmpdir(), "luna git's "));
  try {
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh/id_rsa"), "private-test-key");
    expect(managedGitSsh(home)).toBeUndefined();
    writeFileSync(join(home, ".ssh/known_hosts"), "pinned-host-key");
    const env = managedGitEnvironment(home, { authorName: 'Luna "Employee"', authorEmail: "luna@example.test" });
    expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    expect(JSON.stringify(env)).not.toContain("private-test-key");
    const argv = JSON.parse(execFileSync("sh", ["-c", env.GIT_SSH_COMMAND!.replace(/^ssh /, `${process.execPath} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- `)], { encoding: "utf8" }));
    expect(argv).toContain(join(home, ".ssh/id_rsa"));
    expect(argv).toContain(`UserKnownHostsFile=${join(home, ".ssh/known_hosts")}`);
    expect(execFileSync("git", ["config", "--file", env.GIT_CONFIG_GLOBAL!, "user.name"], {encoding: "utf8"}).trim()).toBe('Luna "Employee"');
    expect(() => managedGitEnvironment(home, {authorName: "invalid\nname", authorEmail: "test"})).toThrow();
  } finally { rmSync(home, {recursive: true, force: true}); }
});
