import { z } from "zod";

import type { MarketplaceIndex } from "./types";

const hexSha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const safeRelativePath = z.string().refine(
  (value) =>
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.split("/").includes(".."),
  "release package path must stay inside the marketplace",
);
const safePackagePath = safeRelativePath.refine(
  (value) => value.endsWith(".tgz"),
  "release package path must point to a .tgz archive",
);

const MarketplacePluginVersionSchema = z.object({
  version: semver,
  packagePath: safePackagePath,
  lunaApiVersion: z.string().trim().min(1),
  manifestSha256: hexSha256,
  pluginJsSha256: hexSha256,
  packageSha256: hexSha256,
  releaseSha256: hexSha256,
  publishedAt: z.string().datetime(),
}).strict();

const MarketplacePluginSchema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  description: z.string(),
  latestVersion: semver,
  versions: z.array(MarketplacePluginVersionSchema).min(1),
}).strict();

const MarketplaceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
  plugins: z.array(MarketplacePluginSchema),
}).strict();

export function parseMarketplaceIndex(input: unknown): MarketplaceIndex {
  const parsed = MarketplaceIndexSchema.parse(input);
  for (const plugin of parsed.plugins) {
    if (!plugin.versions.some((version) => version.version === plugin.latestVersion)) {
      throw new Error(
        `Marketplace plugin "${plugin.id}" latestVersion "${plugin.latestVersion}" is not listed in versions.`,
      );
    }
  }
  return parsed;
}
