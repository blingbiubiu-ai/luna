import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { BUNDLED_PLUGINS } from "./bundled-registry";
import { loadInstalledPlugins } from "./installed-loader";
import {
  PluginManifestValidationError,
  PluginRegistry,
  type BundledPluginDefinition,
} from "./registry";

export interface LoadEnabledPluginsInput {
  readonly enabledPluginIds: readonly string[];
  readonly bundledPlugins?: readonly BundledPluginDefinition[];
  readonly configByPluginId?: Readonly<Record<string, unknown>>;
  readonly repoRoot?: string;
}

export function loadEnabledPlugins(input: LoadEnabledPluginsInput): PluginRegistry {
  const bundledPlugins = input.bundledPlugins ?? BUNDLED_PLUGINS;
  const bundledById = new Map(
    bundledPlugins.map((plugin) => [plugin.manifest.id, plugin] as const),
  );
  const registry = new PluginRegistry();

  for (const pluginId of input.enabledPluginIds) {
    const plugin = bundledById.get(pluginId);
    if (plugin === undefined) {
      throw new PluginManifestValidationError(
        `Enabled bundled plugin "${pluginId}" is not registered.`,
      );
    }
    validatePluginSkillPaths(plugin, input.repoRoot);
    registry.registerPlugin(
      plugin.manifest,
      plugin.createRuntime,
      input.configByPluginId?.[pluginId] ?? {},
      plugin.parseCommandInput,
    );
  }

  return registry;
}

function validatePluginSkillPaths(
  plugin: BundledPluginDefinition,
  repoRoot: string | undefined,
): void {
  for (const skill of plugin.manifest.skills ?? []) {
    if (skill.path === undefined) {
      continue;
    }
    if (!pluginSkillPathExists(skill.path, repoRoot)) {
      throw new PluginManifestValidationError(
        `Plugin "${plugin.manifest.id}" skill "${skill.id}" file does not exist: ${skill.path}`,
      );
    }
  }
}

function pluginSkillPathExists(path: string, repoRoot: string | undefined): boolean {
  if (isAbsolute(path)) {
    return existsSync(path);
  }
  const roots = [
    repoRoot,
    process.cwd(),
    resolve(import.meta.dir, "..", ".."),
    resolve(import.meta.dir, ".."),
  ].filter((value): value is string => value !== undefined);
  return roots.some((root) => existsSync(resolve(root, path)));
}

export async function loadPluginsForBoot(input: {
  readonly db: import("@/data").DrizzleDB;
  readonly configByPluginId?: Readonly<Record<string, unknown>>;
  readonly currentLunaApiVersion?: string;
}): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  for (const def of BUNDLED_PLUGINS) {
    try {
      registry.registerPlugin(
        def.manifest,
        def.createRuntime,
        input.configByPluginId?.[def.manifest.id] ?? {},
        def.parseCommandInput,
      );
    } catch (error) {
      if (error instanceof PluginManifestValidationError) {
        continue;
      }
      throw error;
    }
  }
  await loadInstalledPlugins({
    db: input.db,
    ...(input.configByPluginId === undefined ? {} : { configByPluginId: input.configByPluginId }),
    ...(input.currentLunaApiVersion === undefined ? {} : { currentLunaApiVersion: input.currentLunaApiVersion }),
    registry,
  });
  return registry;
}
