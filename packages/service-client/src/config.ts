import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface KnowledgeConfig {
  agentId?: string;
  serviceUrl: string;
  accessToken?: string;
}

type Env = Record<string, string | undefined>;

const DEFAULT_LUNA_SERVICE_HOST = "127.0.0.1";
const DEFAULT_LUNA_SERVICE_PORT = "8090";

export function loadKnowledgeConfig(argv: readonly string[], env: Env = process.env): KnowledgeConfig {
  const resolvedEnv = loadLunaConfigEnv(env);
  const credentials = readCredentials(env);
  const agentId = readArg(argv, "--agent-id") ?? resolvedEnv.LUNA_AGENT_ID;
  const accessToken = readArg(argv, "--access-token") ??
    resolvedEnv.LUNA_ACCESS_TOKEN ??
    credentials?.accessToken;
  return {
    serviceUrl: resolveServiceUrl(argv, resolvedEnv, credentials),
    ...(agentId ? { agentId } : {}),
    ...(accessToken ? { accessToken } : {})
  };
}

function loadLunaConfigEnv(env: Env): Env {
  const lunaHome = env.LUNA_HOME ?? join(env.HOME ?? homedir(), ".luna");
  const configPath = join(lunaHome, "config.yaml");
  if (!existsSync(configPath)) {
    return env;
  }
  const parsed = Bun.YAML.parse(readFileSync(configPath, "utf8")) as unknown;
  const configEnv = serviceConfigToEnv(parsed);
  return {
    ...configEnv,
    ...env,
  };
}

function resolveServiceUrl(
  argv: readonly string[],
  env: Env,
  credentials: LunaCredentials | undefined,
): string {
  const explicit = readArg(argv, "--service-url") ??
    env.LUNA_SERVICE_URL ??
    credentials?.serviceUrl;
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim().replace(/\/+$/, "");
  }
  const host = readArg(argv, "--service-host") ?? env.LUNA_SERVICE_HOST ?? DEFAULT_LUNA_SERVICE_HOST;
  const port = readArg(argv, "--service-port") ?? env.LUNA_SERVICE_PORT ?? DEFAULT_LUNA_SERVICE_PORT;
  const clientHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${clientHost}:${port}`;
}

interface LunaCredentials {
  readonly serviceUrl: string;
  readonly accessToken: string;
}

function readCredentials(env: Env): LunaCredentials | undefined {
  const path = join(env.LUNA_HOME ?? join(homedir(), ".luna"), "credentials.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { serviceUrl?: unknown }).serviceUrl !== "string" ||
      typeof (parsed as { accessToken?: unknown }).accessToken !== "string"
    ) {
      return undefined;
    }
    return {
      serviceUrl: (parsed as { serviceUrl: string }).serviceUrl.replace(/\/+$/, ""),
      accessToken: (parsed as { accessToken: string }).accessToken,
    };
  } catch {
    return undefined;
  }
}

function serviceConfigToEnv(config: unknown): Env {
  if (!isRecord(config)) {
    return {};
  }
  return compactEnv({
    LUNA_SERVICE_HOST: readPath(config, ["service", "host"]),
    LUNA_SERVICE_PORT: readPath(config, ["service", "port"]),
    LUNA_SERVICE_URL: readPath(config, ["service", "publicUrl"]),
  });
}

function compactEnv(values: Record<string, unknown>): Env {
  const result: Env = {};
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

function readArg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}
