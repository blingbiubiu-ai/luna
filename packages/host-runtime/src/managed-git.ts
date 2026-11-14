import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Preserve the managed SSH identity and pinned host keys used by the Docker runner. */
export function managedGitSsh(home: string) {
  const directory = join(home, ".ssh");
  const key = ["id_codebase", "id_ed25519", "id_ecdsa", "id_rsa"]
    .find(name => existsSync(join(directory, name)));
  if (!key || !existsSync(join(directory, "known_hosts"))) return undefined;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return { directory, command: ["ssh", "-i", quote(join(directory, key)), "-o", "IdentitiesOnly=yes",
    "-o", `UserKnownHostsFile=${quote(join(directory, "known_hosts"))}`, "-o", "StrictHostKeyChecking=yes"].join(" ") };
}

export function managedGitEnvironment(home: string, identity?: { authorName: string; authorEmail: string }): Record<string, string> {
  const env: Record<string, string> = {};
  const ssh = managedGitSsh(home);
  if (ssh) env.GIT_SSH_COMMAND = ssh.command;
  if (identity) {
    const quote = (value: string) => {
      if (!value.trim() || /[\0\r\n]/.test(value)) throw new Error("Managed Git identity must be a non-empty single line");
      return `"${value.trim().replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    };
    const path = join(home, ".runner-gitconfig");
    writeFileSync(path, `[user]\n\tname = ${quote(identity.authorName)}\n\temail = ${quote(identity.authorEmail)}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);
    env.GIT_CONFIG_GLOBAL = path;
  }
  return env;
}
