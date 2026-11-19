import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { AgentSettingsStore, DEFAULT_AGENT_SETTINGS } from "@/agents/agent-settings-store";
import { createPlatformAgentRoutes } from "@/server/routes/platform-agents";
import { fixtureScope } from "../helpers/platform-fixtures";

let home: string, connection: DataConnection<typeof schema>, agentId: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-agent-settings-")); setLunaHome(home);
  connection = new DataConnection(schema);
  agentId = fixtureScope(connection.db, "owner").agentId; fixtureScope(connection.db, "other");
});
afterEach(() => { connection.close(); rmSync(home, { recursive: true, force: true }); });

test("an Agent without settings gets today's behaviour as defaults", () => {
  expect(new AgentSettingsStore(connection.db).get(agentId)).toEqual(DEFAULT_AGENT_SETTINGS);
  expect(DEFAULT_AGENT_SETTINGS).toEqual({ inbound: { processingReaction: true }, work: { progressCard: { show: true, style: "card" } }, main: { taskProgressCard: { send: true, style: "native" } } });
});

test("the owner saves settings; omitted groups keep their defaults and bad values are refused", () => {
  const store = new AgentSettingsStore(connection.db);
  expect(store.save("owner", agentId, { work: { progressCard: { show: false } } })).toEqual({
    inbound: { processingReaction: true }, work: { progressCard: { show: false, style: "card" } }, main: { taskProgressCard: { send: true, style: "native" } } });
  expect(store.get(agentId).work.progressCard.show).toBe(false);
  expect(() => store.save("owner", agentId, { work: { progressCard: { style: "fancy" } } })).toThrow();
  expect(() => store.save("owner", agentId, { unknown: true })).toThrow();
  expect(() => store.save("other", agentId, {})).toThrow();
  expect(() => store.read("other", agentId)).toThrow();
});

test("the settings API is the owner's: read, save, reject others and invalid input", async () => {
  const app = new Hono().use("*", async (c, next) => {
    const id = c.req.header("Test-Actor");
    if (id) { (c as never as { set: (k: string, v: unknown) => void }).set("dashboardAuthSession", { authenticated: true, account: { id, name: id, provider: "test" } });
      (c as never as { set: (k: string, v: unknown) => void }).set("lunaRequestAuthKind", "dashboard-cookie"); }
    await next();
  }).route("/agents", createPlatformAgentRoutes(connection.db));
  const call = (actor: string, method = "GET", body?: unknown) => app.request(`/agents/${agentId}/settings`, {
    method, headers: { "Test-Actor": actor, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(await (await call("owner")).json()).toEqual({ settings: DEFAULT_AGENT_SETTINGS });
  const saved = await call("owner", "PUT", { main: { taskProgressCard: { send: false, style: "card" } } });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { settings: typeof DEFAULT_AGENT_SETTINGS }).settings.main.taskProgressCard).toEqual({ send: false, style: "card" });
  expect((await call("owner", "PUT", { main: { taskProgressCard: { style: 1 } } })).status).toBe(400);
  expect((await call("other")).status).not.toBe(200);
  expect((await call("other", "PUT", {})).status).not.toBe(200);
});
