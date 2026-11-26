import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { DrizzleDB } from "@/data";

import { sha256File } from "./marketplace/checksums";
import { InstalledPluginStore } from "./marketplace/installed-plugin-store";
import { validateReleasePackage } from "./marketplace/release-validator";
import type { BundledPluginDefinition, PluginManifest } from "./manifest";
import { PluginRegistry } from "./registry";

export interface LoadInstalledPluginsInput {
  readonly db: DrizzleDB;
  readonly configByPluginId?: Readonly<Record<string, unknown>>;
  readonly currentLunaApiVersion?: string;
}

export async function loadInstalledPlugins(
  input: LoadInstalledPluginsInput & { readonly registry?: PluginRegistry },
): Promise<PluginRegistry> {
  const registry = input.registry ?? new PluginRegistry();
  const store = new InstalledPluginStore(input.db);
  const currentLunaApiVersion = input.currentLunaApiVersion ?? "0.1.0";

  for (const installation of store.listDesiredEnabled()) {
    try {
      const installedPath = resolveInstalledPath(installation);
      const manifestPath = join(installedPath, "manifest.json");
      const pluginJsPath = join(installedPath, "plugin.js");
      if (!existsSync(manifestPath) || !existsSync(pluginJsPath)) {
        throw new Error(
          `Installed plugin "${installation.pluginId}" is missing manifest.json or plugin.js.`,
        );
      }
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as PluginManifest;
      const runtimeManifest = withInstalledAssetPaths(manifest, installedPath);
      validateReleasePackage({
        marketplaceRoot: installedPath,
        releaseRelativePath: ".",
        expectedPluginId: installation.pluginId,
        expectedVersion: installation.desiredVersion!,
        expectedManifestSha256: sha256File(manifestPath),
        expectedPluginJsSha256: sha256File(pluginJsPath),
        expectedReleaseSha256: installation.desiredReleaseSha256!,
        currentLunaApiVersion,
      });
      const pluginDefinition = await importInstalledPlugin(
        pluginJsPath,
        installation.desiredReleaseSha256!,
      );
      registry.registerPlugin(
        runtimeManifest,
        pluginDefinition.createRuntime,
        input.configByPluginId?.[installation.pluginId] ?? {},
        pluginDefinition.parseCommandInput,
        { path: installedPath, sha256: installation.desiredReleaseSha256! },
      );
      store.markActivation({
        pluginId: installation.pluginId,
        status: "success",
      });
    } catch (error) {
      store.markActivation({
        pluginId: installation.pluginId,
        status: "failure",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return registry;
}

function withInstalledAssetPaths(
  manifest: PluginManifest,
  installedPath: string,
): PluginManifest {
  return {
    ...manifest,
    ...(manifest.skills === undefined
      ? {}
      : {
        skills: manifest.skills.map((skill) => ({
          ...skill,
          ...(skill.path === undefined || isAbsolute(skill.path)
            ? {}
            : { path: join(installedPath, skill.path) }),
        })),
      }),
    ...(manifest.containerCommands === undefined
      ? {}
      : {
        containerCommands: manifest.containerCommands.map((command) => ({
          ...command,
          ...(isAbsolute(command.shimScript)
            ? {}
            : { shimScript: join(installedPath, command.shimScript) }),
          ...(command.runtimeDirectory === undefined || isAbsolute(command.runtimeDirectory)
            ? {}
            : { runtimeDirectory: join(installedPath, command.runtimeDirectory) }),
        })),
      }),
  };
}

function resolveInstalledPath(
  installation: ReturnType<InstalledPluginStore["listDesiredEnabled"]>[number],
): string {
  if (
    installation.desiredInstalledPath !== undefined &&
    installation.desiredVersion !== undefined &&
    installation.desiredReleaseSha256 !== undefined
  ) {
    return installation.desiredInstalledPath;
  }
  throw new Error(
    `Installed plugin "${installation.pluginId}" has incomplete desired installation metadata.`,
  );
}

async function importInstalledPlugin(
  pluginJsPath: string,
  releaseSha256: string,
): Promise<Pick<BundledPluginDefinition, "createRuntime" | "parseCommandInput">> {
  const url = `${pathToFileURL(pluginJsPath).href}?release=${releaseSha256}`;
  const module = await import(url) as Record<string, unknown>;
  const candidate = module.plugin ??
    module.default ??
    Object.values(module).find(isPluginDefinitionLike);
  if (typeof candidate === "function") {
    return { createRuntime: candidate as BundledPluginDefinition["createRuntime"] };
  }
  if (isPluginDefinitionLike(candidate)) {
    return {
      createRuntime: candidate.createRuntime,
      ...(candidate.parseCommandInput === undefined
        ? {}
        : { parseCommandInput: candidate.parseCommandInput }),
    };
  }
  throw new Error(`Installed plugin module does not export a plugin runtime factory: ${pluginJsPath}`);
}

function isPluginDefinitionLike(
  value: unknown,
): value is Pick<BundledPluginDefinition, "createRuntime" | "parseCommandInput"> {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { createRuntime?: unknown }).createRuntime === "function";
}
