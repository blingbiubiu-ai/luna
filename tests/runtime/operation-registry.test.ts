import { fixtureAgent } from "../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import {
  resolveOperationPolicy,
  registerPluginOperations,
} from "../../src/operations/operation-registry";
import { setLunaHome } from "../../src/shared";
import type { OperationDefinition } from "@luna/plugin-contracts";

let testHome: string;
let database: DataConnection<typeof schema>;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-capreg-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(schema);
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("operationFromPluginDefinition defaultDecision", () => {
  test("respects defaultDecision allow/deny from definition", () => {
    const defs: OperationDefinition[] = [
      { id: "x.gate", title: "gate", inputSchema: {}, riskLevel: "low", artifactPolicy: "none", defaultDecision: "allow", pluginId: "x" },
      { id: "x.op", title: "op", inputSchema: {}, riskLevel: "low", artifactPolicy: "none", defaultDecision: "deny", pluginId: "x" },
      { id: "x.implicit", title: "implicit", inputSchema: {}, riskLevel: "low", artifactPolicy: "none", pluginId: "x" },
    ];
    registerPluginOperations(database.db, defs, ["x"]);
    expect(resolveOperationPolicy(database.db, "x.gate")?.defaultDecision).toBe("allow");
    expect(resolveOperationPolicy(database.db, "x.op")?.defaultDecision).toBe("deny");
    expect(resolveOperationPolicy(database.db, "x.implicit")?.defaultDecision).toBe("deny");
  });

  test("removes stale suggestions while preserving authorization rules", () => {
    registerPluginOperations(database.db, [
      definition("x.current", "x"),
      definition("x.stale", "x"),
    ], ["x"]);
    insertGrant("grant-stale", "x.stale");

    registerPluginOperations(
      database.db,
      [definition("x.current", "x", "allow")],
      ["x"],
    );

    expect(resolveOperationPolicy(database.db, "x.current")?.defaultDecision).toBe("allow");
    expect(resolveOperationPolicy(database.db, "x.stale")).toBeUndefined();
    expect(database.db.select().from(schema.authorizationRules).where(
      eq(schema.authorizationRules.id, "grant-stale"),
    ).get()).toBeDefined();
  });

  test("retains wildcard grants through removal and later registration", () => {
    registerPluginOperations(database.db, [definition("x.old", "x")], ["x"]);
    insertGrant("grant-pattern", "x.*");
    registerPluginOperations(database.db, [], ["x"]);
    expect(database.db.select().from(schema.authorizationRules).where(
      eq(schema.authorizationRules.id, "grant-pattern"),
    ).get()?.target).toBe("x");
    registerPluginOperations(database.db, [definition("x.new", "x")], ["x"]);
    expect(resolveOperationPolicy(database.db, "x.new")).toBeDefined();
    expect(resolveOperationPolicy(database.db, "x.*")).toBeUndefined();
  });

  test("moving LogTool operations into examplecli preserves existing grants", () => {
    registerPluginOperations(database.db, [definition("logtool.tool.log", "logtool"), definition("examplecli.log", "examplecli")], ["logtool", "examplecli"]);
    insertGrant("logtool-existing", "logtool.tool.log");
    registerPluginOperations(database.db, [definition("logtool.tool.log", "examplecli"), definition("examplecli.log", "examplecli")], ["examplecli"]);
    expect(resolveOperationPolicy(database.db, "logtool.tool.log")?.pluginId).toBe("examplecli");
    expect(database.db.select().from(schema.authorizationRules).where(eq(schema.authorizationRules.id, "logtool-existing")).get()?.target).toBe("logtool.tool.log");
  });

  test("replaces runtime suggestions without deleting persisted rules or builtin operations", () => {
    registerPluginOperations(database.db, [
      definition("x.stale", "x"),
      definition("y.stale", "y"),
    ], ["x", "y"]);
    insertGrant("grant-y", "y.stale");

    registerPluginOperations(database.db, [], ["x"]);

    expect(resolveOperationPolicy(database.db, "x.stale")).toBeUndefined();
    expect(resolveOperationPolicy(database.db, "y.stale")).toBeUndefined();
    expect(resolveOperationPolicy(database.db, "system.admin")).toBeDefined();
    expect(database.db.select().from(schema.authorizationRules).where(
      eq(schema.authorizationRules.id, "grant-y"),
    ).get()).toBeDefined();
  });
});

function definition(
  id: string,
  pluginId: string,
  defaultDecision: "allow" | "deny" = "deny",
): OperationDefinition {
  return {
    id,
    pluginId,
    providerType: "plugin",
    title: id,
    inputSchema: { type: "object" },
    riskLevel: "low",
    artifactPolicy: "none",
    defaultDecision,
  };
}

function insertGrant(id: string, operationId: string): void {
  const now = String(Date.now());
  database.db.insert(schema.authorizationRules).values({scopeType: "agent", agentId: fixtureAgent(database.db).id, matchType: operationId.endsWith(".*") ? "prefix" : "exact",
    id,
    subjectType: "group",
    subjectId: "operators",
    target: operationId.replace(/\.\*$/, ""),
    effect: "allow",
    createdAt: now,
    updatedAt: now,
  }).run();
}
