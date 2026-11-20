import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { fixturePlatformAdmin } from "../helpers/platform-fixtures";
import { createPluginsRoutes } from "@/server/routes/plugins";

let home: string, connection: DataConnection<typeof schema>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-plugin-source-")); setLunaHome(home);
  connection = new DataConnection(schema);
  fixturePlatformAdmin(connection.db, "admin");
});
afterEach(() => {
  connection.close(); rmSync(home, { recursive: true, force: true });
});

test("an unconfigured plugin source is reported as such, not as a server error", async () => {
  const app = new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", { authenticated: true, account: { id: "admin", name: "admin", provider: "test" } });
    (c as any).set("lunaRequestAuthKind", "dashboard-cookie"); (c as any).set("lunaAuthorizationDb", connection.db); await next();
  }).route("/plugins", createPluginsRoutes({ db: connection.db }));
  for (const path of ["/plugins", "/plugins/echo"]) {
    const response = await app.request(path);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "plugin_marketplace_unconfigured", message: expect.stringContaining("平台设置") });
  }
});
