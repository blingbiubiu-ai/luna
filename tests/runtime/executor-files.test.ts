import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextFiles } from "@luna/executor/executor/files";
import { ExecutorContexts } from "@luna/executor/executor/contexts";
import { executeFileOperation } from "@luna/executor/executor/file-operation";
import { FileOperation } from "@luna/runner-protocol";
import { contentHash, openExecutionDatabase } from "@luna/execution-store";

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("Worker registration requires mounted storage", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-context-registration-"));
  const db = openExecutionDatabase(":memory:");
  try {
    const contexts = new ExecutorContexts(root);
    expect(() => contexts.get("missing")).toThrow("context_not_found");
    const mounted = contexts.provision("existing");
    expect(contexts.provision("existing", { requireMount: true })).toEqual(mounted);
    expect(() => contexts.provision("missing", { requireMount: true })).toThrow("context_storage_missing");
    expect(contexts.get("existing")).toEqual(mounted);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("maintenance writes are idempotent and reject traversal, symlinks and hard links", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-files-"));
  const db = openExecutionDatabase(join(root, "executor.sqlite"));
  try {
    const contexts = new ExecutorContexts(join(root, "data"));
    const context = contexts.provision("context1");
    const files = new ContextFiles(context.cwd, context.uid, context.gid);
    const content = Buffer.from("first contents");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const input = FileOperation.parse({ kind: "write", path: "docs/readme.md", content: content.toString("base64"), sha256 });
    const first = executeFileOperation(context, input);
    expect(first).toEqual({ size: content.length, sha256 });
    expect(executeFileOperation(context, input)).toEqual(first);
    expect(Buffer.from(files.read("docs/readme.md").content, "base64").toString()).toBe("first contents");
    const outside = join(root, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "private");
    symlinkSync(outside, join(context.cwd, "escape"));
    linkSync(join(outside, "secret"), join(context.cwd, "hardlink"));
    expect(() => files.read("../outside/secret")).toThrow("invalid_relative_path");
    expect(() => files.read("escape/secret")).toThrow("unsafe_file_path");
    expect(() => files.write("escape/secret", content.toString("base64"), sha256)).toThrow("unsafe_file_path");
    expect(() => files.read("hardlink")).toThrow("unsafe_file_type");
    expect(() => files.write("oversize", Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"), sha256)).toThrow("file_too_large");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
