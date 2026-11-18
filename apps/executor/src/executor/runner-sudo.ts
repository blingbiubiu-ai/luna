import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const RUNNER_SUDOERS = "etc/sudoers.d/luna-runner";

/**
 * Shadow root switch: give the Runner UID passwordless sudo inside this container.
 * Only Jobs started with `privileged` can use it; others keep no_new_privs.
 * The host UID has no account in the image and sudo refuses unknown users, so an
 * account is added first. Disabled, the rule is removed (the container is normally
 * replaced on a toggle, because the flag is part of the Executor configuration).
 */
export function configureRunnerSudo(input: { root?: string; uid: number; gid: number; home: string; enabled: boolean }): void {
  const root = input.root ?? "/";
  const rule = join(root, RUNNER_SUDOERS);
  if (!input.enabled) { rmSync(rule, { force: true }); return; }
  const name = ensureRunnerAccount(input);
  // PAM's account check (sudo) needs a shadow entry; "*" allows no password login.
  ensureShadow(join(root, "etc/shadow"), name);
  // Write-then-rename so sudo never reads a partial rule; sudo requires 0440.
  const temporary = `${rule}.tmp`;
  writeFileSync(temporary, `#${input.uid} ALL=(ALL) NOPASSWD:ALL\n`, { mode: 0o440 });
  chmodSync(temporary, 0o440);
  renameSync(temporary, rule);
}

/**
 * The Runner UID is the Worker's host UID, which the image does not know: give it the account
 * `luna` with the Shadow HOME, so shells and tools see a name and a home. An image account that
 * already has the UID (the image's own runner at 1000) is taken over; root is never touched.
 */
export function ensureRunnerAccount(input: { root?: string; uid: number; gid: number; home: string }): string {
  const root = input.root ?? "/";
  ensureEntry(join(root, "etc/group"), input.gid, `luna:x:${input.gid}:`);
  return ensureEntry(join(root, "etc/passwd"), input.uid, `luna:x:${input.uid}:${input.gid}:Luna Runner:${input.home}:/bin/bash`);
}

/** Add or take over the account line for the numeric id, unless it is root's; returns its name. */
function ensureEntry(file: string, id: number, line: string): string {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Both passwd and group keep the numeric id in the third field.
  const prior = existing.split("\n").find(entry => entry.split(":")[2] === String(id));
  if (prior && (id === 0 || prior.startsWith("luna:"))) return prior.split(":")[0]!;
  if (prior) {
    const others = existing.split("\n").filter(entry => entry !== prior);
    const name = others.some(entry => entry.startsWith("luna:")) ? `luna${id}` : "luna";
    writeFileSync(file, existing.replace(prior, line.replace(/^luna:/, `${name}:`)));
    return name;
  }
  // Another account may already be called "luna"; use a numbered name then.
  const name = existing.split("\n").some(entry => entry.startsWith("luna:")) ? `luna${id}` : "luna";
  appendFileSync(file, (existing === "" || existing.endsWith("\n") ? "" : "\n") + line.replace(/^luna:/, `${name}:`) + "\n");
  return name;
}

function ensureShadow(file: string, name: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.split("\n").some(entry => entry.startsWith(`${name}:`))) return;
  appendFileSync(file, (existing === "" || existing.endsWith("\n") ? "" : "\n") + `${name}:*:19000:0:99999:7:::\n`);
}

/** Clear setuid/setgid bits and root ownership left in HOME (see container/luna-home-sanitize). */
export function sanitizeHome(home: string, uid: number, gid: number): void {
  spawnSync("/usr/local/bin/luna-home-sanitize", [home, String(uid), String(gid)], { stdio: "ignore", timeout: 120000 });
}

/** setpriv flags for a Runner process; sudo needs a usable bounding set and no no_new_privs. */
export function runnerSetprivArgs(uid: string, gid: string, sudo: boolean): string[] {
  return [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all",
    ...(sudo ? [] : ["--bounding-set=-all", "--no-new-privs"])];
}
