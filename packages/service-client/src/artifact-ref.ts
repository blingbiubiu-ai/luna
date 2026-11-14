const ARTIFACT_REF_PATTERN = /artifact:([A-Za-z0-9._:-]+)/g;

export function artifactRef(id: string): string {
  return `artifact:${id}`;
}

export function parseArtifactRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("artifact:")) {
    return undefined;
  }
  const id = trimmed.slice("artifact:".length);
  return id.length > 0 ? id : undefined;
}

export function scanArtifactRefs(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      for (const match of item.matchAll(ARTIFACT_REF_PATTERN)) {
        const id = match[1];
        if (id !== undefined && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) {
        visit(child);
      }
    }
  };
  visit(value);
  return ids;
}

export function rewriteArtifactRefsInValue<T>(
  value: T,
  resolver: (id: string) => string | undefined,
): T {
  if (typeof value === "string") {
    return value.replace(ARTIFACT_REF_PATTERN, (match, id: string) => {
      return resolver(id) ?? match;
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteArtifactRefsInValue(item, resolver)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewriteArtifactRefsInValue(item, resolver),
      ]),
    ) as T;
  }
  return value;
}
