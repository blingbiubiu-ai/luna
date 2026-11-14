import { isAbsolute, join, parse, resolve } from "node:path";

export function resolveSharedWorkspacePath(input: {
  readonly home: string;
  readonly configured?: string;
}): string {
  const candidate = input.configured ?? join(input.home, "workspace", "projects");
  if (!isAbsolute(candidate)) {
    throw new Error(`Shared workspace path must be absolute: ${candidate}`);
  }
  const normalized = resolve(candidate);
  if (normalized === parse(normalized).root) {
    throw new Error("Shared workspace path cannot be the filesystem root.");
  }
  return normalized;
}
