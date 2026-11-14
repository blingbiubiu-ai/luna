import { spawn } from "node:child_process";

import type { CliResult, Env, LunaCredentials } from "@luna/cli-support/types";
import { deleteCredentials, readCredentials, writeCredentials } from "@luna/cli-support/env";
import { setTimeout as sleep } from "node:timers/promises";
import { parseJsonPayload, resolveServiceBaseUrl, serviceErrorMessage } from "@luna/cli-support/service-client";
import { authHelpText, authSubcommandHelpText } from "@luna/cli-support/help";
import { hasFlag } from "@luna/cli-support/options";

export async function runAuthCli(argv: readonly string[], env: Env): Promise<CliResult> {
  const [subcommand] = argv;
  if (!subcommand || subcommand === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    const requested = subcommand === "help" ? argv[1] : subcommand;
    if (requested && requested !== "help" && !requested.startsWith("-")) {
      const subcommandHelp = authSubcommandHelpText(requested);
      if (subcommandHelp) {
        return { status: "ok", output: subcommandHelp };
      }
    }
    return { status: "ok", output: authHelpText() };
  }
  if (subcommand === "status") {
    const credentials = readCredentials(env);
    const serviceUrl = credentials?.serviceUrl ?? resolveServiceBaseUrl(env);
    if (credentials === undefined) {
      return {
        status: "ok",
        output: JSON.stringify({
          authenticated: false,
          localCredentials: false,
          serviceUrl,
          valid: false,
        }),
      };
    }
    const validation = await validateCurrentCredentials(credentials);
    return {
      status: "ok",
      output: JSON.stringify({
        authenticated: validation.valid === true,
        localCredentials: true,
        serviceUrl,
        expiresAt: credentials.expiresAt,
        user: credentials.user,
        valid: validation.valid,
        serviceReachable: validation.serviceReachable,
        ...(validation.reason === undefined ? {} : { reason: validation.reason }),
      }),
    };
  }
  if (subcommand === "logout") {
    const credentials = readCredentials(env);
    if (credentials === undefined) {
      deleteCredentials(env);
      return { status: "ok", output: JSON.stringify({ revoked: false, authenticated: false }) };
    }
    let revoked = false;
    try {
      const response = await fetch(`${credentials.serviceUrl.replace(/\/+$/, "")}/api/auth/tokens/current`, {
        method: "DELETE",
        headers: new Headers({
          accept: "application/json",
          authorization: `Bearer ${credentials.accessToken}`,
        }),
      });
      revoked = response.ok || response.status === 401 || response.status === 404;
    } catch {
      revoked = false;
    } finally {
      deleteCredentials(env);
    }
    return { status: "ok", output: JSON.stringify({ revoked, authenticated: false }) };
  }
  if (subcommand === "login") {
    try {
      return await runAuthLoginCli(env);
    } catch (error) {
      return {
        status: "error",
        code: "auth_login_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    status: "error",
    code: "unknown_auth_command",
    message: `unknown auth command: ${subcommand}`,
  };
}

async function validateCurrentCredentials(
  credentials: LunaCredentials,
): Promise<{
  readonly valid: boolean | null;
  readonly serviceReachable: boolean;
  readonly reason?: string;
}> {
  try {
    const response = await fetch(`${credentials.serviceUrl.replace(/\/+$/, "")}/api/auth/me`, {
      method: "GET",
      headers: new Headers({
        accept: "application/json",
        authorization: `Bearer ${credentials.accessToken}`,
      }),
    });
    if (response.ok) {
      return { valid: true, serviceReachable: true };
    }
    if (response.status === 401) {
      return {
        valid: false,
        serviceReachable: true,
        reason: "access_token_invalid_or_expired",
      };
    }
    return {
      valid: null,
      serviceReachable: true,
      reason: `service_returned_http_${response.status}`,
    };
  } catch (error) {
    return {
      valid: null,
      serviceReachable: false,
      reason: error instanceof Error ? error.message : "failed to reach Luna Service",
    };
  }
}

export async function runAuthLoginCli(env: Env): Promise<CliResult> {
  const serviceUrl = resolveServiceBaseUrl(env);
  const started = await authJsonRequest<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    intervalSeconds?: number;
  }>(`${serviceUrl}/api/auth/cli/start`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
    body: JSON.stringify({}),
  });
  void openBrowserBestEffort(started.verificationUri, env);

  const intervalMs = Math.max(1, started.intervalSeconds ?? 2) * 1000;
  while (Date.now() < started.expiresAt) {
    const polled = await authJsonRequest<{
      status?: string;
      accessToken?: string;
      expiresAt?: number;
      user?: { id: string; displayName: string };
    }>(`${serviceUrl}/api/auth/cli/poll`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    });
    if (polled.status === "approved" && polled.accessToken && polled.expiresAt && polled.user) {
      const credentials: LunaCredentials = {
        serviceUrl,
        accessToken: polled.accessToken,
        expiresAt: polled.expiresAt,
        user: polled.user,
      };
      writeCredentials(env, credentials);
      return {
        status: "ok",
        output: JSON.stringify({
          authenticated: true,
          serviceUrl,
          expiresAt: credentials.expiresAt,
          user: credentials.user,
        }),
      };
    }
    if (polled.status === "authorization_denied" || polled.status === "denied") {
      return { status: "error", code: "authorization_denied", message: "Luna CLI authorization was denied" };
    }
    if (polled.status === "authorization_expired" || polled.status === "expired") {
      return { status: "error", code: "authorization_expired", message: "Luna CLI authorization expired" };
    }
    await sleep(intervalMs);
  }
  return { status: "error", code: "authorization_expired", message: "Luna CLI authorization expired" };
}

export async function authJsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = parseJsonPayload(text);
  if (!response.ok) {
    throw new Error(serviceErrorMessage(payload, response.status));
  }
  return payload as T;
}

export function openBrowserBestEffort(url: string, env: Env): void {
  if (env.LUNA_AUTH_OPEN_BROWSER === "0") {
    return;
  }
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Opening a browser is best-effort; the CLI caller can still copy the URL
    // from the service or logs when a desktop opener is unavailable.
  }
}
