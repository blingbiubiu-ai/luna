import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Env, LunaCredentials } from "./types";
import { isPlainRecord, readIdentityOption } from "./options";
export { loadDefaultLunaEnv, parseEnvValue } from "@luna/host-runtime/env";

const BLOCKED_TURN_ENV_KEYS = new Set(["LUNA_HOME", "LUNA_TURN_ENV_FILE", "LUNA_AGENT_CONFIG_MASTER_KEY", "LUNA_ACCESS_TOKEN_SECRET"]);

/**
 * Overlay dynamic per-turn LUNA_* variables published by a warm PTY host into `env`.
 * Rejects symlinks and non-regular files; returns `env` unchanged when absent or unlinked.
 */
export function resolveTurnLunaEnv(env: Env): Env {
  const path = env.LUNA_TURN_ENV_FILE?.trim();
  if (!path) return env;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return env;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPlainRecord(parsed)) return env;
    const overlay: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("LUNA_") && !BLOCKED_TURN_ENV_KEYS.has(key) && typeof value === "string") {
        overlay[key] = value;
      }
    }
    return Object.keys(overlay).length > 0 ? { ...env, ...overlay } : env;
  } catch {
    return env;
  }
}

export function credentialsPath(env: Env): string {
  const effective = resolveTurnLunaEnv(env);
  return join(effective.LUNA_HOME ?? join(effective.HOME ?? homedir(), ".luna"), "credentials.json");
}

export function readCredentials(env: Env): LunaCredentials | undefined {
  const path = credentialsPath(env);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPlainRecord(parsed)) {
      return undefined;
    }
    const user = parsed.user;
    if (
      typeof parsed.serviceUrl !== "string" ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      !isPlainRecord(user) ||
      typeof user.id !== "string" ||
      typeof user.displayName !== "string"
    ) {
      return undefined;
    }
    return {
      serviceUrl: parsed.serviceUrl.replace(/\/+$/, ""),
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      user: { id: user.id, displayName: user.displayName },
    };
  } catch {
    return undefined;
  }
}

export function writeCredentials(env: Env, credentials: LunaCredentials): void {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

export function deleteCredentials(env: Env): void {
  rmSync(credentialsPath(env), { force: true });
}

export function resolveAccessToken(env: Env): string | undefined {
  const effective = resolveTurnLunaEnv(env);
  return readIdentityOption(effective.LUNA_ACCESS_TOKEN) ?? readIdentityOption(readCredentials(effective)?.accessToken);
}
