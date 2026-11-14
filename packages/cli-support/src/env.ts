import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Env, LunaCredentials } from "./types";
import { isPlainRecord, readIdentityOption } from "./options";
export { loadDefaultLunaEnv, parseEnvValue } from "@luna/host-runtime/env";

export function credentialsPath(env: Env): string {
  return join(env.LUNA_HOME ?? join(homedir(), ".luna"), "credentials.json");
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
  return readIdentityOption(env.LUNA_ACCESS_TOKEN) ?? readIdentityOption(readCredentials(env)?.accessToken);
}
