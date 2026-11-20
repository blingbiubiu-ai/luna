import {fixtureScope} from "../helpers/platform-fixtures";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";

import { AgentSecretCipher } from "../../src/agent-config";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { createAgentConfigRoutes } from "../../src/server/routes/agent-config";
import { reloadConfig, setLunaHome } from "../../src/shared/config";

let agentId: string;
let home: string;
let connection: DataConnection<typeof schema>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-agent-routes-"));
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), "{}\n");
  setLunaHome(home);
  reloadConfig();
  connection = new DataConnection(schema);
  agentId = fixtureScope(connection.db,"admin").agentId;
});

afterEach(() => {
  connection.close();
  rmSync(home, { recursive: true, force: true });
});

function app(authenticated = true) {
  const cipher = AgentSecretCipher.fromEnvironment({
    LUNA_AGENT_CONFIG_MASTER_KEY: randomBytes(32).toString("base64"),
  });
  const root = new Hono();
  if (authenticated) {

    root.use("*", async (c, next) => {
      (c as any).set("lunaAuthorizationDb", connection.db);
      (c as any).set("dashboardAuthSession", {
        authenticated: true,
        account: { id: "admin", name: "Admin", provider: "test" },
      });
      (c as any).set("lunaRequestAuthKind", "dashboard-cookie");
      await next();
    });
  }
  return root.route("/api/agent-config", createAgentConfigRoutes({
    db: connection.db,
    cipher,
    connectionExecutor: {
      execute: async () => ({ success: true, output: "LUNA_AGENT_PROFILE_OK" }),
    },
  }));
}

describe("agent configuration routes", () => {
  test("requires Agent owner and exposes setup state plus descriptors", async () => {
    expect((await app(false).request(scoped("/api/agent-config/status"))).status).toBe(401);
    expect(await (await app().request(scoped("/api/agent-config/status"))).json()).toEqual({
      status: "setup_required",
      active: null,
    });
    const types = await (await app().request(scoped("/api/agent-config/types"))).json() as { types: unknown[] };
    expect(types.types).toHaveLength(2);
  });

  test("creates, tests and activates a masked profile revision", async () => {
    const api = app();
    const createResponse = await api.request(scoped("/api/agent-config/profiles"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Primary Codex",
        agentType: "codex",
        model: "gpt-5",
        env: { OPENAI_BASE_URL: "https://api.example.test/v1" },
        secrets: { OPENAI_API_KEY: { set: "secret-value" } },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      profile: { id: string; latestRevision: { id: string } };
    };
    expect(JSON.stringify(created)).not.toContain("secret-value");

    const premature = await api.request(
      scoped(`/api/agent-config/revisions/${created.profile.latestRevision.id}/activate`),
      { method: "POST" },
    );
    expect(premature.status).toBe(409);

    expect((await api.request(
      scoped(`/api/agent-config/revisions/${created.profile.latestRevision.id}/test`),
      { method: "POST" },
    )).status).toBe(200);
    expect((await api.request(
      scoped(`/api/agent-config/revisions/${created.profile.latestRevision.id}/activate`),
      { method: "POST" },
    )).status).toBe(200);

    const status = await (await api.request(scoped("/api/agent-config/status"))).json() as {
      status: string; active: { agentType: string; model: string };
    };
    expect(status).toMatchObject({
      status: "ready",
      active: { agentType: "codex", model: "gpt-5" },
    });
  });
});

function scoped(path: string) { return `${path}?agentId=${agentId}`; }
