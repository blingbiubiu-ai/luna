import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../src/data/schema";
import { AgentStore } from "../../src/agents/agent-store";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { GroupStore } from "../../src/server/groups/group-store";
import { fixtureAgent } from "../helpers/platform-fixtures";

test("grants, deny rules and deletion remain confined to their Agent", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, {schema});
  migrate(db, {migrationsFolder: "src/data/drizzle"});
  try {
    const a = fixtureAgent(db, "owner-a"), b = fixtureAgent(db, "owner-b");
    const agents = new AgentStore(db);
    const rulesA = new AuthorizationRuleStore(db, {kind: "agent", agentId: a.id});
    const rulesB = new AuthorizationRuleStore(db, {kind: "agent", agentId: b.id});
    const rule = rulesA.addGrant({subjectType: "user", subjectId: "owner-a", target: "workspace.knowledge.read", effect: "allow"});
    expect(rulesA.getEffectiveGrantsForUser("owner-a")).toHaveLength(1);
    expect(rulesB.getEffectiveGrantsForUser("owner-a")).toEqual([]);
    expect(rulesB.deleteGrant(rule.id)).toBeNull();
    expect(rulesA.listGrants()).toHaveLength(1);
    rulesB.addGrant({subjectType: "user", subjectId: "owner-a", target: "workspace.knowledge.read", effect: "deny"});
    expect(rulesA.getEffectiveGrantsForUser("owner-a")[0]?.effect).toBe("allow");
    expect(rulesB.getEffectiveGrantsForUser("owner-a")[0]?.effect).toBe("deny");
    expect(() => rulesA.addGrant({subjectType: "user", subjectId: "owner-a", target: "system.admin", effect: "allow"})).toThrow("platform_operation");
    expect(() => new AuthorizationRuleStore(db).listGrants()).toThrow("authorization_scope_required");
  } finally {sqlite.close();}
});

test("identical group names are independent and a foreign group cannot be granted Agent access", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, {schema});
  migrate(db, {migrationsFolder: "src/data/drizzle"});
  try {
    const a = fixtureAgent(db, "owner-a"), b = fixtureAgent(db, "owner-b");
    const groups = new GroupStore(db);
    const groupA = groups.createGroup({agentId:a.id, slug:"readers", displayName:"Readers"});
    const groupB = groups.createGroup({agentId:b.id, slug:"readers", displayName:"Readers"});
    expect(groupA.id).not.toBe(groupB.id);
    groups.addMember({groupId: groupA.id, userId:"owner-a"});
    const rulesA = new AuthorizationRuleStore(db, {kind:"agent", agentId:a.id});
    expect(() => rulesA.addGrant({subjectType:"group", subjectId:groupB.id, target:"workspace.knowledge.read", effect:"allow"})).toThrow("Group not found");
    rulesA.addGrant({subjectType:"group", subjectId:groupA.id, target:"workspace.knowledge.read", effect:"allow"});
    expect(rulesA.getEffectiveGrantsForUser("owner-a")).toHaveLength(1);
    expect(new AuthorizationRuleStore(db, {kind:"agent", agentId:b.id}).getEffectiveGrantsForUser("owner-a")).toEqual([]);
  } finally {sqlite.close();}
});
