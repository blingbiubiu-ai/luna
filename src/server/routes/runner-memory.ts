import {Hono} from "hono";
import {inArray} from "drizzle-orm";
import {z} from "zod";
import type {DrizzleDB} from "@/data";
import {MEMORY_TYPES, users} from "@/data/schema";
import {AgentError} from "@/agents/agent-store";
import {memoryAccess} from "@/agents/agent-memory-access";
import {memoryOriginOfTrigger} from "@/agents/agent-memory-maintenance";
import {AgentMemoryStore, MemoryConflictError, MemoryDuplicateError, memorySummary, type MemoryRecord} from "@/agents/agent-memory-store";
import {InvocationService} from "@/runners/invocation-service";
import type {LunaAccessTokenClaims} from "../auth/access-token-service";
import {GatewayError} from "../gateway-error";
import {getKernel} from "./kernel";

const type = z.enum(MEMORY_TYPES);
const fields = {
  type, title: z.string(), description: z.string(), body: z.string(),
  subjectUserId: z.string().min(1).max(128).nullable().optional(),
  visibility: z.enum(["agent", "shadow"]).optional(),
  core: z.boolean().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
};
const addBody = z.object({...fields, force: z.boolean().optional()}).strict();
const updateBody = z.object(fields).partial().extend({expectedRevision: z.number().int().positive()}).strict();
const revision = z.coerce.number().int().positive();

/** Agent memory for the active invocation. Scope and write authority come from the Runner token only. */
export function createRunnerMemoryRoutes(options: {db?: DrizzleDB} = {}) {
  const db = () => options.db ?? getKernel().database.db;
  const access = (claims: LunaAccessTokenClaims | undefined) => {
    if (claims?.source !== "runner" || !claims.runnerKind) throw new GatewayError("runner_required", "A Runner token is required", 403);
    const {invocation, snapshot} = new InvocationService(db()).requireActive(claims, claims.runnerKind);
    const trigger = snapshot.kind === "main" && snapshot.input.input.type === "session_trigger" ? snapshot.input.input.triggerId : undefined;
    return memoryAccess(db(), invocation, trigger ? memoryOriginOfTrigger(db(), trigger) : "inline");
  };
  /** Summaries name who said it and when, so the reader can weigh the source. */
  const summaries = (rows: readonly MemoryRecord[]) => {
    const ids = [...new Set(rows.flatMap(row => row.originUserId ? [row.originUserId] : []))];
    const names = new Map(ids.length ? db().select({id: users.id, name: users.displayName}).from(users).where(inArray(users.id, ids)).all().map(user => [user.id, user.name]) : []);
    return rows.map(row => ({...memorySummary(row), originUserName: row.originUserId ? names.get(row.originUserId) ?? null : null}));
  };
  const detail = (row: MemoryRecord) => ({...summaries([row])[0]!, body: row.body});
  return new Hono<{Variables: {lunaAccessTokenClaims: LunaAccessTokenClaims | undefined}}>()
    .onError((error, c) => {
      if (error instanceof MemoryConflictError) return c.json({error: error.code, currentRevision: error.currentRevision}, 409);
      if (error instanceof MemoryDuplicateError) return c.json({error: error.code, candidates: summaries(error.candidates),
        message: "An existing entry already says this. Update a candidate with `luna memory update`, or repeat with --force if this is a different fact."}, 409);
      if (error instanceof AgentError) return c.json({error: error.code}, error.status);
      if (error instanceof GatewayError) return c.json({error: error.code, message: error.message}, error.status as 400);
      if (error instanceof z.ZodError) return c.json({error: "invalid_request", details: error.issues}, 400);
      throw error;
    })
    .get("/memory", c => {
      const query = z.object({type: type.optional(), limit: z.coerce.number().int().min(1).max(200).default(150)}).parse(c.req.query());
      const {entries, omitted} = new AgentMemoryStore(db()).index(access(c.get("lunaAccessTokenClaims")).viewer, query);
      return c.json({memories: summaries(entries), omitted});
    })
    .get("/memory/search", c => {
      const query = z.object({q: z.string().max(200), type: type.optional(), subject: z.string().optional(), archived: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(10)}).parse(c.req.query());
      const rows = new AgentMemoryStore(db()).search(access(c.get("lunaAccessTokenClaims")).viewer, query.q,
        {limit: query.limit, archived: query.archived === "true", ...(query.type ? {type: query.type} : {}), ...(query.subject ? {subjectUserId: query.subject} : {})});
      return c.json({memories: summaries(rows)});
    })
    .get("/memory/:id", c => c.json({memory: detail(new AgentMemoryStore(db()).use(access(c.get("lunaAccessTokenClaims")).viewer, c.req.param("id")))}))
    .post("/memory", async c => {
      const {viewer, writer} = access(c.get("lunaAccessTokenClaims"));
      const author = writer();
      const {force, ...input} = addBody.parse(await c.req.json().catch(() => null));
      return c.json({memory: detail(new AgentMemoryStore(db()).add(author, input, {duplicatesFor: viewer, force}))}, 201);
    })
    .put("/memory/:id", async c => {
      const {viewer, writer} = access(c.get("lunaAccessTokenClaims"));
      const author = writer();
      const input = updateBody.parse(await c.req.json().catch(() => null));
      return c.json({memory: detail(new AgentMemoryStore(db()).update(author, viewer, c.req.param("id"), input))});
    })
    .post("/memory/:id/restore", async c => {
      const {viewer, writer} = access(c.get("lunaAccessTokenClaims"));
      const author = writer();
      const input = z.object({expectedRevision: z.number().int().positive()}).strict().parse(await c.req.json().catch(() => null));
      return c.json({memory: detail(new AgentMemoryStore(db()).restore(author, viewer, c.req.param("id"), input.expectedRevision))});
    })
    .delete("/memory/:id", c => {
      const {viewer, writer} = access(c.get("lunaAccessTokenClaims"));
      const author = writer();
      const query = z.object({expectedRevision: revision, supersededBy: z.string().min(1).optional()}).parse(c.req.query());
      const row = new AgentMemoryStore(db()).remove(author, viewer, c.req.param("id"), query.expectedRevision, query.supersededBy);
      return c.json({memory: {id: row.id, status: row.status, revision: row.revision}});
    });
}
