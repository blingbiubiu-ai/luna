import { afterEach, describe, expect, test } from "bun:test";
import { assertSafeDashboardBinding, DEFAULT_LUNA_DASHBOARD_TOKEN } from "@luna/host-runtime/defaults";
import { resolveAgentRuntimeStartOptions } from "../../src/cli/commands/agent";
import { HonoServer } from "../../src/server/server";

const originalHost = process.env.LUNA_SERVICE_HOST;
const originalToken = process.env.LUNA_DASHBOARD_TOKEN;
afterEach(() => {
  if (originalHost === undefined) delete process.env.LUNA_SERVICE_HOST;
  else process.env.LUNA_SERVICE_HOST = originalHost;
  if (originalToken === undefined) delete process.env.LUNA_DASHBOARD_TOKEN;
  else process.env.LUNA_DASHBOARD_TOKEN = originalToken;
});

describe("dashboard listener security", () => {
  test("public and DNS listeners reject missing, blank and explicitly configured development tokens", () => {
    for (const host of ["0.0.0.0", "::", "192.0.2.10", "localhost", "example.com", ""]) {
      for (const token of [undefined, "  ", DEFAULT_LUNA_DASHBOARD_TOKEN, ` ${DEFAULT_LUNA_DASHBOARD_TOKEN} `]) {
        expect(() => assertSafeDashboardBinding(host, token)).toThrow("unique LUNA_DASHBOARD_TOKEN");
      }
      expect(() => assertSafeDashboardBinding(host, "deployment-specific-token")).not.toThrow();
    }
  });

  test("literal loopback retains development startup", () => {
    for (const host of ["127.0.0.1", "::1"]) {
      expect(() => assertSafeDashboardBinding(host, undefined)).not.toThrow();
    }
  });

  test("CLI validates the effective host including overrides before starting a daemon", () => {
    expect(() => resolveAgentRuntimeStartOptions(["--host", "0.0.0.0"], {})).toThrow("unique LUNA_DASHBOARD_TOKEN");
    expect(() => resolveAgentRuntimeStartOptions([], { LUNA_SERVICE_HOST: "::", LUNA_DASHBOARD_TOKEN: DEFAULT_LUNA_DASHBOARD_TOKEN })).toThrow();
    expect(resolveAgentRuntimeStartOptions(["--host", "127.0.0.1"], { LUNA_SERVICE_HOST: "0.0.0.0" }).host).toBe("127.0.0.1");
    expect(resolveAgentRuntimeStartOptions(["--host", "0.0.0.0"], { LUNA_DASHBOARD_TOKEN: "deployment-specific-token" }).host).toBe("0.0.0.0");
  });

  test("direct HTTP startup cannot bypass the CLI guard", async () => {
    process.env.LUNA_SERVICE_HOST = "0.0.0.0";
    process.env.LUNA_DASHBOARD_TOKEN = DEFAULT_LUNA_DASHBOARD_TOKEN;
    const server = new HonoServer();
    try {
      await expect(server.start()).rejects.toThrow("unique LUNA_DASHBOARD_TOKEN");
    } finally {
      await server.stop();
    }
  });
});
