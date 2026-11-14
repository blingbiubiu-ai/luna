import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnowledgeConfig } from "@luna/service-client/config";

describe("knowledge backend config", () => {
  test("defaults to service URL derived from service host and port", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-client-empty-home-"));
    try {
      const config = loadKnowledgeConfig([], {
        LUNA_HOME: home,
        LUNA_SERVICE_HOST: "0.0.0.0",
        LUNA_SERVICE_PORT: "8090",
      });

      expect(config).toEqual({
        serviceUrl: "http://127.0.0.1:8090",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("loads service URL defaults from Luna config yaml", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-client-config-home-"));
    const home = join(root, ".luna");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), [
      "service:",
      "  host: 0.0.0.0",
      "  port: 9105",
      "paths:",
      "  runtimeDir: /tmp/luna-client-config",
    ].join("\n"));

    try {
      const config = loadKnowledgeConfig([], {
        HOME: root,
        LUNA_HOME: home,
      });

      expect(config).toEqual({
        serviceUrl: "http://127.0.0.1:9105",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults to Luna Service port 8090 when no port is configured", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-client-default-port-"));
    try {
      const config = loadKnowledgeConfig([], {
        LUNA_HOME: home,
      });

      expect(config).toEqual({
        serviceUrl: "http://127.0.0.1:8090",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("explicit service URL and access token are respected", () => {
    const config = loadKnowledgeConfig([], {
      LUNA_SERVICE_URL: "https://service.example/base/",
      LUNA_ACCESS_TOKEN: "access-token",
    });

    expect(config).toEqual({
      serviceUrl: "https://service.example/base",
      accessToken: "access-token"
    });
  });

  test("legacy backend and profile env no longer change service selection", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-client-empty-home-"));
    try {
      const config = loadKnowledgeConfig(["--backend", "local"], {
        LUNA_HOME: home,
        LUNA_PROFILE: "team",
      });

      expect(config).toEqual({
        serviceUrl: "http://127.0.0.1:8090"
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
