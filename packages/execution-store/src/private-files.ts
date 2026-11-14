import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Deployment-owned directories only; never use Runner-controlled paths here. */
export function readPrivateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Execution configuration must be a private regular file");
    return JSON.parse(readFileSync(fd, "utf8")) as unknown;
  } finally { closeSync(fd); }
}

/** Atomic private config replacement. The parent directory is deployment-owned. */
export function writePrivateJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.write-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  catch (error) { unlinkSync(temporary); throw error; }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(parent, constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
