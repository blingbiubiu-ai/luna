import {Hono, type Context} from "hono";
import {HTTPException} from "hono/http-exception";
import {inArray} from "drizzle-orm";
import {z} from "zod";
import type {DrizzleDB} from "@/data";
import {agentShadows, MEMORY_ORIGIN_KINDS, MEMORY_STATUSES, MEMORY_TYPES, users} from "@/data/schema";
import {config} from "@/shared";
import {AgentError, AgentStore} from "@/agents/agent-store";
import {AgentMemoryStore, MemoryConflictError, type MemoryRecord, type MemoryViewer, type MemoryWriter} from "@/agents/agent-memory-store";
import {isGuardResponse, requireDashboardOnly} from "../auth/guards";

const fields = {
  type: z.enum(MEMORY_TYPES), title: z.string(), description: z.string(), body: z.string(),
  subjectUserId: z.string().min(1).max(128).nullable().optional(),
  core: z.boolean().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
};
const listQuery = z.object({
  status: z.enum(MEMORY_STATUSES).optional(), type: z.enum(MEMORY_TYPES).optional(), originKind: z.enum(MEMORY_ORIGIN_KINDS).optional(),
  originShadowId: z.string().min(1).optional(), core: z.enum(["true", "false"]).optional(), trusted: z.enum(["true", "false"]).optional(), query: z.string().max(200).optional(),
  sort: z.enum(["updatedAt", "createdAt"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
});
/** `shadowId` names the Shadow a new persona entry belongs to. */
const addBody = z.object({...fields, shadowId: z.string().min(1).max(128).optional()}).strict();
const revision = z.number().int().positive();
const updateBody = z.object(fields).partial().extend({expectedRevision: revision}).strict();
const revertBody = z.object({revision, expectedRevision: revision}).strict();

/** Mounted under /api/agents. The Agent owner reviews, corrects and restores every memory entry. */
export function createAgentMemoryRoutes(db: DrizzleDB) {
  const store = new AgentMemoryStore(db);
  /** Owner edits are trusted and are not tied to a Shadow or session. */
  const owner = (c: Context): {viewer: MemoryViewer; writer: MemoryWriter} => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) throw new HTTPException(auth.status as 401 | 403, {res: auth});
    const agentId = c.req.param("agentId")!;
    const agents = new AgentStore(db);
    agents.requireOwner(auth.user.id, agentId);
    agents.requireAccess(auth.user.id, agentId);
    return {viewer: {agentId, all: true}, writer: {agentId, kind: "owner", trusted: true, owner: true, userId: auth.user.id, shadowId: null}};
  };
  /** Adds the names the audit view shows instead of raw ids. */
  const named = (rows: readonly MemoryRecord[]) => {
    const userIds = [...new Set(rows.flatMap(row => [row.originUserId, row.subjectUserId]).filter((id): id is string => id !== null))];
    const shadowIds = [...new Set(rows.flatMap(row => row.originShadowId ? [row.originShadowId] : []))];
    const userNames = new Map(userIds.length ? db.select({id: users.id, name: users.displayName}).from(users).where(inArray(users.id, userIds)).all().map(row => [row.id, row.name]) : []);
    const shadowNames = new Map(shadowIds.length ? db.select({id: agentShadows.id, name: agentShadows.name}).from(agentShadows).where(inArray(agentShadows.id, shadowIds)).all().map(row => [row.id, row.name]) : []);
    return rows.map(row => ({
      ...row,
      originUserName: row.originUserId ? userNames.get(row.originUserId) ?? null : null,
      subjectUserName: row.subjectUserId ? userNames.get(row.subjectUserId) ?? null : null,
      originShadowName: row.originShadowId ? shadowNames.get(row.originShadowId) ?? null : null,
    }));
  };
  return new Hono().use("/:agentId/memories", async (c, next) => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth; await next();
  }).use("/:agentId/memories/*", async (c, next) => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth; await next();
  }).onError((error, c) => {
    if (error instanceof MemoryConflictError) return c.json({status: "error", code: error.code, currentRevision: error.currentRevision}, 409);
    if (error instanceof AgentError) return c.json({status: "error", code: error.code}, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({status: "error", code: "invalid_request"}, 400);
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  })
    .get("/:agentId/memories", c => {
      const {viewer} = owner(c);
      const {core, trusted, ...filters} = listQuery.parse(c.req.query());
      const flag = (value: string | undefined) => value === undefined ? undefined : value === "true";
      const {entries, total} = store.page(viewer.agentId, {...filters, core: flag(core), trusted: flag(trusted)});
      return c.json({memories: named(entries), total,
        core: {used: store.coreUsed(viewer.agentId, null), limit: config.memory.core_limit, shadowLimit: config.memory.shadow_core_limit}});
    })
    .post("/:agentId/memories/:id/restore", async c => {
      const {viewer, writer} = owner(c);
      const input = z.object({expectedRevision: revision}).strict().parse(await c.req.json());
      return c.json({memory: named([store.restore(writer, viewer, c.req.param("id"), input.expectedRevision)])[0]});
    })
    .post("/:agentId/memories/:id/confirm", async c => {
      const {viewer, writer} = owner(c);
      const input = z.object({expectedRevision: revision}).strict().parse(await c.req.json());
      return c.json({memory: named([store.confirm(writer, viewer, c.req.param("id"), input.expectedRevision)])[0]});
    })
    .get("/:agentId/memories/:id/history", c => { const {viewer} = owner(c); return c.json({revisions: store.history(viewer.agentId, c.req.param("id"))}); })
    .post("/:agentId/memories", async c => {
      const {writer} = owner(c);
      const {shadowId, ...input} = addBody.parse(await c.req.json());
      if (input.type !== "persona") return c.json({memory: named([store.add(writer, input)])[0]}, 201);
      const shadow = shadowId ? new AgentStore(db).shadow(shadowId) : undefined;
      if (!shadow || shadow.agentId !== writer.agentId || shadow.status === "deleted") throw new AgentError("invalid_memory_persona", 400);
      return c.json({memory: named([store.add({...writer, shadowId: shadow.id}, input)])[0]}, 201);
    })
    .put("/:agentId/memories/:id", async c => {
      const {viewer, writer} = owner(c);
      return c.json({memory: named([store.update(writer, viewer, c.req.param("id"), updateBody.parse(await c.req.json()))])[0]});
    })
    .delete("/:agentId/memories/:id", c => {
      const {viewer, writer} = owner(c);
      const expectedRevision = z.coerce.number().int().positive().parse(c.req.query("expectedRevision"));
      return c.json({memory: named([store.remove(writer, viewer, c.req.param("id"), expectedRevision)])[0]});
    })
    .post("/:agentId/memories/:id/revert", async c => {
      const {writer} = owner(c);
      const input = revertBody.parse(await c.req.json());
      return c.json({memory: named([store.revert(writer, c.req.param("id"), input.revision, input.expectedRevision)])[0]});
    });
}
