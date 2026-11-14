import { getKernel } from "@/server/routes/kernel";
import { runnerContexts } from "@/data/schema";
import { eq } from "drizzle-orm";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve, join } from "node:path";

import type { DrizzleDB } from "@/data";
import { ArtifactRegistry } from "./artifact-registry";
import { artifactRef } from "@luna/service-client/artifact-ref";
import { inferMimeType } from "@luna/service-client/mime";

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const RUNNER_OUTPUT_REFERENCE_PATTERN =
  /(^|[\s("'`<\[:：])((?:\/[^\s)"'`<>]+|workspace\/[^\s)"'`<>]+)\.(?:png|jpe?g|gif|webp|svg|bmp|heic|heif|pdf|txt|md|csv|json|log|zip))/gi;

export function artifactizeRunnerOutputLocalFileReferences(input: {
  readonly text: string;
  readonly runnerWorkspacePath: string;
  readonly register: (file: {
    readonly content: Uint8Array;
    readonly name: string;
  }) => string;
}): string {
  const markdownArtifactized = input.text.replace(
    MARKDOWN_IMAGE_PATTERN,
    (match, alt: string, src: string) => {
      const file = runnerOutputFile(src, input.runnerWorkspacePath);
      if (file === undefined) {
        return match;
      }
      return `![${alt}](${input.register(file)})`;
    },
  );

  return markdownArtifactized.replace(
    RUNNER_OUTPUT_REFERENCE_PATTERN,
    (match, prefix: string, src: string) => {
      const file = runnerOutputFile(src, input.runnerWorkspacePath);
      if (file === undefined) {
        return match;
      }
      return `${prefix}${input.register(file)}`;
    },
  );
}

export function artifactizeRunnerOutputLocalFileReferencesInValue<T>(input: {
  readonly value: T;
  readonly runnerWorkspacePath: string;
  readonly register: (file: {
    readonly content: Uint8Array;
    readonly name: string;
  }) => string;
}): T {
  if (typeof input.value === "string") {
    return artifactizeRunnerOutputLocalFileReferences({
      text: input.value,
      runnerWorkspacePath: input.runnerWorkspacePath,
      register: input.register,
    }) as T;
  }
  if (Array.isArray(input.value)) {
    return input.value.map((item) =>
      artifactizeRunnerOutputLocalFileReferencesInValue({
        value: item,
        runnerWorkspacePath: input.runnerWorkspacePath,
        register: input.register,
      }),
    ) as T;
  }
  if (input.value !== null && typeof input.value === "object") {
    return Object.fromEntries(
      Object.entries(input.value).map(([key, item]) => [
        key,
        artifactizeRunnerOutputLocalFileReferencesInValue({
          value: item,
          runnerWorkspacePath: input.runnerWorkspacePath,
          register: input.register,
        }),
      ]),
    ) as T;
  }
  return input.value;
}

/**
 * Converts runner-local output references into durable artifact facts.
 *
 * This is the shared seam for Main, Work, and Task Runner output. Callers
 * provide ownership; this module owns secure workspace snapshots, MIME/kind
 * inference, deduplication, and artifact registration.
 */
export function artifactizeRunnerOutputValue<T>(input: {
  readonly db: DrizzleDB;
  readonly value: T;
  readonly runnerWorkspacePath: string;
  readonly scopeType: "session" | "task";
  readonly scopeId: string;
  readonly relatedUserId?: string | undefined;
  readonly producer: string;
}): T {
  let runnerWorkspacePath = input.runnerWorkspacePath;
  const runtime = getKernel().executionRuntime;
  if (runtime) {
    const context = input.db.select({ id: runnerContexts.id }).from(runnerContexts)
      .where(eq(runnerContexts.runner_root_path, dirname(input.runnerWorkspacePath))).get();
    const prepared = context ? runtime.preparedContext(context.id) : undefined;
    if (prepared?.local === false) {
      // A same-named Service file is never evidence of a remote Runner output.
      return markUnuploadedRemoteFiles(input.value);
    }
    if (prepared?.local) runnerWorkspacePath = join(prepared.cwd, "workspace");
  }
  const registry = new ArtifactRegistry(input.db);
  return artifactizeRunnerOutputLocalFileReferencesInValue({
    value: input.value,
    runnerWorkspacePath,
    register: (file) => {
      const mimeType = inferMimeType(file.name);
      const artifact = registry.registerContent({
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        ...(input.relatedUserId === undefined
          ? {}
          : { relatedUserId: input.relatedUserId }),
        producer: input.producer,
        kind: mimeType.startsWith("image/") ? "image" : "file",
        name: file.name,
        mimeType,
        content: file.content,
      });
      return artifactRef(artifact.id);
    },
  });
}

/** Remote outputs must already be uploaded; never probe a same-named Service file. */
export function markUnuploadedRemoteFiles<T>(value: T): T {
  if (typeof value === "string") return value.replace(RUNNER_OUTPUT_REFERENCE_PATTERN, (match, prefix: string, src: string) => {
    if (src.startsWith("//")) return match;
    return `${prefix}[文件未上传：请在 Runner 中使用 luna artifacts register 发布]`;
  }) as T;
  if (Array.isArray(value)) return value.map(markUnuploadedRemoteFiles) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, markUnuploadedRemoteFiles(item)])) as T;
  return value;
}

function runnerOutputFile(
  src: string,
  runnerWorkspacePath: string,
): { readonly content: Uint8Array; readonly name: string } | undefined {
  if (
    src.startsWith("artifact:") ||
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("attachment://")
  ) {
    return undefined;
  }

  if (!isAbsolute(src) && !src.startsWith("workspace/")) {
    return undefined;
  }

  const absolutePath = isAbsolute(src)
    ? src.startsWith("/workspace/")
      ? resolve(runnerWorkspacePath, src.slice("/workspace/".length))
      : resolve(src)
    : resolve(runnerWorkspacePath, src.slice("workspace/".length));
  return snapshotContainedRegularFile(
    absolutePath,
    runnerWorkspacePath,
  );
}

function snapshotContainedRegularFile(
  path: string,
  root: string,
): { readonly content: Uint8Array; readonly name: string } | undefined {
  let fd: number | undefined;
  try {
    const canonicalRoot = realpathSync(root);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const canonicalPath = realpathOfOpenFile(fd);
    if (
      canonicalPath === undefined ||
      !isContainedBy(canonicalPath, canonicalRoot) ||
      !fstatSync(fd).isFile()
    ) {
      return undefined;
    }
    return {
      content: readFileSync(fd),
      name: basename(canonicalPath),
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Artifactization is best-effort; do not fail the runner output on cleanup.
      }
    }
  }
}

function realpathOfOpenFile(fd: number): string | undefined {
  for (const fdPath of [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]) {
    try {
      return realpathSync(fdPath);
    } catch {
      // Try the next platform-specific fd filesystem.
    }
  }
  return undefined;
}

function isContainedBy(path: string, root: string): boolean {
  const normalized = resolve(path);
  const normalizedRoot = resolve(root);
  return normalized === normalizedRoot ||
    normalized.startsWith(`${normalizedRoot}/`);
}
