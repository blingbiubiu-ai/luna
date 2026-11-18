import { Hono } from "hono";
import { z } from "zod";

import type { DrizzleDB } from "@/data";
import { AgentError } from "@/agents/agent-store";
import { AccountLinkService } from "@/identity/account-link";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";

const tokenBody = z.object({ token: z.string().trim().min(1).max(200) }).strict();

/** Mounted under /api/agents. The owner links chat identities to their account in one Agent. */
export function createAccountLinkRoutes(db: DrizzleDB) {
  const links = new AccountLinkService(db);
  const owner = (c: Parameters<typeof requireDashboardOnly>[0]) => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) throw new AgentError("dashboard_session_required", 403);
    return auth.account.id;
  };
  return new Hono()
    .onError((error, c) => {
      if (error instanceof AgentError) return c.json({ status: "error", code: error.code }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ status: "error", code: "invalid_request" }, 400);
      throw error;
    })
    .get("/:agentId/account-links", c => c.json({ links: links.list(owner(c), c.req.param("agentId")) }))
    .post("/:agentId/account-links/preview", async c => {
      const { token } = tokenBody.parse(await c.req.json());
      return c.json({ link: links.preview(owner(c), c.req.param("agentId"), token) });
    })
    .post("/:agentId/account-links", async c => {
      const { token } = tokenBody.parse(await c.req.json());
      return c.json({ link: links.link(owner(c), c.req.param("agentId"), token) }, 201);
    })
    .delete("/:agentId/account-links/:channelIdentityId", c => {
      links.unlink(owner(c), c.req.param("agentId"), c.req.param("channelIdentityId"));
      return c.json({ status: "ok" });
    });
}
