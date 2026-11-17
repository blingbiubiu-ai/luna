import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { fixtureScope } from "../helpers/platform-fixtures";
import { kernel } from "@/kernel";
import { runtimeRoutes } from "@/server/routes/runtime";

let home: string, connection: DataConnection<typeof schema>, restore: () => void;
let alice: ReturnType<typeof fixtureScope>, bob: ReturnType<typeof fixtureScope>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-runtime-status-")); setLunaHome(home);
  connection = new DataConnection(schema);
  alice = fixtureScope(connection.db, "alice"); bob = fixtureScope(connection.db, "bob");
  const secret = { ciphertext: "x", nonce: "x", authTag: "x", algorithm: "aes-256-gcm", keyVersion: 1, credentialIdentity: "x" } as never;
  for (const [id, agentId] of [["alice-bot", alice.agentId], ["bob-bot", bob.agentId]] as const) {
    connection.db.insert(schema.channelConfigs).values({ id, agentId, type: "feishu", name: id, appId: id, secret, updatedAt: 1 }).run();
  }
  const state = kernel as unknown as { _lunaMessageIngress: unknown };
  const prior = state._lunaMessageIngress;
  state._lunaMessageIngress = { channelStatuses: () => [{ id: "alice-bot", type: "feishu" }, { id: "bob-bot", type: "feishu" }] };
  restore = () => { state._lunaMessageIngress = prior; };
});
afterEach(() => { restore(); connection.close(); rmSync(home, { recursive: true, force: true }); });

const app = (actor: string) => new Hono().use("*", async (c, next) => {
  (c as any).set("dashboardAuthSession", { authenticated: true, user: { id: actor, name: actor, provider: "test" } });
  (c as any).set("lunaRequestAuthKind", "dashboard-cookie"); (c as any).set("lunaAuthorizationDb", connection.db); await next();
}).route("/runtime", runtimeRoutes);
const channels = async (actor: string, query = "") => {
  const response = await app(actor).request(`/runtime/status${query}`);
  return { status: response.status, ids: ((await response.json()) as { channels?: { id: string }[] }).channels?.map(c => c.id) };
};

test("runtime status shows an Agent owner only that Agent's channels", async () => {
  expect(await channels("alice", `?agentId=${alice.agentId}`)).toEqual({ status: 200, ids: ["alice-bot"] });
  expect((await channels("alice", `?agentId=${bob.agentId}`)).status).toBe(403);
  // Without an Agent scope a non-administrator sees no channel at all.
  expect(await channels("alice")).toEqual({ status: 200, ids: [] });
});
