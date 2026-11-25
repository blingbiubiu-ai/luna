import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUNNER_SUDOERS = "etc/sudoers.d/luna-runner";

const CONTAINER_LUNA_WRAPPER = [
  "#!/usr/bin/env bash",
  "# The CLI shipped with the Worker (mounted read-only) is current; the baked copy serves older Workers.",
  'if [ -f /opt/luna-runtime/current/luna-client.js ]; then exec bun /opt/luna-runtime/current/luna-client.js "$@"; fi',
  'exec bun /app/luna-cli/cli.js "$@"',
  "",
].join("\n");

const CONTAINER_LUNA_PATH_PROFILE =
  'export PATH="$HOME/.luna-resources/commands:$HOME/.local/bin:/opt/luna-runtime/current/bin:$PATH"\n';

const CONTAINER_LUNA_PROMPT_PROFILE = [
  "# Runners use the Worker host UID, which has no passwd entry in the image;",
  '# show "luna" instead of bash\'s "I have no name!".',
  'if [ -n "${BASH-}" ] && [ -n "${PS1-}" ] && ! id -un >/dev/null 2>&1; then',
  "  PS1=$(printf '%s' \"$PS1\" | sed 's/\\\\u/luna/g')",
  "  export USER=luna",
  "fi",
  "",
].join("\n");

const CONTAINER_NPM_GLOBAL_PROFILE = [
  "# The service supplies the persistent home for this runner at launch.",
  'if [ -n "${HOME:-}" ]; then',
  '  export npm_config_prefix="${npm_config_prefix:-${NPM_CONFIG_PREFIX:-$HOME/.npm-global}}"',
  '  case ":$PATH:" in',
  '    *":$npm_config_prefix/bin:"*) ;;',
  '    *) export PATH="$PATH:$npm_config_prefix/bin" ;;',
  "  esac",
  "fi",
  "",
].join("\n");

/**
 * Reconciles Luna-owned entry shims and login-shell profiles inside the container rootfs on
 * every Executor boot (`UID 0`). Base images only need to carry third-party OS packages and
 * runtimes; container-side Luna wrappers never drift behind the Worker-mounted runtime.
 */
export function reconcileContainerShims(input: { root?: string } = {}): void {
  const root = input.root ?? "/";
  const entries: ReadonlyArray<{ relPath: string; content: string; mode: number }> = [
    { relPath: "usr/local/bin/luna", content: CONTAINER_LUNA_WRAPPER, mode: 0o755 },
    { relPath: "etc/profile.d/luna-path.sh", content: CONTAINER_LUNA_PATH_PROFILE, mode: 0o644 },
    { relPath: "etc/profile.d/luna-prompt.sh", content: CONTAINER_LUNA_PROMPT_PROFILE, mode: 0o644 },
    { relPath: "etc/profile.d/luna-npm-global.sh", content: CONTAINER_NPM_GLOBAL_PROFILE, mode: 0o644 },
  ];
  for (const { relPath, content, mode } of entries) {
    const dest = join(root, relPath);
    try {
      if (existsSync(dest) && readFileSync(dest, "utf8") === content && ( chmodCheck(dest, mode) )) {
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = `${dest}.luna-tmp-${process.pid}`;
      writeFileSync(tmp, content, { mode });
      chmodSync(tmp, mode);
      renameSync(tmp, dest);
    } catch {
      // Non-root unit test harnesses without a writable root skip system shim updates gracefully.
    }
  }
}

function chmodCheck(path: string, mode: number): boolean {
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

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

/** setpriv flags for a Runner process; sudo needs a usable bounding set and no no_new_privs. */
export function runnerSetprivArgs(uid: string, gid: string, sudo: boolean): string[] {
  return [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all",
    ...(sudo ? [] : ["--bounding-set=-all", "--no-new-privs"])];
}
