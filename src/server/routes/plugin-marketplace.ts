import { Hono } from "hono";
import type { PluginManifest } from "@luna/plugin-contracts";

import type { DrizzleDB } from "@/data";
import { PluginMarketplaceService } from "@/plugins/marketplace/marketplace-service";
import type { PluginReleaseSummary } from "@/plugins/marketplace/marketplace-store";
import { isGuardResponse, requireAdmin } from "../auth/guards";

export interface PluginMarketplaceRouteOptions {
  readonly db?: DrizzleDB;
  readonly service?: PluginMarketplaceService;
}

export function createPluginMarketplaceRoutes(
  options: PluginMarketplaceRouteOptions = {},
) {
  const getService = () => {
    if (options.service !== undefined) {
      return options.service;
    }
    if (options.db === undefined) {
      throw new Error("Plugin marketplace routes require a database.");
    }
    return new PluginMarketplaceService({ db: options.db });
  };

  return new Hono()
    .get("/", (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      const service = getService();
      const releases = service.releases();
      const installations = service.installations();
      return c.json({
        status: "ok",
        marketplace: service.marketplace(),
        plugins: buildMarketplaceSummaries(releases, installations),
      });
    })
    .get("/:pluginId", (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      const service = getService();
      const plugin = buildMarketplaceDetail({
        pluginId: c.req.param("pluginId"),
        releases: service.releases(),
        installations: service.installations(),
      });
      if (plugin === undefined) {
        return c.json({
          status: "error",
          code: "not_found",
          message: `Plugin not found: ${c.req.param("pluginId")}`,
        }, 404);
      }
      return c.json({
        status: "ok",
        plugin,
      });
    })
    .post("/refresh", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      const result = await getService().refresh();
      return c.json(result, result.status === "success" ? 200 : 500);
    })
    .post("/:pluginId/enable", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      const version = await readVersion(c.req.raw);
      if (version === undefined) {
        return c.json({
          status: "error",
          code: "invalid_request",
          message: "version is required",
        }, 400);
      }
      return c.json(await getService().enable({
        pluginId: c.req.param("pluginId"),
        version,
      }));
    })
    .post("/:pluginId/disable", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      return c.json(await getService().disable(c.req.param("pluginId")));
    })
    .post("/:pluginId/upgrade", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      const version = await readVersion(c.req.raw);
      if (version === undefined) {
        return c.json({
          status: "error",
          code: "invalid_request",
          message: "version is required",
        }, 400);
      }
      return c.json(await getService().upgrade({
        pluginId: c.req.param("pluginId"),
        version,
      }));
    })
    .post("/:pluginId/rollback", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      const version = await readVersion(c.req.raw);
      if (version === undefined) {
        return c.json({
          status: "error",
          code: "invalid_request",
          message: "version is required",
        }, 400);
      }
      return c.json(await getService().rollback({
        pluginId: c.req.param("pluginId"),
        version,
      }));
    });
}

interface PluginInstallationSummary {
  readonly pluginId: string;
  readonly desiredState: "enabled" | "disabled";
  readonly desiredVersion?: string;
  readonly desiredReleaseSha256?: string;
  readonly desiredInstalledPath?: string;
  readonly activeState: "enabled" | "disabled";
  readonly activeVersion?: string;
  readonly activeReleaseSha256?: string;
  readonly activeInstalledPath?: string;
  readonly pendingAction: string;
  readonly lastActivatedAt?: number;
  readonly lastError?: string;
}

interface PluginMarketplaceSummary {
  readonly id: string;
  readonly displayName: string;
  readonly source: string;
  readonly latestVersion: string;
  readonly status: "enabled" | "disabled";
  readonly latestRelease: PluginReleaseSummary;
  readonly installation: PluginInstallationSummary | null;
  readonly latestLoadError: string | null;
}

interface PluginMarketplaceDetail extends PluginManifest {
  readonly status: "enabled" | "disabled";
  readonly latestLoadError: string | null;
  readonly installation: PluginInstallationSummary | null;
  readonly marketplaceVersions: readonly PluginReleaseSummary[];
}

function buildMarketplaceSummaries(
  releases: readonly PluginReleaseSummary[],
  installations: readonly PluginInstallationSummary[],
): PluginMarketplaceSummary[] {
  return [...groupReleasesByPlugin(releases).entries()]
    .map(([pluginId, pluginReleases]) => {
      const sorted = sortReleases(pluginReleases);
      const latest = sorted[0]!;
      const manifest = latest.manifest;
      const installation = installations.find((item) => item.pluginId === pluginId) ?? null;
      return {
        id: pluginId,
        displayName: manifest?.displayName ?? pluginId,
        source: manifest?.source ?? "marketplace",
        latestVersion: latest.version,
        status: installation?.desiredState === "enabled"
          ? "enabled" as const
          : "disabled" as const,
        latestRelease: latest,
        installation,
        latestLoadError: installation?.lastError ?? null,
      };
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function buildMarketplaceDetail(input: {
  readonly pluginId: string;
  readonly releases: readonly PluginReleaseSummary[];
  readonly installations: readonly PluginInstallationSummary[];
}): PluginMarketplaceDetail | undefined {
  const pluginReleases = groupReleasesByPlugin(input.releases).get(input.pluginId);
  if (pluginReleases === undefined || pluginReleases.length === 0) {
    return undefined;
  }
  const marketplaceVersions = sortReleases(pluginReleases);
  const latest = marketplaceVersions[0]!;
  const manifest = latest.manifest ?? {
    id: input.pluginId,
    displayName: input.pluginId,
    version: latest.version,
    source: "marketplace" as const,
    requestedHostPermissions: [],
    operations: [],
    commands: [],
    tools: [],
    skills: [],
  };
  const installation = input.installations.find((item) => item.pluginId === input.pluginId) ?? null;
  return {
    ...manifest,
    status: installation?.desiredState === "enabled"
      ? "enabled" as const
      : "disabled" as const,
    latestLoadError: installation?.lastError ?? null,
    installation,
    marketplaceVersions,
  };
}

function groupReleasesByPlugin(
  releases: readonly PluginReleaseSummary[],
): Map<string, PluginReleaseSummary[]> {
  const grouped = new Map<string, PluginReleaseSummary[]>();
  for (const release of releases) {
    const existing = grouped.get(release.pluginId) ?? [];
    existing.push(release);
    grouped.set(release.pluginId, existing);
  }
  return grouped;
}

function sortReleases(
  releases: readonly PluginReleaseSummary[],
): PluginReleaseSummary[] {
  return [...releases].sort((left, right) =>
    comparePluginVersions(right.version, left.version)
  );
}

function comparePluginVersions(left: string, right: string | undefined): number {
  if (right === undefined) {
    return 1;
  }
  const leftParts = pluginVersionParts(left);
  const rightParts = pluginVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.localeCompare(right);
}

function pluginVersionParts(version: string): number[] {
  return version.split(".").map((part) => {
    const parsed = Number(part.replace(/[^0-9].*$/, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

async function readVersion(req: Request): Promise<string | undefined> {
  try {
    const body = await req.json() as { readonly version?: unknown };
    return typeof body.version === "string" && body.version.trim().length > 0
      ? body.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
