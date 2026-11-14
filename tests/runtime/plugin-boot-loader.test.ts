import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { loadPluginsForBoot } from "../../src/plugins/loader";
import { BUNDLED_PLUGINS } from "../../src/plugins/bundled-registry";
import { setLunaHome } from "../../src/shared";

let testHome: string;
let database: DataConnection<typeof schema>;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-bootloader-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(schema);
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("loadPluginsForBoot", () => {
  test("returns a registry when no marketplace plugins are installed", async () => {
    const registry = await loadPluginsForBoot({ db: database.db, configByPluginId: {} });
    expect(registry.listPlugins()).toHaveLength(BUNDLED_PLUGINS.length);
  });

  test("installed plugin failure does not block boot", async () => {
    database.db.insert(schema.pluginInstallations).values({
      plugin_id: "broken",
      desired_state: "enabled",
      desired_version: "1.0.0",
      desired_release_sha256: "abc123",
      desired_installed_path: "/nonexistent/broken",
      active_state: "disabled",
      pending_action: "none",
    }).run();

    const registry = await loadPluginsForBoot({ db: database.db, configByPluginId: {} });
    expect(registry).toBeDefined();
    expect(registry.getPlugin("broken")).toBeUndefined();
  });
});
