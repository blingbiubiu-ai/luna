import { z } from "zod";
import { absoluteRunnerPath } from "./runner-assets";
import { Id } from "./job.js";
const FileWrite = z.object({ path: z.string(), content: z.string().max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean().default(false) }).strict();
export const FileOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provision") }).strict(),
  z.object({ kind: z.literal("mkdir"), path: z.string() }).strict(),
  z.object({ kind: z.literal("write_batch"), files: z.array(FileWrite).min(1).max(256) }).strict(),
  z.object({ kind: z.literal("read"), path: z.string() }).strict(),
  z.object({ kind: z.literal("stat"), path: z.string() }).strict(),
  z.object({ kind: z.literal("list"), path: z.string() }).strict(),
  z.object({ kind: z.literal("delete"), path: z.string() }).strict(),
  z.object({ kind: z.literal("write"), path: z.string(), content: z.string().max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean().default(false) }).strict(),
]);

export const FileRequest = z.object({ operationId: Id, contextId: Id, scopeKey: z.string().min(1).max(512), projectId: Id.optional(), cwd: absoluteRunnerPath.optional(), operation: FileOperation }).strict();
