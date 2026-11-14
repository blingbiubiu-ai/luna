import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveEnvVars } from "./env-resolver";
import * as paths from "./paths";
import type { AppConfig } from "./schema";
import {
  AppConfig as AppConfigSchema,
  PluginsConfig as PluginsConfigSchema,
  RunnerConfig as RunnerConfigSchema,
  SessionConfig as SessionConfigSchema,
  SandboxConfig as SandboxConfigSchema,
} from "./schema";

export type {
  AppConfig,
  ChannelConfig,
  ChannelParams,
  PluginsConfig,
  PluginMarketplaceConfig,
  SessionConfig,
  ServiceConfig,
  PathsConfig,
  LoggingConfig,
  MessagingConfig,
  SandboxConfig,
  RunnerConfig,
  GitConfig,
} from "./schema";
export {
  setLunaHome,
  setRunnerRootBase,
  setSharedWorkspacePath,
} from "./paths";

/**
 * Combined configuration interface including both YAML-loaded app config and paths.
 */
export interface Config extends Omit<AppConfig, "paths"> {
  runtimePaths: AppConfig["paths"];
  paths: typeof paths;
}

let _appConfig: AppConfig | null = null;

function defaultAppConfig(): AppConfig {
  return AppConfigSchema.parse({
    messaging: { default_channel_id: "", channels: [] },
  });
}

/**
 * Loads the application configuration from `$LUNA_HOME/config.yaml`.
 * Parses the YAML, resolves `$ENV_VAR` references, and validates against the schema.
 */
function _loadConfigFromFile(): AppConfig {
  const configPath = join(paths.home, "config.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = Bun.YAML.parse(raw);
  const resolved = resolveEnvVars(parsed);
  return AppConfigSchema.parse(resolved);
}

/**
 * Reloads the application configuration from disk.
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
 * The global application configuration object.
 * `paths` is always available. Other properties require `config.yaml` to be loaded.
 */
export const config = {
  get timezone() {
    if (!_appConfig) {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    return _appConfig.timezone;
  },
  get messaging() {
    if (!_appConfig) {
      throw new Error(
        "config.yaml has not been loaded yet. Call reloadConfig() first.",
      );
    }
    return _appConfig.messaging;
  },
  get session() {
    if (!_appConfig) {
      return SessionConfigSchema.parse({});
    }
    return _appConfig.session;
  },
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
  get plugins() {
    if (!_appConfig) {
      return PluginsConfigSchema.parse({});
    }
    return _appConfig.plugins;
  },
  get sandbox() {
    if (!_appConfig) {
      return SandboxConfigSchema.parse({});
    }
    return _appConfig.sandbox;
  },
  get runner() {
    if (!_appConfig) {
      return RunnerConfigSchema.parse({});
    }
    return _appConfig.runner;
  },
  get git() {
    return _appConfig?.git;
  },
  paths,
};
