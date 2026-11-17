import { Hono } from "hono";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { AgentError } from "@/agents/agent-store";
import { ShadowRootAccessStore } from "@/agents/shadow-root-access-store";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";


/** Mounted under /api/agents. Only the Agent owner turns a Shadow's root switch on or off; trust is the `agent.root` grant. */
export function createShadowRootAccessRoutes(db: DrizzleDB) {
  const store = new ShadowRootAccessStore(db);
  type Ctx = Parameters<typeof requireDashboardOnly>[0];
  /** Dashboard session only; guard responses are returned as-is. */
  const asOwner = async (c: Ctx, action: (userId: string) => unknown | Promise<unknown>) => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) return auth;
    return c.json(await action(auth.user.id));
  };
  const scope = (c: { req: { param(name: string): string } }) => ({ agentId: c.req.param("agentId"), shadowId: c.req.param("shadowId") });
  return new Hono().onError((error, c) => {
    if (error instanceof AgentError) return c.json({ status: "error", code: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ status: "error", code: "invalid_request" }, 400);
    throw error;
  })
    .get("/:agentId/shadows/:shadowId/root", c => asOwner(c, userId => store.settings(userId, scope(c))))
    .put("/:agentId/shadows/:shadowId/root", c => asOwner(c, async userId => {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await c.req.json());
      return store.setEnabled(userId, scope(c), enabled);
    }));
}
