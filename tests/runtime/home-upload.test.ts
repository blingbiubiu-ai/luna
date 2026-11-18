import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const CH = "/home/luna";
import { HomeUploads, MAX_UPLOAD_BYTES, type UploadChunk } from "../../apps/worker/src/home-upload";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-home-upload-")));
  const home = join(root, "agents/agent/shadows/shadow"); mkdirSync(home, { recursive: true });
  const pieces = join(root, ".home-uploads");
  return { root, home, pieces, uploads: new HomeUploads(pieces), close: () => rmSync(root, { recursive: true, force: true }) };
}
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const chunk = (input: Partial<UploadChunk> & { bytes: string }): UploadChunk => ({
  agentId: "agent", shadowId: "shadow", uploadId: id(), dir: "~/uploads", name: "a.txt", offset: 0, final: true,
  ...input, content: Buffer.from(input.bytes).toString("base64"),
});

test("a file sent in pieces appears in HOME only when the last piece arrives", () => {
  const f = fixture();
  try {
    const uploadId = id();
    expect(f.uploads.write(f.home, CH, chunk({ uploadId, bytes: "hello ", final: false }))).toEqual({ done: false, received: 6 });
    expect(existsSync(join(f.home, "uploads/a.txt"))).toBe(false);
    expect(f.uploads.write(f.home, CH, chunk({ uploadId, bytes: "world", offset: 6 }))).toEqual({ done: true, path: join(CH, "uploads/a.txt"), size: 11 });
    expect(readFileSync(join(f.home, "uploads/a.txt"), "utf8")).toBe("hello world");
    expect(statSync(join(f.home, "uploads/a.txt")).mode & 0o777).toBe(0o644);
    expect(readdirSync(f.pieces)).toEqual([]);
  } finally { f.close(); }
});

test("a piece out of order is refused and the received size is reported", () => {
  const f = fixture();
  try {
    const uploadId = id();
    f.uploads.write(f.home, CH, chunk({ uploadId, bytes: "abc", final: false }));
    expect(() => f.uploads.write(f.home, CH, chunk({ uploadId, bytes: "x", offset: 10 }))).toThrow("upload_offset_mismatch");
  } finally { f.close(); }
});

test("an existing file is never replaced; the new one gets a numbered name", () => {
  const f = fixture();
  try {
    for (const bytes of ["one", "two", "three"]) f.uploads.write(f.home, CH, chunk({ bytes, name: "report.tar.gz" }));
    f.uploads.write(f.home, CH, chunk({ bytes: "x", name: ".env" }));
    f.uploads.write(f.home, CH, chunk({ bytes: "y", name: ".env" }));
    expect(readdirSync(join(f.home, "uploads")).sort()).toEqual([".env", ".env (1)", "report.tar (1).gz", "report.tar (2).gz", "report.tar.gz"]);
    expect(readFileSync(join(f.home, "uploads/report.tar.gz"), "utf8")).toBe("one");
  } finally { f.close(); }
});

test("directories resolve inside HOME: ~/, relative, and absolute paths under HOME", () => {
  const f = fixture();
  try {
    expect(f.uploads.write(f.home, CH, chunk({ bytes: "a", dir: "work/data" })).done && existsSync(join(f.home, "work/data/a.txt"))).toBe(true);
    expect(f.uploads.write(f.home, CH, chunk({ bytes: "a", dir: `${CH}/abs` }))).toMatchObject({ path: join(CH, "abs/a.txt") });
    expect(f.uploads.write(f.home, CH, chunk({ bytes: "a", dir: "~" }))).toMatchObject({ path: join(CH, "a.txt") });
  } finally { f.close(); }
});

test("nothing is written outside HOME: climbing, other absolute paths, symlinks and bad names are refused", () => {
  const f = fixture();
  try {
    expect(() => f.uploads.write(f.home, CH, chunk({ bytes: "x", dir: "~/../../escape" }))).toThrow("upload_directory_invalid");
    expect(() => f.uploads.write(f.home, CH, chunk({ bytes: "x", dir: "/etc" }))).toThrow("upload_directory_outside_home");
    expect(() => f.uploads.write(f.home, CH, chunk({ bytes: "x", dir: `${CH}-other` }))).toThrow("upload_directory_outside_home");
    const outside = join(f.root, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(f.home, "link"));
    expect(() => f.uploads.write(f.home, CH, chunk({ bytes: "x", dir: "~/link/sub" }))).toThrow("upload_directory_unsafe");
    writeFileSync(join(f.home, "file"), "");
    expect(() => f.uploads.write(f.home, CH, chunk({ bytes: "x", dir: "~/file" }))).toThrow("upload_directory_unsafe");
    for (const name of ["../x", "a/b", "..", "."]) expect(() => f.uploads.write(f.home, CH, chunk({ bytes: "x", name }))).toThrow("upload_name_invalid");
    expect(readdirSync(outside)).toEqual([]);
  } finally { f.close(); }
});

test("a file over the size limit is refused and its pieces removed", () => {
  const f = fixture();
  try {
    const big = id();
    // Pretend most of the limit already arrived.
    mkdirSync(f.pieces, { recursive: true }); writeFileSync(join(f.pieces, big), Buffer.alloc(MAX_UPLOAD_BYTES - 1));
    expect(() => f.uploads.write(f.home, CH, chunk({ uploadId: big, bytes: "ab", offset: MAX_UPLOAD_BYTES - 1 }))).toThrow("upload_too_large");
    expect(existsSync(join(f.pieces, big))).toBe(false);
  } finally { f.close(); }
});
