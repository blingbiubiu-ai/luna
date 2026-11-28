import {Hono, type Context} from "hono";
import {HTTPException} from "hono/http-exception";
import {inArray} from "drizzle-orm";
import {z} from "zod";
import type {DrizzleDB} from "@/data";
import {
  accounts,
  LINEAGE_CONTRIBUTION_KINDS,
  LINEAGE_CONTRIBUTION_STATUSES,
  LINEAGE_MAINTAINER_ROLES,
  LINEAGE_MEMORY_STATUSES,
  LINEAGE_MEMORY_TYPES,
  LINEAGE_STATUSES,
} from "@/data/schema";
import {AgentError, AgentStore} from "@/agents/agent-store";
import {AgentMemoryStore} from "@/agents/agent-memory-store";
import {LineageConflictError, LineageMemoryStore, type LineageMemoryRecord} from "@/agents/lineage-memory-store";
import {isGuardResponse, requireDashboardOnly} from "../auth/guards";

const personaTemplateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8192),
}).strict();

const templateSchema = z.object({
  defaultAgentNamePrefix: z.string().trim().max(60).optional(),
  personaTemplates: z.array(personaTemplateSchema).max(5).optional(),
  recommendedPlugins: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  recommendedSkills: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
}).strict();

const upsertLineageBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  intakeGuidelines: z.string().max(2000).optional(),
  allowAncestorLookup: z.boolean().optional(),
  allowMemberInvite: z.boolean().optional(),
  template: templateSchema.optional(),
  status: z.enum(LINEAGE_STATUSES).optional(),
}).strict();

const maintainerBody = z.object({
  accountId: z.string().trim().min(1).max(128),
  role: z.enum(LINEAGE_MAINTAINER_ROLES).default("reviewer"),
}).strict();

const createInviteBody = z.object({
  label: z.string().max(120).optional(),
  requireApproval: z.boolean().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
}).strict();

const lineageMemoryFields = {
  type: z.enum(LINEAGE_MEMORY_TYPES),
  title: z.string(),
  description: z.string(),
  body: z.string(),
};

const createLineageMemoryBody = z.object({...lineageMemoryFields, reason: z.string().max(200).optional()}).strict();
const publishFromLocalBody = z.object({
  localMemoryId: z.string().min(1).max(128),
  type: z.enum(LINEAGE_MEMORY_TYPES).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  reason: z.string().max(200).optional(),
}).strict();

const updateLineageMemoryBody = z.object(lineageMemoryFields).partial().extend({
  expectedRevision: z.number().int().positive(),
  reason: z.string().max(200).optional(),
}).strict();

const statusChangeBody = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().max(200).optional(),
}).strict();

const overrideBody = z.discriminatedUnion("mode", [
  z.object({mode: z.literal("muted")}).strict(),
  z.object({
    mode: z.literal("overridden"),
    title: z.string().optional(),
    description: z.string().optional(),
    body: z.string().optional(),
  }).strict(),
]);

const manualContributionBody = z.object({
  kind: z.enum(LINEAGE_CONTRIBUTION_KINDS),
  targetLineageMemoryId: z.string().min(1).max(128).nullable().optional(),
  sourceLocalMemoryId: z.string().min(1).max(128).nullable().optional(),
  proposedType: z.enum(LINEAGE_MEMORY_TYPES),
  proposedTitle: z.string(),
  proposedDescription: z.string(),
  proposedBody: z.string(),
  rationale: z.string().max(500).optional(),
}).strict();

const ownerDecisionBody = z.object({
  action: z.enum(["approve", "reject", "cancel"]),
  proposedType: z.enum(LINEAGE_MEMORY_TYPES).optional(),
  proposedTitle: z.string().optional(),
  proposedDescription: z.string().optional(),
  proposedBody: z.string().optional(),
  rationale: z.string().max(500).optional(),
}).strict();

const lineageDecisionBody = z.object({
  action: z.enum(["approve", "reject"]),
  type: z.enum(LINEAGE_MEMORY_TYPES).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  reviewComment: z.string().max(500).optional(),
  forceOnConflict: z.boolean().optional(),
}).strict();

const acceptInviteBody = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create_agent"),
    agentName: z.string().trim().min(1).max(100),
  }).strict(),
  z.object({
    mode: z.literal("attach_agent"),
    agentId: z.string().trim().min(1).max(128),
  }).strict(),
]);

function handleError(error: unknown, c: Context) {
  if (error instanceof LineageConflictError) {
    return c.json({status: "error", code: error.code, currentRevision: error.currentRevision}, 409);
  }
  if (error instanceof AgentError) {
    return c.json({status: "error", code: error.code}, error.status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return c.json({status: "error", code: "invalid_request"}, 400);
  }
  if (error instanceof HTTPException) return error.getResponse();
  throw error;
}

function requireAccount(c: Context): string {
  const auth = requireDashboardOnly(c);
  if (isGuardResponse(auth)) throw new HTTPException(auth.status as 401 | 403, {res: auth});
  return auth.account.id;
}

/** Mounted under /api/agents for lineage management, subscriptions, overrides, and contributions. */
export function createAgentLineageRoutes(db: DrizzleDB) {
  const store = new LineageMemoryStore(db);
  const agentStore = new AgentStore(db);

  const enrichMemories = (rows: readonly LineageMemoryRecord[]) => {
    const accountIds = [...new Set(rows.flatMap(r => [r.contributorAccountId, r.approvedByAccountId]).filter((id): id is string => Boolean(id)))];
    const names = new Map(accountIds.length
      ? db.select({id: accounts.id, name: accounts.displayName}).from(accounts).where(inArray(accounts.id, accountIds)).all().map(a => [a.id, a.name])
      : []);
    return rows.map(row => ({
      ...row,
      contributorAccountName: row.contributorAccountId ? names.get(row.contributorAccountId) ?? null : null,
      approvedByAccountName: names.get(row.approvedByAccountId) ?? null,
    }));
  };

  return new Hono()
    .onError(handleError)

    // ── Outbound Lineage Config & Management ─────────────────────────────────

    .get("/:agentId/lineage", c => {
      const accountId = requireAccount(c);
      const agentId = c.req.param("agentId");
      const lineage = store.getByAgent(agentId);
      if (!lineage) {
        agentStore.requireOwner(accountId, agentId);
        return c.json({lineage: null});
      }
      store.requireManager(accountId, lineage.id, "reviewer");
      const members = store.listMembers(lineage.id);
      const pendingContributions = store.listLineageContributions(lineage.id, "pending_lineage").length;
      const {total: activeMemories} = store.pageMemories(lineage.id, {status: "active", limit: 1, offset: 0});
      return c.json({
        lineage,
        stats: {
          activeMemories,
          activeMembers: members.filter(m => m.status === "active").length,
          pendingMembers: members.filter(m => m.status === "pending_approval").length,
          pendingContributions,
        },
      });
    })
    .put("/:agentId/lineage", async c => {
      const accountId = requireAccount(c);
      const input = upsertLineageBody.parse(await c.req.json());
      const lineage = store.upsertForAgent(accountId, c.req.param("agentId"), input);
      return c.json({lineage});
    })

    // ── Maintainers ──────────────────────────────────────────────────────────

    .get("/:agentId/lineage/maintainers", c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "reviewer");
      return c.json({maintainers: store.listMaintainers(lineage.id)});
    })
    .post("/:agentId/lineage/maintainers", async c => {
      const accountId = requireAccount(c);
      const input = maintainerBody.parse(await c.req.json());
      const maintainer = store.addMaintainer(accountId, c.req.param("agentId"), input.accountId, input.role);
      return c.json({maintainer}, 201);
    })
    .delete("/:agentId/lineage/maintainers/:targetAccountId", c => {
      const accountId = requireAccount(c);
      store.removeMaintainer(accountId, c.req.param("agentId"), c.req.param("targetAccountId"));
      return c.json({status: "ok"});
    })

    // ── Invites ──────────────────────────────────────────────────────────────

    .get("/:agentId/lineage/invites", c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "reviewer");
      return c.json({invites: store.listInvites(lineage.id)});
    })
    .post("/:agentId/lineage/invites", async c => {
      const accountId = requireAccount(c);
      const input = createInviteBody.parse(await c.req.json().catch(() => ({})));
      const {invite, token} = store.createInvite(accountId, c.req.param("agentId"), input);
      return c.json({invite, token}, 201);
    })
    .delete("/:agentId/lineage/invites/:inviteId", c => {
      const accountId = requireAccount(c);
      const invite = store.revokeInvite(accountId, c.req.param("agentId"), c.req.param("inviteId"));
      return c.json({invite});
    })

    // ── Members ──────────────────────────────────────────────────────────────

    .get("/:agentId/lineage/members", c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "reviewer");
      return c.json({members: store.listMembers(lineage.id)});
    })
    .post("/:agentId/lineage/members/:subscriptionId/approve", c => {
      const accountId = requireAccount(c);
      const subscription = store.approveMember(accountId, c.req.param("agentId"), c.req.param("subscriptionId"));
      return c.json({subscription});
    })
    .delete("/:agentId/lineage/members/:subscriptionId", c => {
      const accountId = requireAccount(c);
      const subscription = store.removeMember(accountId, c.req.param("agentId"), c.req.param("subscriptionId"));
      return c.json({subscription});
    })

    // ── Lineage Memories (Isolated Pool) ─────────────────────────────────────

    .get("/:agentId/lineage/memories", c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "reviewer");
      const query = z.object({
        status: z.enum(LINEAGE_MEMORY_STATUSES).optional(),
        type: z.enum(LINEAGE_MEMORY_TYPES).optional(),
        query: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(c.req.query());
      const {entries, total} = store.pageMemories(lineage.id, query);
      return c.json({memories: enrichMemories(entries), total});
    })
    .post("/:agentId/lineage/memories", async c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "admin");
      const input = createLineageMemoryBody.parse(await c.req.json());
      const memory = store.publishMemory(accountId, lineage.id, input);
      return c.json({memory: enrichMemories([memory])[0]}, 201);
    })
    .post("/:agentId/lineage/memories/publish-from-local", async c => {
      const accountId = requireAccount(c);
      const agentId = c.req.param("agentId");
      const lineage = store.requireByAgent(agentId);
      store.requireManager(accountId, lineage.id, "admin");
      const input = publishFromLocalBody.parse(await c.req.json());
      const local = new AgentMemoryStore(db).get({agentId, all: true}, input.localMemoryId);
      const resolvedType = input.type ?? (LINEAGE_MEMORY_TYPES.includes(local.type as never) ? (local.type as typeof LINEAGE_MEMORY_TYPES[number]) : undefined);
      if (!resolvedType) throw new AgentError("invalid_lineage_memory_type", 400);
      const memory = store.publishMemory(accountId, lineage.id, {
        type: resolvedType,
        title: input.title ?? local.title,
        description: input.description ?? local.description,
        body: input.body ?? local.body,
        originKind: "owner_publish",
        contributorAgentId: agentId,
        contributorAccountId: accountId,
        reason: input.reason ?? `从私有记忆 ${local.id} 提炼发布`,
      });
      return c.json({memory: enrichMemories([memory])[0]}, 201);
    })
    .put("/:agentId/lineage/memories/:memoryId", async c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "admin");
      const input = updateLineageMemoryBody.parse(await c.req.json());
      const memory = store.updateMemory(accountId, lineage.id, c.req.param("memoryId"), input);
      return c.json({memory: enrichMemories([memory])[0]});
    })
    .post("/:agentId/lineage/memories/:memoryId/archive", async c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "admin");
      const input = statusChangeBody.parse(await c.req.json());
      const memory = store.changeMemoryStatus(accountId, lineage.id, c.req.param("memoryId"), input.expectedRevision, "archived", input.reason);
      return c.json({memory: enrichMemories([memory])[0]});
    })
    .post("/:agentId/lineage/memories/:memoryId/restore", async c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "admin");
      const input = statusChangeBody.parse(await c.req.json());
      const memory = store.changeMemoryStatus(accountId, lineage.id, c.req.param("memoryId"), input.expectedRevision, "active", input.reason);
      return c.json({memory: enrichMemories([memory])[0]});
    })
    .delete("/:agentId/lineage/memories/:memoryId", c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "admin");
      const expectedRevision = z.coerce.number().int().positive().parse(c.req.query("expectedRevision"));
      const reason = z.string().max(200).optional().parse(c.req.query("reason"));
      const memory = store.changeMemoryStatus(accountId, lineage.id, c.req.param("memoryId"), expectedRevision, "deleted", reason);
      return c.json({memory: enrichMemories([memory])[0]});
    })
    .get("/:agentId/lineage/memories/:memoryId/history", c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "reviewer");
      return c.json({revisions: store.history(lineage.id, c.req.param("memoryId"))});
    })

    // ── Lineage Contributions Inbox (Stage 2 Approval) ───────────────────────

    .get("/:agentId/lineage/contributions", c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      store.requireManager(accountId, lineage.id, "reviewer");
      const status = z.enum(LINEAGE_CONTRIBUTION_STATUSES).optional().parse(c.req.query("status"));
      return c.json({contributions: store.listLineageContributions(lineage.id, status)});
    })
    .post("/:agentId/lineage/contributions/:contributionId/decide", async c => {
      const accountId = requireAccount(c);
      const lineage = store.requireByAgent(c.req.param("agentId"));
      const input = lineageDecisionBody.parse(await c.req.json());
      const result = store.lineageDecideContribution(accountId, lineage.id, c.req.param("contributionId"), input);
      return c.json(result);
    })

    // ── Subscriber (Disciple Agent) Routes ───────────────────────────────────

    .get("/:agentId/subscription", c => {
      const accountId = requireAccount(c);
      const agentId = c.req.param("agentId");
      agentStore.requireOwner(accountId, agentId);
      const current = store.getActiveSubscription(agentId);
      const chain = store.resolveLineageChain(agentId);
      return c.json({
        subscription: current?.subscription ?? null,
        lineage: current?.lineage ?? null,
        sourceAgentName: current?.sourceAgentName ?? null,
        ancestors: chain.ancestors.map(a => ({
          lineageId: a.lineage.id,
          name: a.lineage.name,
          sourceAgentName: a.sourceAgentName,
          depth: a.depth,
          allowAncestorLookup: a.lineage.allowAncestorLookup,
        })),
      });
    })
    .delete("/:agentId/subscription", c => {
      const accountId = requireAccount(c);
      const subscription = store.leaveSubscription(accountId, c.req.param("agentId"));
      return c.json({subscription});
    })
    .get("/:agentId/subscription/memories", c => {
      const accountId = requireAccount(c);
      const agentId = c.req.param("agentId");
      agentStore.requireOwner(accountId, agentId);
      const current = store.getActiveSubscription(agentId);
      if (!current || current.subscription.status !== "active") {
        return c.json({memories: [], total: 0, overrides: []});
      }
      const query = z.object({
        type: z.enum(LINEAGE_MEMORY_TYPES).optional(),
        query: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(c.req.query());
      const {entries, total} = store.pageMemories(current.lineage.id, {...query, status: "active"});
      const overrides = store.listOverrides(agentId);
      const overrideMap = new Map(overrides.map(o => [o.lineageMemoryId, o]));
      return c.json({
        memories: enrichMemories(entries).map(m => ({...m, override: overrideMap.get(m.id) ?? null})),
        total,
      });
    })
    .put("/:agentId/subscription/overrides/:lineageMemoryId", async c => {
      const accountId = requireAccount(c);
      const agentId = c.req.param("agentId");
      const lineageMemoryId = c.req.param("lineageMemoryId");
      const input = overrideBody.parse(await c.req.json());
      if (input.mode === "muted") {
        return c.json({override: store.setMute(accountId, agentId, lineageMemoryId)});
      }
      return c.json(store.overrideToLocal(accountId, agentId, lineageMemoryId, {
        ...(input.title !== undefined ? {title: input.title} : {}),
        ...(input.description !== undefined ? {description: input.description} : {}),
        ...(input.body !== undefined ? {body: input.body} : {}),
      }));
    })
    .delete("/:agentId/subscription/overrides/:lineageMemoryId", c => {
      const accountId = requireAccount(c);
      store.clearOverride(accountId, c.req.param("agentId"), c.req.param("lineageMemoryId"));
      return c.json({status: "ok"});
    })

    // ── Disciple Contributions (Stage 1 Owner Review & Manual Submit) ────────

    .get("/:agentId/contributions", c => {
      const accountId = requireAccount(c);
      const agentId = c.req.param("agentId");
      agentStore.requireOwner(accountId, agentId);
      const status = z.enum(LINEAGE_CONTRIBUTION_STATUSES).optional().parse(c.req.query("status"));
      return c.json({contributions: store.listAgentContributions(agentId, status)});
    })
    .post("/:agentId/contributions", async c => {
      const accountId = requireAccount(c);
      const agentId = c.req.param("agentId");
      agentStore.requireOwner(accountId, agentId);
      const input = manualContributionBody.parse(await c.req.json());
      const contribution = store.createContribution({
        sourceAgentId: agentId,
        sourceOwnerAccountId: accountId,
        sourceLocalMemoryId: input.sourceLocalMemoryId ?? null,
        originKind: "manual_dashboard",
        kind: input.kind,
        targetLineageMemoryId: input.targetLineageMemoryId ?? null,
        proposedType: input.proposedType,
        proposedTitle: input.proposedTitle,
        proposedDescription: input.proposedDescription,
        proposedBody: input.proposedBody,
        rationale: input.rationale ?? "",
      });
      return c.json({contribution}, 201);
    })
    .post("/:agentId/contributions/:contributionId/decide", async c => {
      const accountId = requireAccount(c);
      const input = ownerDecisionBody.parse(await c.req.json());
      const contribution = store.ownerDecideContribution(accountId, c.req.param("agentId"), c.req.param("contributionId"), input);
      return c.json({contribution});
    });
}

/** Mounted under /api/lineages for invite link preview and acceptance. */
export function createLineageInvitePublicRoutes(db: DrizzleDB) {
  const store = new LineageMemoryStore(db);
  return new Hono()
    .onError(handleError)
    .get("/invites/:token", c => {
      return c.json({invite: store.previewInvite(c.req.param("token"))});
    })
    .post("/invites/:token/accept", async c => {
      const accountId = requireAccount(c);
      const input = acceptInviteBody.parse(await c.req.json());
      const result = store.acceptInvite(
        accountId,
        c.req.param("token"),
        input.mode === "create_agent"
          ? {mode: "create_agent", agentName: input.agentName, idempotencyKey: c.req.header("Idempotency-Key") ?? undefined}
          : {mode: "attach_agent", agentId: input.agentId},
      );
      return c.json(result, 201);
    });
}
