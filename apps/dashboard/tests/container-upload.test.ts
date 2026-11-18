import { expect, test } from "bun:test";

import { UPLOAD_CHUNK_BYTES, uploadFile } from "../src/components/container-upload";
import type { ContainerRow } from "../src/lib/containers";

const row = { workerId: "w 1", environmentId: "env_1", shadowId: "s1" } as ContainerRow;

test("a file goes up in pieces with offsets, and the last piece returns its path", async () => {
  const size = UPLOAD_CHUNK_BYTES * 2 + 5;
  const file = Object.assign(new Blob([new Uint8Array(size)]), { name: "数据 a.bin" });
  const calls: { path: string; params: URLSearchParams; bytes: number }[] = [];
  const progress: number[] = [];
  const fetchPiece = (async (path: string, init?: RequestInit) => {
    const [base, query] = path.split("?");
    calls.push({ path: base!, params: new URLSearchParams(query), bytes: (init!.body as Blob).size });
    return new URLSearchParams(query).get("final") === "1" ? { done: true, path: "/home/s1/uploads/数据 a.bin" } : { done: false };
  }) as never;
  expect(await uploadFile("agent", row, file, "~/uploads", sent => progress.push(sent), fetchPiece)).toBe("/home/s1/uploads/数据 a.bin");
  expect(calls.map(call => call.path)).toEqual(Array(3).fill("/agents/agent/containers/w%201/env_1/upload"));
  expect(calls.map(call => [call.params.get("offset"), call.params.get("final"), call.bytes])).toEqual([
    ["0", "0", UPLOAD_CHUNK_BYTES], [String(UPLOAD_CHUNK_BYTES), "0", UPLOAD_CHUNK_BYTES], [String(UPLOAD_CHUNK_BYTES * 2), "1", 5]]);
  expect(new Set(calls.map(call => call.params.get("uploadId"))).size).toBe(1);
  expect(calls[0]!.params.get("name")).toBe("数据 a.bin");
  expect(calls[0]!.params.get("shadowId")).toBe("s1");
  expect(progress).toEqual([UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2, size]);
});

test("an empty file is one final piece; an oversized file is refused before sending", async () => {
  const calls: string[] = [];
  const fetchPiece = (async (path: string) => { calls.push(path); return { done: true, path: "/h/empty" }; }) as never;
  expect(await uploadFile("agent", row, Object.assign(new Blob([]), { name: "empty" }), "~", () => {}, fetchPiece)).toBe("/h/empty");
  expect(calls).toHaveLength(1);
  const huge = { name: "huge", size: 100 * 1024 * 1024 + 1, slice: () => new Blob([]) } as unknown as Blob & { name: string };
  await expect(uploadFile("agent", row, huge, "~", () => {}, fetchPiece)).rejects.toThrow("100 MB");
  expect(calls).toHaveLength(1);
});
