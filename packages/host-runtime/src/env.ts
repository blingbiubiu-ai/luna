import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LunaEnv = Record<string, string | undefined>;

export function defaultLunaHome(env: LunaEnv = process.env): string {
  return env.LUNA_HOME ?? join(env.HOME ?? homedir(), ".luna");
}

export function loadDefaultLunaEnv(env: LunaEnv = process.env): LunaEnv {
  return loadLunaEnvAt(defaultLunaHome(env), env);
}

/** Read only the explicitly selected component home. */
export function loadLunaEnvAt(home: string, env: LunaEnv = process.env): LunaEnv {
  const explicitKeys = new Set(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key]) => key),
  );
  loadConfigYamlEnv(env, explicitKeys, join(home, "config.yaml"));
  loadDotEnv(env, explicitKeys, join(home, ".env"));
  return env;
}

export function parseEnvValue(value: string): string {
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === "\"" || value[0] === "'")
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadDotEnv(
  env: LunaEnv,
  explicitKeys: ReadonlySet<string>,
  envPath: string,
): void {
  if (!existsSync(envPath)) {
    return;
  }
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const parsed = parseEnvLine(line);
    if (parsed === undefined || explicitKeys.has(parsed.key)) {
      continue;
    }
    setLoadedEnv(env, parsed.key, parsed.value);
  }
}

function loadConfigYamlEnv(
  env: LunaEnv,
  explicitKeys: ReadonlySet<string>,
  configPath: string,
): void {
  if (!existsSync(configPath)) {
    return;
  }
  const parsed = Bun.YAML.parse(readFileSync(configPath, "utf8")) as unknown;
  for (const [key, value] of Object.entries(configToEnv(parsed))) {
    if (explicitKeys.has(key)) {
      continue;
    }
    setLoadedEnv(env, key, value);
  }
}

function configToEnv(config: unknown): Record<string, string> {
  if (!isRecord(config)) {
    return {};
  }
  return compactEnv({
    LUNA_SERVICE_HOST: readPath(config, ["service", "host"]),
    LUNA_SERVICE_PORT: readPath(config, ["service", "port"]),
    LUNA_SERVICE_URL: readPath(config, ["service", "publicUrl"]),
    LUNA_FEISHU_APP_ID: readPath(config, ["auth", "feishu", "appId"]),
    LUNA_FEISHU_APP_SECRET: readPath(config, ["auth", "feishu", "appSecret"]),
    LUNA_FEISHU_HOST: readPath(config, ["auth", "feishu", "host"]),
    LUNA_FEISHU_PUBLIC_BASE_URL: readPath(config, ["auth", "feishu", "publicBaseUrl"]),
    LUNA_REPO_ROOT: readPath(config, ["paths", "repoRoot"]),
    LUNA_RUNTIME_DIR: readPath(config, ["paths", "runtimeDir"]),
    LUNA_ARTIFACTS_DIR: readPath(config, ["paths", "artifactsDir"]),
    LUNA_RUNNERS_DIR: readPath(config, ["paths", "runnersDir"]),
    LUNA_SHARED_WORKSPACE_DIR: readPath(config, ["paths", "sharedWorkspaceDir"]),
    LUNA_LOG_LEVEL: readPath(config, ["logging", "level"]),
    LUNA_LOG_PRETTY: readPath(config, ["logging", "pretty"]),
  });
}

function compactEnv(values: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.trim().length > 0) {
      result[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
    }
  }
  return result;
}

function readPath(config: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setLoadedEnv(env: LunaEnv, key: string, value: string): void {
  env[key] = value;
  if (env === process.env && Bun.env[key] === undefined) {
    Bun.env[key] = value;
  }
}

function parseEnvLine(
  line: string,
): { readonly key: string; readonly value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
    return undefined;
  }
  const [rawKey, ...valueParts] = trimmed.split("=");
  let key = rawKey?.trim() ?? "";
  if (key.startsWith("export ")) {
    key = key.slice("export ".length).trim();
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }
  return {
    key,
    value: parseEnvValue(valueParts.join("=").trim()),
  };
}
