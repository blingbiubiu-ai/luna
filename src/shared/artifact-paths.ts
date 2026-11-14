import { homedir } from "node:os";
import { join } from "node:path";

export function resolveServiceArtifactsRoot(): string {
  return Bun.env.LUNA_ARTIFACTS_DIR ?? join(
    Bun.env.LUNA_HOME ?? join(homedir(), ".luna"),
    "artifacts",
  );
}

export function timestampedServiceArtifactDir(
  parts: readonly string[],
  name?: string,
  now = new Date(),
): string {
  const stamp = artifactTimestamp(now);
  return join(
    resolveServiceArtifactsRoot(),
    ...parts,
    name === undefined ? stamp : `${name}-${stamp}`,
  );
}

function artifactTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}
