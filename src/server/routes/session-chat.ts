import { SessionAccessPolicy } from "@/agents/session-access";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { SessionStore } from "@/sessions/session-store";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { sessionInbox, sessionTimelineEntries } from "@/data/schema";
import type { DashboardChannel } from "@/channels/dashboard/dashboard-channel";
import { ensureDashboardUser } from "../auth";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";

const inputSchema = z.object({ text: z.string().trim().min(1).max(20000) }).strict();

/** Dashboard HTTP transport delegates to the registered channel's normal inbound handler. */
export function createSessionChatRoutes(options: { db?: DrizzleDB; channel?: DashboardChannel } = {}) {
  return new Hono().onError((error,c)=>{if(error instanceof AgentError)return c.json({code:error.code},error.status);throw error;}).post("/dashboard", async c => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) return auth;
    const db = options.db ?? getKernel().database.db;
    ensureDashboardUser(db,auth.user,{bindDashboardIdentity:true});
    const parsed=z.object({agentId:z.string().min(1),shadowId:z.string().min(1).optional()}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({code:"invalid_scope"},400);
    const agents = new AgentStore(db);
    const agent = agents.requireOwner(auth.user.id, parsed.data.agentId);
    const session = new SessionStore(db).createLocalSession(auth.user.id,{agentId:agent.id,shadowId:parsed.data.shadowId??agent.defaultShadowId});
    return c.json({sessionId:session.id},201);
  }).post("/:id/messages", async (c) => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) return auth;
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => null));
    const key = c.req.header("Idempotency-Key");
    if (!parsed.success || !key || !/^[\w.-]{1,128}$/.test(key)) return c.json({ message: "Valid text and Idempotency-Key are required" }, 400);
    const db = options.db ?? getKernel().database.db;
    try {
      ensureDashboardUser(db, auth.user, { bindDashboardIdentity: true });
      const session = new SessionAccessPolicy(db).requireAccess(auth.user.id, c.req.param("id"));
      new AgentStore(db).requireOwner(auth.user.id, session.agent_id);
      const result = await (options.channel ?? getKernel().dashboardChannel()).submit(c.req.param("id"), auth.user, parsed.data.text, key);
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof GatewayError) return c.json({ message: error.message }, error.status as 400);
      throw error;
    }
  }).get("/:id/messages/:messageId/status", (c) => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) return auth;
    const db = options.db ?? getKernel().database.db;
    const session = new SessionAccessPolicy(db).requireAccess(auth.user.id, c.req.param("id"), {readHistory:true});
    new AgentStore(db).requireOwner(auth.user.id, session.agent_id, {includeDeleted:true});
    const entry = db.select().from(sessionTimelineEntries).where(and(eq(sessionTimelineEntries.sessionId, c.req.param("id")), eq(sessionTimelineEntries.messageId, c.req.param("messageId")))).get();
    if (!entry) return c.json({ message: "Message not found" }, 404);
    const inbox = db.select().from(sessionInbox).where(eq(sessionInbox.entry_id, entry.id)).get();
    return c.json({ status: inbox?.status ?? "completed", error: inbox?.error ?? null });
  });
}
