import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveEnvVars } from "./env-resolver";
import * as paths from "./paths";
import type { AppConfig } from "./schema";
import {
  AppConfig as AppConfigSchema,
  DEFAULT_SESSION_CONFIG,
  SandboxConfig as SandboxConfigSchema,
} from "./schema";

export { DEFAULT_SESSION_CONFIG };
export type {
  AppConfig,
  GroupActivationFollowupSenders,
  LoggingConfig,
  PathsConfig,
  SandboxConfig,
  ServiceConfig,
  SessionConfig,
} from "./schema";
export {
  setLunaHome,
  setRunnerRootBase,
  setSharedWorkspacePath,
} from "./paths";

/**
 * Combined bootstrap configuration interface including YAML-loaded bootstrap config and paths.
 */
export interface Config extends Omit<AppConfig, "paths"> {
  runtimePaths: AppConfig["paths"];
  paths: typeof paths;
}

let _appConfig: AppConfig | null = null;

function defaultAppConfig(): AppConfig {
  return AppConfigSchema.parse({});
}

/**
 * Loads bootstrap configuration from `$LUNA_HOME/config.yaml`.
 * Parses the YAML, resolves `$ENV_VAR` references, and validates against the schema.
 */
function _loadConfigFromFile(): AppConfig {
  const configPath = join(paths.home, "config.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = Bun.YAML.parse(raw) ?? {};
  const resolved = resolveEnvVars(parsed);
  return AppConfigSchema.parse(resolved);
}

/**
 * Reloads bootstrap configuration from disk.
 * Call this after generating or modifying `config.yaml`.
 */
export function reloadConfig(): void {
  _appConfig = _loadConfigFromFile();
}

// Attempt initial load — swallow error so boot-loader can use config.paths before yaml exists.
try {
  _appConfig = _loadConfigFromFile();
} catch {
  // config.yaml may not exist yet; boot-loader will call reloadConfig() after generating it.
}

/**
 * The global bootstrap configuration object.
 * `paths` is always available. Runtime platform settings live in `PlatformSettingsStore`.
 */
export const config = {
  get service() {
    if (!_appConfig) {
      return defaultAppConfig().service;
    }
    return _appConfig.service;
  },
  get runtimePaths() {
    if (!_appConfig) {
      return defaultAppConfig().paths;
    }
    return _appConfig.paths;
  },
  get logging() {
    if (!_appConfig) {
      return defaultAppConfig().logging;
    }
    return _appConfig.logging;
  },
  get sandbox() {
    if (!_appConfig) {
      return SandboxConfigSchema.parse({});
    }
    return _appConfig.sandbox;
  },
  paths,
};
