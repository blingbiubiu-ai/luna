import { appendFileSync, chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { z } from "zod";
import { ExecutionError } from "@luna/execution-store";
import { Id } from "@luna/runner-protocol";

/** One file may be this large; it arrives in pieces small enough for the Service link. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** An upload not finished within this long is abandoned and its pieces deleted. */
const STALE_UPLOAD_MS = 60 * 60 * 1000;

export const UploadChunk = z.object({
  agentId: Id, shadowId: Id,
  uploadId: z.string().uuid(),
  /** Directory relative to the Shadow's HOME, `~/`-prefixed, or an absolute path inside it. */
  dir: z.string().max(1024),
  name: z.string().min(1).max(255),
  offset: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  content: z.string().max(Math.ceil(MAX_UPLOAD_CHUNK_BYTES / 3) * 4),
  final: z.boolean(),
}).strict();
export type UploadChunk = z.infer<typeof UploadChunk>;

export type UploadResult = { done: false; received: number } | { done: true; path: string; size: number };

/**
 * Files the owner uploads into a Shadow's HOME from the Dashboard. Pieces collect in a Worker
 * directory outside HOME, so the Shadow never sees a partial file; the last piece moves the
 * whole file into HOME under a name that does not replace an existing one.
 */
export class HomeUploads {
  constructor(private readonly root: string) {}

  write(home: string, chunk: UploadChunk): UploadResult {
    const name = fileName(chunk.name);
    const target = targetDirectory(home, chunk.dir);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (chunk.offset === 0) this.sweep();
    const partial = join(this.root, chunk.uploadId);
    const received = size(partial);
    if (chunk.offset !== received) throw new ExecutionError(409, "upload_offset_mismatch", { received });
    const bytes = Buffer.from(chunk.content, "base64");
    if (bytes.length > MAX_UPLOAD_CHUNK_BYTES) throw new ExecutionError(413, "upload_chunk_too_large");
    if (received + bytes.length > MAX_UPLOAD_BYTES) { rmSync(partial, { force: true }); throw new ExecutionError(413, "upload_too_large"); }
    appendFileSync(partial, bytes, { mode: 0o600 });
    if (!chunk.final) return { done: false, received: received + bytes.length };
    const directory = ensureDirectory(home, target);
    const path = join(directory, freeName(directory, name));
    try { renameSync(partial, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      copyFileSync(partial, path); rmSync(partial, { force: true });
    }
    // Pieces are private to the Worker; the finished file reads like any other in HOME.
    chmodSync(path, 0o644);
    return { done: true, path, size: received + bytes.length };
  }

  /** Drop pieces of uploads abandoned long ago. */
  private sweep(): void {
    for (const entry of readdirSync(this.root)) {
      const path = join(this.root, entry);
      try { if (Date.now() - statSync(path).mtimeMs > STALE_UPLOAD_MS) rmSync(path, { force: true }); } catch { /* raced */ }
    }
  }
}

function fileName(raw: string): string {
  const name = raw.trim();
  if (!name || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name)) throw new ExecutionError(400, "upload_name_invalid");
  return name;
}

/** The target directory's parts below HOME; nothing may climb out of it. */
function targetDirectory(home: string, raw: string): string[] {
  let dir = raw.trim();
  if (dir === "~" || dir.startsWith("~/")) dir = dir.slice(1);
  else if (dir.startsWith("/")) {
    if (dir !== home && !dir.startsWith(home + "/")) throw new ExecutionError(400, "upload_directory_outside_home");
    dir = dir.slice(home.length);
  }
  const parts = dir.split("/").filter(part => part && part !== ".");
  if (parts.some(part => part === ".." || /[\\\x00-\x1f]/.test(part))) throw new ExecutionError(400, "upload_directory_invalid");
  return parts;
}

/** Create the directory under HOME, refusing symlinks and files on the way so it stays inside HOME. */
function ensureDirectory(home: string, parts: string[]): string {
  let path = home;
  for (const part of parts) {
    path = join(path, part);
    const prior = lstat(path);
    if (prior && (prior.isSymbolicLink() || !prior.isDirectory())) throw new ExecutionError(409, "upload_directory_unsafe");
    if (!prior) mkdirSync(path, { mode: 0o755 });
  }
  if (path !== home && !path.startsWith(home + sep)) throw new ExecutionError(409, "upload_directory_unsafe");
  return path;
}

/** `name`, or `name (1).ext`, `name (2).ext`… when it is taken. */
function freeName(directory: string, name: string): string {
  const extension = extname(name) && extname(name) !== name ? extname(name) : "";
  const stem = name.slice(0, name.length - extension.length);
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${extension}`;
    if (!lstat(join(directory, candidate))) return candidate;
  }
}

function size(path: string): number { return lstat(path)?.size ?? 0; }
function lstat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
