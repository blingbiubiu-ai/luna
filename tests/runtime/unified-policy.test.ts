import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { fixtureAgent } from "../helpers/platform-fixtures";
import { DEFAULT_OPERATION_POLICIES } from "../../src/operations/operation-registry";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { IdentityDirectory } from "../../src/identity/identity-directory";
import { evaluateOperationPolicy } from "../../src/server/policy/operation-policy";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";

let homes: string[] = [];

async function openFreshDatabase(): Promise<DataConnection<typeof schema>> {
  const home = mkdtempSync(join(tmpdir(), "luna-unified-policy-"));
  homes.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    "messaging:\n  default_channel_id: fake\n  channels: []\n",
  );
  const config = await import("../../src/shared/config/index");
  config.setLunaHome(home);
  config.reloadConfig();
  return new DataConnection(schema);
}

afterEach(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
  homes = [];
});

describe("unified policy", () => {
  test("Operation policy evaluates typed grants", async () => {
    const connection = await openFreshDatabase();
    const user = new IdentityDirectory(connection.db).materializeIdentityClaims({
      kind: "human",
      displayName: "Knowledge Writer",
      claims: [
        {
          namespace: "local",
          kind: "local_id",
          value: "knowledge_writer",
          scope: "",
          confidence: "manual",
        },
      ],
    });
    const grantStore = new AuthorizationRuleStore(connection.db, {kind: "agent", agentId: fixtureAgent(connection.db, user.id).id});
    grantStore.addGrant({ matchType: "exact",
      subjectType: "user",
      subjectId: user.id,
      target: "workspace.knowledge.write",
      effect: "allow",
    });
    const operation = DEFAULT_OPERATION_POLICIES.find(
      (item) => item.id === "workspace.knowledge.write",
    );
    expect(operation).toBeDefined();

    expect(
      evaluateOperationPolicy({
        grants: grantStore.getEffectiveGrantsForUser(user.id),
        operation: operation!,
      }),
    ).toMatchObject({
      decision: "allow",
      matchedRule: "allow_rule_match",
    });
    connection.close();
  });

  test("Operation policy treats high-risk operations as deny by default and allow when granted", async () => {
    const highRiskOperations = DEFAULT_OPERATION_POLICIES.filter(
      (item) => item.riskLevel === "high",
    );

    expect(highRiskOperations.length).toBeGreaterThan(0);
    expect(
      highRiskOperations.map((item) => ({
        id: item.id,
        defaultDecision: item.defaultDecision,
      })),
    ).toEqual(
      highRiskOperations.map((item) => ({
        id: item.id,
        defaultDecision: "deny",
      })),
    );

    const operation = highRiskOperations.find(
      (item) => item.id === "system.admin",
    );
    expect(operation).toBeDefined();

    expect(
      evaluateOperationPolicy({
        grants: [],
        operation: operation!,
      }),
    ).toMatchObject({
      decision: "forbidden",
      matchedRule: "operation_default",
    });

    expect(
      evaluateOperationPolicy({
        grants: [
          { matchType: "exact",
            id: "grant-high-risk",
            subjectType: "user",
            subjectId: "user-high-risk",
            target: operation!.id,
            effect: "allow",
            createdAt: "2026-06-23T00:00:00.000Z",
            updatedAt: "2026-06-23T00:00:00.000Z",
          },
        ],
        operation: operation!,
      }),
    ).toMatchObject({
      decision: "allow",
      matchedRule: "allow_rule_match",
    });
  });

});

describe("wildcard operation grants", () => {
  test("persists patterns, rejects invalid targets, and applies deny after allow", async () => {
    const connection = await openFreshDatabase();
    try {
      const { resolveOperationPolicy } = await import("../../src/operations/operation-registry");
      const { validateOperationGrantTarget } = await import("../../src/server/routes/groups");
      const user = new IdentityDirectory(connection.db).materializeIdentityClaims({
        kind: "human", displayName: "Wildcard test",
        claims: [{ namespace: "local", kind: "local_id", value: "wildcard-test", scope: "", confidence: "manual" }],
      });
      const store = new AuthorizationRuleStore(connection.db, {kind: "agent", agentId: fixtureAgent(connection.db, user.id).id});
      const base = { subjectType: "user" as const, subjectId: user.id };
      store.addGrant({ matchType: "prefix", ...base, target: "workspace", effect: "allow" });
      const deny = store.addGrant({ matchType: "prefix", ...base, target: "workspace.knowledge.write", effect: "deny" });
      expect(store.listGrants({ subjectType: "user", subjectId: user.id })).toHaveLength(2);
      const write = resolveOperationPolicy(connection.db, "workspace.knowledge.write")!;
      const read = resolveOperationPolicy(connection.db, "workspace.knowledge.read")!;
      const grants = store.getEffectiveGrantsForUser(user.id);
      expect(evaluateOperationPolicy({ grants, operation: read }).decision).toBe("allow");
      expect(evaluateOperationPolicy({ grants, operation: write }).decision).toBe("forbidden");
      expect(evaluateOperationPolicy({ grants: [...grants].reverse(), operation: write }).decision).toBe("forbidden");
      expect(evaluateOperationPolicy({ grants, operation: { ...write, id: "workspace.knowledge.write.child" } }).decision).toBe("forbidden");
      expect(evaluateOperationPolicy({ grants, operation: { ...write, id: "workspace2.read" } }).decision).toBe("forbidden");
      expect(evaluateOperationPolicy({ grants: grants.map(g => g.id === deny.id ? { ...g, expiresAt: 1 } : g), operation: write }).decision).toBe("allow");
      for (const operationId of ["*", "workspace.**", "workspace.*.write", "missing.*"]) {
        expect(validateOperationGrantTarget({ db: connection.db, subjectType: "user", target: operationId }).status).toBe("error");
        expect(() => store.addGrant({ matchType: "exact", ...base, target: operationId, effect: "allow" })).toThrow();
      }
      expect(validateOperationGrantTarget({ db: connection.db, subjectType: "group", target: "system.*" }).status).toBe("error");
      store.addGrant({ matchType: "exact", ...base, target: write.id, effect: "allow",  });
      expect(evaluateOperationPolicy({ grants: store.getEffectiveGrantsForUser(user.id), operation: write }).decision).toBe("forbidden");
      expect(evaluateOperationPolicy({ grants, operation: { ...write, defaultDecision: "allow" } }).decision).toBe("forbidden");
      store.deleteGrant(deny.id);
      expect(evaluateOperationPolicy({ grants: store.getEffectiveGrantsForUser(user.id), operation: write }).matchedRule).toBe("allow_rule_match");
      const groupGrant = { ...grants[0]!, subjectType: "group" as const };
      expect(evaluateOperationPolicy({ grants: [groupGrant], operation: { ...read, allowedSubjectTypes: ["user"] } }).decision).toBe("forbidden");
    } finally {
      connection.close();
    }
  });
});
