import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import type { DrizzleDB } from "@/data";
import { config } from "@/shared";

import { artifactRef } from "@luna/service-client/artifact-ref";
import { ArtifactRegistry, inferMimeType } from "./artifact-registry";

const LOCAL_FILE_REFERENCE_PATTERN =
  /(^|[\s("'`<\[:：])((?:\/[^\s)"'`<>]+|workspace\/[^\s)"'`<>]+)\.(?:png|jpe?g|gif|webp|svg|bmp|heic|heif|pdf|txt|md|csv|json|log|zip))/gi;

export function artifactizeLocalFileReferencesInValue<T>(input: {
  readonly db: DrizzleDB;
  readonly value: T;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly relatedUserId?: string | undefined;
  readonly producer: string;
}): T {
  const registry = new ArtifactRegistry(input.db);
  const registered = new Map<string, string>();
  const replaceLocalRefs = (value: unknown): unknown => {
    if (typeof value === "string") {
      return artifactizeLocalRefsInText(value, {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        relatedUserId: input.relatedUserId,
        producer: input.producer,
        registry,
        registered,
      });
    }
    if (Array.isArray(value)) {
      return value.map((item) => replaceLocalRefs(item));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, replaceLocalRefs(item)]),
      );
    }
    return value;
  };
  return replaceLocalRefs(input.value) as T;
}

function artifactizeLocalRefsInText(
  text: string,
  input: {
    readonly scopeType: string;
    readonly scopeId: string;
    readonly relatedUserId?: string | undefined;
    readonly producer: string;
    readonly registry: ArtifactRegistry;
    readonly registered: Map<string, string>;
  },
): string {
  return text.replace(
    LOCAL_FILE_REFERENCE_PATTERN,
    (match, prefix: string, src: string) => {
      const absolutePath = localSourcePath(src);
      if (absolutePath === undefined) {
        return match;
      }
      const ref = input.registered.get(absolutePath) ??
        registerArtifact({ ...input, absolutePath });
      input.registered.set(absolutePath, ref);
      return `${prefix}${ref}`;
    },
  );
}

function registerArtifact(input: {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly relatedUserId?: string | undefined;
  readonly producer: string;
  readonly registry: ArtifactRegistry;
  readonly absolutePath: string;
}): string {
  const mimeType = inferMimeType(input.absolutePath);
  const row = input.registry.registerLocalFile({
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    ...(input.relatedUserId === undefined
      ? {}
      : { relatedUserId: input.relatedUserId }),
    producer: input.producer,
    kind: mimeType.startsWith("image/") ? "image" : "file",
    name: basename(input.absolutePath),
    mimeType,
    path: input.absolutePath,
  });
  return artifactRef(row.id);
}

function localSourcePath(src: string): string | undefined {
  if (
    src.startsWith("artifact:") ||
    src.startsWith("http://") ||
    src.startsWith("https://")
  ) {
    return undefined;
  }
  const sourcePath = isAbsolute(src)
    ? resolve(src)
    : resolve(config.paths.home, src.replace(/^\/+/, ""));
  if (!isContainedBy(sourcePath, config.paths.workspace) || !existsSync(sourcePath)) {
    return undefined;
  }
  return sourcePath;
}

function isContainedBy(path: string, root: string): boolean {
  const normalized = resolve(path);
  const normalizedRoot = resolve(root);
  return normalized === normalizedRoot ||
    normalized.startsWith(`${normalizedRoot}/`);
}
