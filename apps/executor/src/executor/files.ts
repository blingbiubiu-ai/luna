import { closeSync, constants, fchownSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { ExecutionError } from "@luna/execution-store";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Linux directory descriptors prevent pathname/symlink swaps during remote file access. */
export class ContextFiles {
  constructor(private readonly root: string, private readonly uid: number, private readonly gid = uid) {
    if (process.platform !== "linux") throw new Error("Executor file operations require Linux /proc/self/fd");
  }
  mkdir(path: string): void { closeSync(this.directory(path, true)); }
  read(path: string): { content: string; sha256: string; size: number } {
    return this.parent(path, false, (directory, leaf) => {
      const fd = this.openFile(directory, leaf);
      try {
        const stat = fstatSync(fd);
        if (stat.size > MAX_FILE_BYTES) throw new ExecutionError(413, "file_too_large");
        // Bound the allocation even when a Runner grows this file concurrently.
        const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (length > MAX_FILE_BYTES) throw new ExecutionError(413, "file_too_large");
        const bytes = buffer.subarray(0, length);
        return { content: bytes.toString("base64"), sha256: hash(bytes), size: bytes.length };
      } finally { closeSync(fd); }
    });
  }
  write(path: string, content: string, expectedHash: string, executable = false): { size: number; sha256: string } {
    const bytes = Buffer.from(content, "base64");
    if (bytes.length > MAX_FILE_BYTES) throw new ExecutionError(413, "file_too_large");
    if (hash(bytes) !== expectedHash) throw new ExecutionError(422, "file_hash_mismatch");
    return this.parent(path, true, (directory, leaf) => {
      const temporary = this.entry(directory, `.luna-write-${randomUUID()}`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fchmodSync(fd, executable ? 0o700 : 0o600); fchownSync(fd, this.uid, this.gid); fsyncSync(fd); }
      catch (error) { unlinkSync(temporary); throw error; }
      finally { closeSync(fd); }
      try { renameSync(temporary, this.entry(directory, leaf)); fsyncSync(directory); }
      catch (error) { unlinkSync(temporary); throw error; }
      return { size: bytes.length, sha256: expectedHash };
    });
  }
  list(path = ""): { name: string; kind: "file" | "directory"; size: number }[] {
    const fd = this.directory(path, false);
    try {
      return readdirSync(this.entry(fd)).map((name) => {
        const stat = lstatSync(this.entry(fd, name));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw new ExecutionError(422, "unsafe_file_type");
        return { name, kind: stat.isDirectory() ? "directory" as const : "file" as const, size: stat.size };
      });
    } finally { closeSync(fd); }
  }
  stat(path: string): { size: number; kind: "file" | "directory"; modifiedAt: number } {
    return this.parent(path, false, (directory, leaf) => {
      const fd = openSync(this.entry(directory, leaf), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if ((!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw new ExecutionError(422, "unsafe_file_type");
        return { size: stat.size, kind: stat.isDirectory() ? "directory" : "file", modifiedAt: stat.mtimeMs };
      } finally { closeSync(fd); }
    });
  }
  delete(path: string): void {
    this.parent(path, false, (directory, leaf) => {
      const target = this.entry(directory, leaf); const stat = lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new ExecutionError(422, "unsafe_file_type");
      if (stat.isDirectory()) rmdirSync(target); else unlinkSync(target);
      fsyncSync(directory);
    });
  }

  private directory(path: string, create: boolean): number {
    let fd = openSync(this.root, directoryFlags);
    try {
      for (const segment of segments(path)) {
        const entry = this.entry(fd, segment);
        if (create) {
          try { mkdirSync(entry, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        }
        const next = openSync(entry, directoryFlags);
        if (create && fstatSync(next).uid === 0) fchownSync(next, this.uid, this.gid);
        closeSync(fd); fd = next;
      }
      return fd;
    } catch (error) { closeSync(fd); throw mapError(error); }
  }
  private parent<T>(path: string, create: boolean, action: (directory: number, leaf: string) => T): T {
    const parts = segments(path); const leaf = parts.pop(); if (!leaf) throw new ExecutionError(422, "file_path_required");
    const directory = this.directory(parts.join("/"), create);
    try { return action(directory, leaf); } catch (error) { throw mapError(error); } finally { closeSync(directory); }
  }
  private openFile(directory: number, leaf: string): number {
    const fd = openSync(this.entry(directory, leaf), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) { closeSync(fd); throw new ExecutionError(422, "unsafe_file_type"); }
    return fd;
  }
  private entry(fd: number, leaf?: string): string { return `/proc/self/fd/${fd}${leaf ? `/${leaf}` : ""}`; }
}
function segments(path: string): string[] {
  if (path.startsWith("/") || /[\\\0]/.test(path)) throw new ExecutionError(422, "invalid_relative_path");
  const values = path.split("/");
  if (values.some((part) => part === ".." || part === ".")) throw new ExecutionError(422, "invalid_relative_path");
  return values.filter(Boolean);
}
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function mapError(error: unknown): unknown {
  if (error instanceof ExecutionError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new ExecutionError(404, "file_not_found");
  if (["ELOOP", "ENOTDIR", "EINVAL"].includes(code ?? "")) return new ExecutionError(422, "unsafe_file_path");
  if (["EACCES", "EPERM"].includes(code ?? "")) return new ExecutionError(403, "file_access_denied");
  if (code === "ENOTEMPTY") return new ExecutionError(409, "directory_not_empty");
  return error;
}
