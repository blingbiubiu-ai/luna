import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {AgentMemoryStore} from "@/agents/agent-memory-store";
import {canAccountPublishLineage, LineageConflictError, LineageMemoryStore, setAccountPublishLineage} from "@/agents/lineage-memory-store";

let home: string;
let conn: DataConnection<typeof schema>;
let agents: AgentStore;
let memories: AgentMemoryStore;
let lineages: LineageMemoryStore;

function createAccount(id: string, displayName: string) {
  const now = Date.now();
  conn.db.insert(schema.accounts).values({id, displayName, avatarUrl: null, status: "active", createdAt: now, updatedAt: now}).run();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-lineage-"));
  setLunaHome(home);
  conn = new DataConnection(schema);
  agents = new AgentStore(conn.db);
  memories = new AgentMemoryStore(conn.db);
  lineages = new LineageMemoryStore(conn.db);
  createAccount("acc_master", "师父");
  createAccount("acc_disciple_b", "徒弟B");
  createAccount("acc_disciple_c", "徒孙C");
  setAccountPublishLineage(conn.db, "acc_master", true);
  setAccountPublishLineage(conn.db, "acc_disciple_b", true);
  setAccountPublishLineage(conn.db, "acc_disciple_c", true);
});

test("accounts cannot enable outbound lineage by default until granted by platform admin, but can still receive invites", () => {
  createAccount("acc_regular", "普通用户");
  expect(canAccountPublishLineage(conn.db, "acc_regular")).toBe(false);
  const regularAgent = agents.create("acc_regular", {name: "RegularAgent"}, "k-reg");
  expect(() => lineages.upsertForAgent("acc_regular", regularAgent.id, {name: "未授权传承"}))
    .toThrow(/lineage_publish_forbidden/);

  // Regular user CAN still receive an invite from an authorized account.
  const master = agents.create("acc_master", {name: "MasterForRegular"}, "k-mreg");
  lineages.upsertForAgent("acc_master", master.id, {name: "授权传承"});
  const {token} = lineages.createInvite("acc_master", master.id);
  const sub = lineages.acceptInvite("acc_regular", token, {mode: "attach_agent", agentId: regularAgent.id});
  expect(sub.subscription.status).toBe("active");

  // Once admin enables permission, the account can open its own lineage.
  setAccountPublishLineage(conn.db, "acc_regular", true);
  expect(canAccountPublishLineage(conn.db, "acc_regular")).toBe(true);
  const created = lineages.upsertForAgent("acc_regular", regularAgent.id, {name: "已授权传承"});
  expect(created.name).toBe("已授权传承");
});

afterEach(() => {
  conn.close();
  rmSync(home, {recursive: true, force: true});
});

test("physical isolation: master private memories never leak into disciple lineage recall or search", () => {
  const master = agents.create("acc_master", {name: "MasterAgent"}, "k-m1");
  const masterOwnerUserId = agents.ownerUserId(master.id);

  // Master writes a private memory about release passwords/habits.
  memories.add(
    {agentId: master.id, kind: "owner", trusted: true, owner: true, userId: masterOwnerUserId, shadowId: null},
    {type: "procedure", title: "私人发布秘籍", description: "仅师父个人使用的私密发布步骤", body: "私密内容不应泄露给徒弟"},
  );

  // Master enables lineage and publishes only a sanitized team memory.
  const lineage = lineages.upsertForAgent("acc_master", master.id, {
    name: "研发宗门传承",
    description: "研发团队通用规范",
    intakeGuidelines: "收录团队发布流程与排障经验，不含个人偏好",
    template: {
      personaTemplates: [{title: "研发原则", description: "严谨务实", body: "先验证再上线"}],
    },
  });
  const pub = lineages.publishMemory("acc_master", lineage.id, {
    type: "procedure",
    title: "团队标准发布流程",
    description: "灰度验证与回滚检查清单",
    body: "发布前先跑集成测试，灰度观察 15 分钟。",
  });

  // Invite preview must not expose memory contents.
  const {token} = lineages.createInvite("acc_master", master.id, {label: "新人入职"});
  const preview = lineages.previewInvite(token);
  expect(preview.lineage.name).toBe("研发宗门传承");
  expect(preview.lineage.memoryCount).toBe(1);

  // Disciple B accepts invite and creates a new Agent (seeding persona template).
  const accepted = lineages.acceptInvite("acc_disciple_b", token, {mode: "create_agent", agentName: "DiscipleB"});
  expect(accepted.subscription.status).toBe("active");

  // Persona template was seeded into Disciple B's default shadow.
  const bPersonas = memories.page(accepted.agentId, {type: "persona", status: "active"}).entries;
  expect(bPersonas.length).toBe(1);
  expect(bPersonas[0]!.title).toBe("研发原则");

  // Disciple B recalls published lineage memory, NEVER master's private memory.
  const recalled = lineages.recallDirect(accepted.agentId, "请问团队标准发布流程和私人发布秘籍怎么操作", {limit: 5});
  expect(recalled.map(r => r.memory.id)).toEqual([pub.id]);

  // Disciple B can read lineage memory via requireReadableMemory.
  const readable = lineages.requireReadableMemory(accepted.agentId, pub.id);
  expect(readable.memory.body).toContain("灰度观察 15 分钟");
});

test("single-hop default recall + explicit ancestor lookup (追寻祖脉) + allowAncestorLookup gate + cycle prevention", () => {
  const agentA = agents.create("acc_master", {name: "GrandmasterA"}, "k-a");
  const linA = lineages.upsertForAgent("acc_master", agentA.id, {name: "祖师传承A", allowAncestorLookup: true});
  const memA = lineages.publishMemory("acc_master", linA.id, {
    type: "procedure",
    title: "数据库死锁底层排查",
    description: "InnoDB 锁等待与死锁日志分析",
    body: "检查 SHOW ENGINE INNODB STATUS 输出。",
  });
  const invA = lineages.createInvite("acc_master", agentA.id);

  // B subscribes to A, and opens its own lineage B.
  const resB = lineages.acceptInvite("acc_disciple_b", invA.token, {mode: "create_agent", agentName: "MasterB"});
  const linB = lineages.upsertForAgent("acc_disciple_b", resB.agentId, {name: "师父传承B", allowAncestorLookup: true});
  const memB = lineages.publishMemory("acc_disciple_b", linB.id, {
    type: "procedure",
    title: "前端打包优化指南",
    description: "Bun 打包与产物分析步骤",
    body: "开启 minify 并检查 bundle 体积。",
  });
  const invB = lineages.createInvite("acc_disciple_b", resB.agentId);

  // C subscribes to B.
  const resC = lineages.acceptInvite("acc_disciple_c", invB.token, {mode: "create_agent", agentName: "DiscipleC"});

  // Default search (without includeAncestors) only sees B, NOT A.
  const defaultSearch = lineages.searchForAgent(resC.agentId, "数据库死锁底层排查", {includeAncestors: false});
  expect(defaultSearch.length).toBe(0);

  const directSearch = lineages.searchForAgent(resC.agentId, "前端打包优化", {includeAncestors: false});
  expect(directSearch.map(e => ({id: e.memory.id, depth: e.depth}))).toEqual([{id: memB.id, depth: 1}]);

  // Explicit ancestor lookup (追寻祖脉) finds A at depth 2.
  const ancestorSearch = lineages.searchForAgent(resC.agentId, "数据库死锁底层排查", {includeAncestors: true});
  expect(ancestorSearch.map(e => ({id: e.memory.id, depth: e.depth}))).toEqual([{id: memA.id, depth: 2}]);

  // If A disables allowAncestorLookup, C can no longer reach A.
  lineages.upsertForAgent("acc_master", agentA.id, {name: "祖师传承A", allowAncestorLookup: false});
  expect(lineages.searchForAgent(resC.agentId, "数据库死锁底层排查", {includeAncestors: true}).length).toBe(0);

  // Cycle prevention: A cannot attach to C's lineage (would form A -> C -> B -> A).
  lineages.upsertForAgent("acc_disciple_c", resC.agentId, {name: "传承C"});
  const invC = lineages.createInvite("acc_disciple_c", resC.agentId);
  expect(() => lineages.acceptInvite("acc_master", invC.token, {mode: "attach_agent", agentId: agentA.id}))
    .toThrow(/lineage_cycle_detected/);
});

test("local mute/override, two-stage contribution approval, revision conflict, and leave revocation", () => {
  const master = agents.create("acc_master", {name: "Master"}, "k-m2");
  const lin = lineages.upsertForAgent("acc_master", master.id, {name: "核心传承"});
  const mem1 = lineages.publishMemory("acc_master", lin.id, {
    type: "feedback",
    title: "代码评审规范",
    description: "PR 评审必须包含测试验证说明",
    body: "每个 PR 至少需要 1 名 reviewer 通过。",
  });
  const {token} = lineages.createInvite("acc_master", master.id);
  const disciple = lineages.acceptInvite("acc_disciple_b", token, {mode: "create_agent", agentName: "Disciple"});

  // Override to local private memory hides the original lineage entry from recall.
  const {localMemoryId} = lineages.overrideToLocal("acc_disciple_b", disciple.agentId, mem1.id, {body: "我本地更严格：需要 2 名 reviewer。"});
  expect(lineages.recallDirect(disciple.agentId, "代码评审规范 PR 评审", {limit: 5}).length).toBe(0);
  lineages.clearOverride("acc_disciple_b", disciple.agentId, mem1.id);
  expect(lineages.recallDirect(disciple.agentId, "代码评审规范 PR 评审", {limit: 5}).map(r => r.memory.id)).toEqual([mem1.id]);

  // Two-stage contribution (consolidation -> owner approve -> lineage approve).
  const contrib = lineages.createContribution({
    sourceAgentId: disciple.agentId,
    sourceOwnerAccountId: "acc_disciple_b",
    originKind: "consolidation",
    kind: "add",
    proposedType: "procedure",
    proposedTitle: "告警静默排查步骤",
    proposedDescription: "处理夜间误报告警的标准步骤",
    proposedBody: "先核对监控指标再配置临时静默。",
    rationale: "近期排障总结",
  });
  expect(contrib.status).toBe("pending_owner");

  // Stage 1: Owner edits and approves.
  const stage1 = lineages.ownerDecideContribution("acc_disciple_b", disciple.agentId, contrib.id, {
    action: "approve",
    proposedBody: "脱敏后：先核对监控指标与日志，再配置有时效的静默规则。",
  });
  expect(stage1.status).toBe("pending_lineage");

  // Stage 2: Master approves -> writes to lineage_memories.
  const stage2 = lineages.lineageDecideContribution("acc_master", lin.id, contrib.id, {
    action: "approve",
    reviewComment: "很实用，已合入",
  });
  expect(stage2.contribution.status).toBe("approved");
  expect(stage2.memory?.id).toStartWith("lmem_");

  // Both master and disciple can now search the newly approved lineage memory.
  expect(lineages.searchForAgent(master.id, "告警静默排查").map(r => r.memory.id)).toContain(stage2.memory!.id);
  expect(lineages.searchForAgent(disciple.agentId, "告警静默排查").map(r => r.memory.id)).toContain(stage2.memory!.id);

  // Update contribution detects revision conflict if master edited concurrently.
  const updateContrib = lineages.createContribution({
    sourceAgentId: disciple.agentId,
    sourceOwnerAccountId: "acc_disciple_b",
    originKind: "manual_dashboard",
    kind: "update",
    targetLineageMemoryId: mem1.id,
    proposedType: "feedback",
    proposedTitle: "代码评审规范",
    proposedDescription: "PR 评审必须包含测试验证与回滚说明",
    proposedBody: "补充回滚检查要求。",
  });
  lineages.updateMemory("acc_master", lin.id, mem1.id, {expectedRevision: 1, body: "师父并发修改了正文"});
  expect(() => lineages.lineageDecideContribution("acc_master", lin.id, updateContrib.id, {action: "approve"}))
    .toThrow(LineageConflictError);
  const forced = lineages.lineageDecideContribution("acc_master", lin.id, updateContrib.id, {action: "approve", forceOnConflict: true});
  expect(forced.memory?.revision).toBe(3);

  // Leaving immediately revokes access while preserving local overridden private memory.
  lineages.leaveSubscription("acc_disciple_b", disciple.agentId);
  expect(lineages.searchForAgent(disciple.agentId, "告警静默排查").length).toBe(0);
  expect(memories.get({agentId: disciple.agentId, all: true}, localMemoryId).body).toContain("2 名 reviewer");
});
