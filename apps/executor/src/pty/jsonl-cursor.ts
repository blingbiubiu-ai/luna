import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const SCAN_CHUNK_BYTES = 64 * 1024;

export interface JsonlDrainResult {
  readonly lines: readonly string[];
  readonly newOffset: number;
  readonly reset: boolean;
}

export function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function currentRegularFileSize(path: string): number {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Incrementally read complete `\n`-terminated UTF-8 lines from an append-only JSONL file.
 * Trailing partial lines without `\n` stay unread until the writer flushes the newline.
 * Opens with `O_NONBLOCK` and verifies `isFile()` so FIFOs/symlinks never block or redirect.
 */
export function drainJsonlLines(path: string, fromOffset: number): JsonlDrainResult {
  if (!existsSync(path)) {
    return { lines: [], newOffset: fromOffset, reset: false };
  }
  let fd: number | null = null;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const nonBlock = constants.O_NONBLOCK ?? 0;
    fd = openSync(path, constants.O_RDONLY | nonBlock | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { lines: [], newOffset: fromOffset, reset: false };
    }
    const reset = stat.size < fromOffset;
    let nextReadOffset = reset ? 0 : Math.max(0, fromOffset);
    if (stat.size <= nextReadOffset) {
      return { lines: [], newOffset: nextReadOffset, reset };
    }

    let lineStartOffset = nextReadOffset;
    let lineBuffers: Buffer[] = [];
    let lineBytes = 0;
    const lines: string[] = [];
    const buf = Buffer.alloc(SCAN_CHUNK_BYTES);

    while (nextReadOffset < stat.size) {
      const toRead = Math.min(SCAN_CHUNK_BYTES, stat.size - nextReadOffset);
      const bytesRead = readSync(fd, buf, 0, toRead, nextReadOffset);
      if (bytesRead <= 0) break;
      nextReadOffset += bytesRead;

      let searchFrom = 0;
      let nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      while (nl >= 0) {
        const segment = Buffer.from(buf.subarray(searchFrom, nl));
        if (segment.length > 0) {
          lineBuffers.push(segment);
          lineBytes += segment.length;
        }
        const raw = lineBuffers.length === 1
          ? (lineBuffers[0] ?? Buffer.alloc(0))
          : Buffer.concat(lineBuffers, lineBytes);
        lines.push(raw.toString("utf8").replace(/\r$/, ""));
        searchFrom = nl + 1;
        lineStartOffset += lineBytes + 1;
        lineBuffers = [];
        lineBytes = 0;
        const rel = buf.subarray(searchFrom, bytesRead).indexOf(0x0a);
        nl = rel >= 0 ? searchFrom + rel : -1;
      }
      if (searchFrom < bytesRead) {
        const tail = Buffer.from(buf.subarray(searchFrom, bytesRead));
        lineBuffers.push(tail);
        lineBytes += tail.length;
      }
    }

    return { lines, newOffset: lineStartOffset, reset };
  } catch {
    return { lines: [], newOffset: fromOffset, reset: false };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore close error */ }
    }
  }
}

/** Atomically write a 0600 JSON file inside a 0700 directory without exposing partial contents. */
export function writePrivateJsonAtomic(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
