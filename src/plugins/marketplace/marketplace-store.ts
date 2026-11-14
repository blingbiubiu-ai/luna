import { and, eq, sql } from "drizzle-orm";
import type { PluginManifest } from "@luna/plugin-contracts";

import type { DrizzleDB } from "@/data";
import {
  pluginMarketplaces,
  pluginReleases,
} from "@/data/schema";

export interface MarketplaceSourceSummary {
  readonly id: string;
  readonly gitUrl: string;
  readonly branch: string;
  readonly localPath: string;
  readonly lastCommit?: string;
  readonly lastFetchedAt?: number;
  readonly lastError?: string;
}

export interface PluginReleaseSummary {
  readonly id: string;
  readonly marketplaceId: string;
  readonly pluginId: string;
  readonly version: string;
  readonly releasePath: string;
  readonly manifestSha256: string;
  readonly pluginJsSha256: string;
  readonly packageSha256?: string;
  readonly releaseSha256: string;
  readonly lunaApiVersion: string;
  readonly marketplaceCommit?: string;
  readonly validationStatus: "valid" | "invalid";
  readonly validationError?: string;
  readonly manifest?: PluginManifest;
  readonly discoveredAt: number;
}

export class PluginMarketplaceStore {
  constructor(private readonly _db: DrizzleDB) {}

  upsertMarketplace(input: MarketplaceSourceSummary): MarketplaceSourceSummary {
    this._db
      .insert(pluginMarketplaces)
      .values({
        id: input.id,
        git_url: input.gitUrl,
        branch: input.branch,
        local_path: input.localPath,
        last_commit: input.lastCommit ?? null,
        last_fetched_at: input.lastFetchedAt ?? null,
        last_error: input.lastError ?? null,
      })
      .onConflictDoUpdate({
        target: pluginMarketplaces.id,
        set: {
          git_url: sql`excluded.git_url`,
          branch: sql`excluded.branch`,
          local_path: sql`excluded.local_path`,
          last_commit: sql`excluded.last_commit`,
          last_fetched_at: sql`excluded.last_fetched_at`,
          last_error: sql`excluded.last_error`,
        },
      })
      .run();
    return this.requireMarketplace(input.id);
  }

  recordMarketplaceError(input: {
    readonly id: string;
    readonly gitUrl: string;
    readonly branch: string;
    readonly localPath: string;
    readonly error: string;
  }): MarketplaceSourceSummary {
    const existing = this.getMarketplace(input.id);
    this._db
      .insert(pluginMarketplaces)
      .values({
        id: input.id,
        git_url: input.gitUrl,
        branch: input.branch,
        local_path: input.localPath,
        last_commit: existing?.lastCommit ?? null,
        last_fetched_at: existing?.lastFetchedAt ?? null,
        last_error: input.error,
      })
      .onConflictDoUpdate({
        target: pluginMarketplaces.id,
        set: {
          git_url: input.gitUrl,
          branch: input.branch,
          local_path: input.localPath,
          last_error: input.error,
        },
      })
      .run();
    return this.requireMarketplace(input.id);
  }

  replaceReleases(input: {
    readonly marketplaceId: string;
    readonly releases: readonly PluginReleaseSummary[];
  }): void {
    this._db
      .delete(pluginReleases)
      .where(eq(pluginReleases.marketplace_id, input.marketplaceId))
      .run();
    for (const release of input.releases) {
      this._db.insert(pluginReleases).values(toReleaseRow(release)).run();
    }
  }

  listReleases(): PluginReleaseSummary[] {
    return this._db
      .select()
      .from(pluginReleases)
      .all()
      .map(releaseFromRow);
  }

  getRelease(
    pluginId: string,
    version: string,
  ): PluginReleaseSummary | undefined {
    const row = this._db
      .select()
      .from(pluginReleases)
      .where(
        and(
          eq(pluginReleases.plugin_id, pluginId),
          eq(pluginReleases.version, version),
        ),
      )
      .get();
    return row === undefined ? undefined : releaseFromRow(row);
  }

  getMarketplace(id: string): MarketplaceSourceSummary | undefined {
    const row = this._db
      .select()
      .from(pluginMarketplaces)
      .where(eq(pluginMarketplaces.id, id))
      .get();
    return row === undefined ? undefined : marketplaceFromRow(row);
  }

  requireMarketplace(id: string): MarketplaceSourceSummary {
    const marketplace = this.getMarketplace(id);
    if (marketplace === undefined) {
      throw new Error(`Plugin marketplace not found: ${id}`);
    }
    return marketplace;
  }
}

function toReleaseRow(
  release: PluginReleaseSummary,
): typeof pluginReleases.$inferInsert {
  return {
    id: release.id,
    marketplace_id: release.marketplaceId,
    plugin_id: release.pluginId,
    version: release.version,
    release_path: release.releasePath,
    manifest_sha256: release.manifestSha256,
    plugin_js_sha256: release.pluginJsSha256,
    package_sha256: release.packageSha256 ?? null,
    release_sha256: release.releaseSha256,
    luna_api_version: release.lunaApiVersion,
    marketplace_commit: release.marketplaceCommit ?? null,
    validation_status: release.validationStatus,
    validation_error: release.validationError ?? null,
    manifest_json: release.manifest === undefined
      ? null
      : JSON.stringify(release.manifest),
    discovered_at: release.discoveredAt,
  };
}

function marketplaceFromRow(
  row: typeof pluginMarketplaces.$inferSelect,
): MarketplaceSourceSummary {
  return {
    id: row.id,
    gitUrl: row.git_url,
    branch: row.branch,
    localPath: row.local_path,
    ...(row.last_commit === null ? {} : { lastCommit: row.last_commit }),
    ...(row.last_fetched_at === null
      ? {}
      : { lastFetchedAt: row.last_fetched_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function releaseFromRow(
  row: typeof pluginReleases.$inferSelect,
): PluginReleaseSummary {
  return {
    id: row.id,
    marketplaceId: row.marketplace_id,
    pluginId: row.plugin_id,
    version: row.version,
    releasePath: row.release_path,
    manifestSha256: row.manifest_sha256,
    pluginJsSha256: row.plugin_js_sha256,
    ...(row.package_sha256 === null ? {} : { packageSha256: row.package_sha256 }),
    releaseSha256: row.release_sha256,
    lunaApiVersion: row.luna_api_version,
    ...(row.marketplace_commit === null
      ? {}
      : { marketplaceCommit: row.marketplace_commit }),
    validationStatus:
      row.validation_status === "invalid" ? "invalid" : "valid",
    ...(row.validation_error === null
      ? {}
      : { validationError: row.validation_error }),
    ...(row.manifest_json === null
      ? {}
      : { manifest: JSON.parse(row.manifest_json) as PluginManifest }),
    discoveredAt: row.discovered_at,
  };
}
