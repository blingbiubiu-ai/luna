import { HTTPException } from "hono/http-exception";
import { scheduleManagementRoutes } from "./schedule-management";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { sessionCommands } from "@/data/schema";
import { sessionCommandsFor } from "@/messaging/session-command-service";
import { requireAdminMiddleware } from "../auth/guards";
import { GatewayError } from "../gateway-error";
import { AgentError } from "@/agents/agent-store";
import { getKernel } from "./kernel";
export function createSessionCommandAdminRoutes(options: {
    db?: DrizzleDB;
} = {}) {
    const db = () => options.db ?? getKernel().database.db;
    const service = () => sessionCommandsFor(db(), id => getKernel().replyChannel(id));
    return new Hono()
        .onError((error, c) => error instanceof HTTPException ? error.getResponse() : error instanceof GatewayError ? c.json({ error: error.code, message: error.message }, error.status as 400) : error instanceof AgentError ? c.json({ error: error.code }, error.status) : c.json({ error: "invalid_request", message: String(error) }, 400))
        .route("/", scheduleManagementRoutes(db, service))
        .use("/commands", requireAdminMiddleware())
        .use("/commands/*", requireAdminMiddleware())
        .get("/commands", c => c.json(db().select().from(sessionCommands).all()))
        .get("/commands/:id", c => { const row = service().get(c.req.param("id")); return row ? c.json(row) : c.json({ error: "not_found" }, 404); })
        .post("/commands/:id/cancel", c => { service().cancel(c.req.param("id")); return c.json({ ok: true }); })
        .post("/commands/:id/retry", async (c) => {
        const body = z.object({ acknowledgeDuplicateRisk: z.literal(true) }).strict().parse(await c.req.json());
        void body;
        const row = service().get(c.req.param("id"));
        if (!row || !["unknown", "failed"].includes(row.status))
            return c.json({ error: "not_retryable" }, 409);
        db().update(sessionCommands).set({ status: "pending", error: null, availableAt: Date.now(), updatedAt: Date.now() }).where(and(eq(sessionCommands.id, row.id), eq(sessionCommands.status, row.status))).run();
        return c.json({ ok: true });
    });
}
