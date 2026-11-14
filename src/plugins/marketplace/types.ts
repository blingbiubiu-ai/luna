import type { PluginManifest } from "@luna/plugin-contracts";

export interface MarketplaceIndex {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly plugins: readonly MarketplacePlugin[];
}

export interface MarketplacePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly latestVersion: string;
  readonly versions: readonly MarketplacePluginVersion[];
}

export interface MarketplacePluginVersion {
  readonly version: string;
  readonly packagePath: string;
  readonly lunaApiVersion: string;
  readonly manifestSha256: string;
  readonly pluginJsSha256: string;
  readonly packageSha256: string;
  readonly releaseSha256: string;
  readonly publishedAt: string;
}

export interface ReleaseValidationInput {
  readonly marketplaceRoot: string;
  readonly releaseRelativePath: string;
  readonly expectedPluginId: string;
  readonly expectedVersion: string;
  readonly expectedManifestSha256: string;
  readonly expectedPluginJsSha256: string;
  readonly expectedPackageSha256?: string;
  readonly expectedReleaseSha256: string;
  readonly currentLunaApiVersion: string;
}

export interface ReleaseValidationResult {
  readonly status: "valid";
  readonly releaseRoot: string;
  readonly manifest: PluginManifest;
  readonly manifestSha256: string;
  readonly pluginJsSha256: string;
  readonly releaseSha256: string;
  readonly cleanup?: () => void;
}
