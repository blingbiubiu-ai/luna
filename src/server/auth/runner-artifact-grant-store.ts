import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { accessTokens } from "@/data/schema";

export class RunnerArtifactGrantStore {
  constructor(private readonly _db: DrizzleDB) {}

  list(tokenId: string): readonly string[] {
    const row = this._db
      .select({ metadataJson: accessTokens.metadataJson })
      .from(accessTokens)
      .where(eq(accessTokens.id, tokenId))
      .get();
    return artifactIdsFromMetadata(row?.metadataJson);
  }

  grant(tokenId: string, artifactIds: readonly string[]): void {
    if (artifactIds.length === 0) {
      return;
    }
    this._db.transaction((tx) => {
      const row = tx
        .select({ metadataJson: accessTokens.metadataJson })
        .from(accessTokens)
        .where(eq(accessTokens.id, tokenId))
        .get();
      if (row === undefined) {
        return;
      }
      const metadata = isRecord(row.metadataJson) ? row.metadataJson : {};
      const nextArtifactIds = [
        ...new Set([
          ...artifactIdsFromMetadata(metadata),
          ...artifactIds.filter((id) => id.length > 0),
        ]),
      ];
      tx.update(accessTokens)
        .set({ metadataJson: { ...metadata, artifactIds: nextArtifactIds } })
        .where(eq(accessTokens.id, tokenId))
        .run();
    });
  }
}

function artifactIdsFromMetadata(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.artifactIds)) {
    return [];
  }
  return [...new Set(
    metadata.artifactIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  )];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
