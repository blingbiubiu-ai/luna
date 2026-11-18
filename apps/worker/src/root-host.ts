import { execFileSync } from "node:child_process";

export type RootHostCheck = { allowed: true } | { allowed: false; reason: "home_requires_nosuid" | "unsupported_host" };

/**
 * Whether a Shadow HOME on this host may back a container that allows sudo.
 * Root inside the container can plant setuid binaries in the bind-mounted HOME; on Linux
 * those are real host files, so the HOME's filesystem must be mounted nosuid. Docker
 * Desktop (macOS) maps container root to the host user and drops setuid bits.
 */
export function rootHostCheck(path: string, platform: NodeJS.Platform = process.platform,
  mountOptions: (path: string) => string = findmntOptions): RootHostCheck {
  if (platform === "darwin") return { allowed: true };
  if (platform !== "linux") return { allowed: false, reason: "unsupported_host" };
  let options: string;
  try { options = mountOptions(path); } catch { return { allowed: false, reason: "home_requires_nosuid" }; }
  return options.split(",").map(option => option.trim()).includes("nosuid") ? { allowed: true } : { allowed: false, reason: "home_requires_nosuid" };
}

function findmntOptions(path: string): string {
  return execFileSync("findmnt", ["--noheadings", "--output", "OPTIONS", "--target", path], { encoding: "utf8", timeout: 5000 }).trim();
}

/**
 * Startup advice when Shadow root cannot take effect on this host: the Worker data root (which
 * holds every Shadow HOME) is not on a nosuid mount. Undefined when root can work.
 */
export function nosuidStartupWarning(dataRoot: string, platform: NodeJS.Platform = process.platform,
  mountOptions: (path: string) => string = findmntOptions): string | undefined {
  const check = rootHostCheck(dataRoot, platform, mountOptions);
  if (check.allowed || check.reason !== "home_requires_nosuid") return undefined;
  return `Worker data root ${dataRoot} is not mounted nosuid, so Shadow root access stays off on this host. `
    + `To enable it, run as root: mount --bind ${dataRoot} ${dataRoot} && mount -o remount,bind,nosuid ${dataRoot}; `
    + `add "${dataRoot} ${dataRoot} none bind,nosuid 0 0" to /etc/fstab; then reset the system disk of root-enabled Shadows.`;
}
