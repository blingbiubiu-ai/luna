import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runClientCli } from "@luna/cli/main";

type CapturedRequest = {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
};

describe("luna auth status", () => {
  let lunaHome: string;

  beforeEach(() => {
    lunaHome = mkdtempSync(join(tmpdir(), "luna-auth-status-"));
  });

  afterEach(() => {
    rmSync(lunaHome, { recursive: true, force: true });
  });

  test("reports missing local credentials without calling service", async () => {
    const result = await runClientCli(["auth", "status"], {
      LUNA_HOME: lunaHome,
      LUNA_SERVICE_URL: "http://service.test",
    });
    const output = JSON.parse(result.output ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(output).toEqual({
      authenticated: false,
      localCredentials: false,
      serviceUrl: "http://service.test",
      valid: false,
    });
  });

  test("validates stored credentials through /api/auth/me", async () => {
    writeCredentialsFixture(lunaHome);
    await withMockFetch(200, { status: "ok" }, async (captured) => {
      const result = await runClientCli(["auth", "status"], {
        LUNA_HOME: lunaHome,
      });
      const output = JSON.parse(result.output ?? "{}") as Record<string, unknown>;

      expect(result.status).toBe("ok");
      expect(output).toMatchObject({
        authenticated: true,
        localCredentials: true,
        serviceUrl: "http://credential-service.test",
        valid: true,
        serviceReachable: true,
        expiresAt: 1_800_000_000_000,
        user: { id: "user_credential", displayName: "Credential User" },
      });
      expect(captured).toEqual([
        {
          url: "http://credential-service.test/api/auth/me",
          method: "GET",
          authorization: "Bearer credential-token",
        },
      ]);
    });
  });

  test("reports invalid stored credentials when service returns 401", async () => {
    writeCredentialsFixture(lunaHome);
    await withMockFetch(401, { status: "error", code: "unauthorized" }, async () => {
      const result = await runClientCli(["auth", "status"], {
        LUNA_HOME: lunaHome,
      });
      const output = JSON.parse(result.output ?? "{}") as Record<string, unknown>;

      expect(result.status).toBe("ok");
      expect(output).toMatchObject({
        authenticated: false,
        localCredentials: true,
        valid: false,
        serviceReachable: true,
        reason: "access_token_invalid_or_expired",
      });
    });
  });
});

function writeCredentialsFixture(lunaHome: string): void {
  mkdirSync(lunaHome, { recursive: true });
  writeFileSync(
    join(lunaHome, "credentials.json"),
    JSON.stringify({
      serviceUrl: "http://credential-service.test",
      accessToken: "credential-token",
      expiresAt: 1_800_000_000_000,
      user: { id: "user_credential", displayName: "Credential User" },
    }),
  );
}

async function withMockFetch<T>(
  status: number,
  responseBody: unknown,
  fn: (captured: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    captured.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as typeof fetch;
  try {
    return await fn(captured);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
