import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DrizzleDB } from "@/data";
import { config } from "@/shared";

import { syncGitMarketplace } from "./git-marketplace";
import {
  InstalledPluginStore,
  type PluginInstallationSummary,
} from "./installed-plugin-store";
import { parseMarketplaceIndex } from "./marketplace-index";
import {
  PluginMarketplaceStore,
  type PluginReleaseSummary,
} from "./marketplace-store";
import { validateReleasePackage } from "./release-validator";

export interface PluginMarketplaceConfig {
  readonly id: string;
  readonly gitUrl: string;
  readonly branch: string;
  readonly localPath: string;
}

export type MarketplaceRefreshResult =
  | {
      readonly status: "success";
      readonly marketplaceId: string;
      readonly commit: string;
      readonly releaseCount: number;
    }
  | {
      readonly status: "error";
      readonly marketplaceId: string;
      readonly error: string;
      readonly previousReleasesPreserved: true;
    };

export interface PluginActionResult {
  readonly status: "success";
  readonly restartRequired: true;
  readonly installation: PluginInstallationSummary;
}

export class PluginMarketplaceService {
  private readonly _marketplace: PluginMarketplaceConfig;
  private readonly _store: PluginMarketplaceStore;
  private readonly _installed: InstalledPluginStore;
  private readonly _currentLunaApiVersion: string;

  constructor(input: {
    readonly db: DrizzleDB;
    readonly marketplace?: PluginMarketplaceConfig;
    readonly lunaHome?: string;
    readonly currentLunaApiVersion?: string;
  }) {
    this._marketplace = input.marketplace ?? defaultMarketplace();
    this._store = new PluginMarketplaceStore(input.db);
    this._installed = new InstalledPluginStore(
      input.db,
      input.lunaHome === undefined ? {} : { lunaHome: input.lunaHome },
    );
    this._currentLunaApiVersion = input.currentLunaApiVersion ?? "0.1.0";
  }

  async refresh(): Promise<MarketplaceRefreshResult> {
    const now = Date.now();
    this._store.upsertMarketplace({
      id: this._marketplace.id,
      gitUrl: this._marketplace.gitUrl,
      branch: this._marketplace.branch,
      localPath: this._marketplace.localPath,
      lastFetchedAt: now,
    });
    try {
      const synced = await syncGitMarketplace(this._marketplace);
      const index = parseMarketplaceIndex(
        JSON.parse(readFileSync(join(synced.localPath, "marketplace.json"), "utf8")),
      );
      const previousReleaseShaById = new Map(
        this._store.listReleases()
          .filter((release) => release.marketplaceId === this._marketplace.id)
          .map((release) => [
            releaseKey(release.pluginId, release.version),
            release.releaseSha256,
          ]),
      );
      const releases: PluginReleaseSummary[] = [];
      for (const plugin of index.plugins) {
        for (const version of plugin.versions) {
          const base = {
            id: `${this._marketplace.id}:${plugin.id}:${version.version}`,
            marketplaceId: this._marketplace.id,
            pluginId: plugin.id,
            version: version.version,
            releasePath: version.packagePath,
            manifestSha256: version.manifestSha256,
            pluginJsSha256: version.pluginJsSha256,
            packageSha256: version.packageSha256,
            releaseSha256: version.releaseSha256,
            lunaApiVersion: version.lunaApiVersion,
            marketplaceCommit: synced.commit,
            discoveredAt: now,
          };
          let cleanup: (() => void) | undefined;
          try {
            const validation = validateReleasePackage({
              marketplaceRoot: synced.localPath,
              releaseRelativePath: version.packagePath,
              expectedPluginId: plugin.id,
              expectedVersion: version.version,
              expectedManifestSha256: version.manifestSha256,
              expectedPluginJsSha256: version.pluginJsSha256,
              expectedPackageSha256: version.packageSha256,
              expectedReleaseSha256: version.releaseSha256,
              currentLunaApiVersion: this._currentLunaApiVersion,
            });
            cleanup = validation.cleanup;
            const previousReleaseSha = previousReleaseShaById.get(
              releaseKey(plugin.id, version.version),
            );
            if (
              previousReleaseSha !== undefined &&
              previousReleaseSha !== version.releaseSha256
            ) {
              throw new Error(
                `integrity drift detected for immutable release ${plugin.id}@${version.version}`,
              );
            }
            releases.push({
              ...base,
              validationStatus: "valid",
              manifest: validation.manifest,
            });
          } catch (error) {
            releases.push({
              ...base,
              validationStatus: "invalid",
              validationError: errorMessage(error),
            });
          } finally {
            cleanup?.();
          }
        }
      }
      this._store.replaceReleases({
        marketplaceId: this._marketplace.id,
        releases,
      });
      this._store.upsertMarketplace({
        id: this._marketplace.id,
        gitUrl: this._marketplace.gitUrl,
        branch: this._marketplace.branch,
        localPath: synced.localPath,
        lastCommit: synced.commit,
        lastFetchedAt: now,
      });
      return {
        status: "success",
        marketplaceId: this._marketplace.id,
        commit: synced.commit,
        releaseCount: releases.length,
      };
    } catch (error) {
      this._store.recordMarketplaceError({
        id: this._marketplace.id,
        gitUrl: this._marketplace.gitUrl,
        branch: this._marketplace.branch,
        localPath: this._marketplace.localPath,
        error: errorMessage(error),
      });
      return {
        status: "error",
        marketplaceId: this._marketplace.id,
        error: errorMessage(error),
        previousReleasesPreserved: true,
      };
    }
  }

  async enable(input: {
    readonly pluginId: string;
    readonly version: string;
  }): Promise<PluginActionResult> {
    return this._installAndMark(input.pluginId, input.version, "enable");
  }

  async upgrade(input: {
    readonly pluginId: string;
    readonly version: string;
  }): Promise<PluginActionResult> {
    return this._installAndMark(input.pluginId, input.version, "upgrade");
  }

  async rollback(input: {
    readonly pluginId: string;
    readonly version: string;
  }): Promise<PluginActionResult> {
    return this._installAndMark(input.pluginId, input.version, "rollback");
  }

  async disable(pluginId: string): Promise<PluginActionResult> {
    return {
      status: "success",
      restartRequired: true,
      installation: this._installed.markDisable(pluginId),
    };
  }

  releases(): PluginReleaseSummary[] {
    return this._store.listReleases();
  }

  installations(): PluginInstallationSummary[] {
    return this._installed.listInstallations();
  }

  marketplace() {
    return this._store.getMarketplace(this._marketplace.id) ?? {
      id: this._marketplace.id,
      gitUrl: this._marketplace.gitUrl,
      branch: this._marketplace.branch,
      localPath: this._marketplace.localPath,
    };
  }

  private async _installAndMark(
    pluginId: string,
    version: string,
    action: "enable" | "upgrade" | "rollback",
  ): Promise<PluginActionResult> {
    const release = this._store.getRelease(pluginId, version);
    if (release === undefined) {
      throw new Error(`Plugin release not found: ${pluginId}@${version}`);
    }
    if (release.validationStatus !== "valid") {
      throw new Error(
        `Plugin release ${pluginId}@${version} is invalid: ${release.validationError ?? "unknown validation error"}`,
      );
    }
    const validation = validateReleasePackage({
      marketplaceRoot: this._marketplace.localPath,
      releaseRelativePath: release.releasePath,
      expectedPluginId: release.pluginId,
      expectedVersion: release.version,
      expectedManifestSha256: release.manifestSha256,
      expectedPluginJsSha256: release.pluginJsSha256,
      ...(release.packageSha256 === undefined
        ? {}
        : { expectedPackageSha256: release.packageSha256 }),
      expectedReleaseSha256: release.releaseSha256,
      currentLunaApiVersion: this._currentLunaApiVersion,
    });
    let installed: ReturnType<InstalledPluginStore["installRelease"]>;
    try {
      installed = this._installed.installRelease({
        release,
        releaseRoot: validation.releaseRoot,
      });
    } finally {
      validation.cleanup?.();
    }
    return {
      status: "success",
      restartRequired: true,
      installation: this._installed.markEnable({ installed, action }),
    };
  }
}

function defaultMarketplace(): PluginMarketplaceConfig {
  const gitUrl = config.plugins.marketplace.gitUrl;
  if (gitUrl === undefined) {
    throw new Error("plugins.marketplace.gitUrl is not configured.");
  }
  return {
    id: "trusted",
    gitUrl,
    branch: config.plugins.marketplace.branch,
    localPath: join(config.paths.home, "plugins", "marketplace", "trusted"),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function releaseKey(pluginId: string, version: string): string {
  return `${pluginId}@${version}`;
}
