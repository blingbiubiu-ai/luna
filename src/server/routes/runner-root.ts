import { Hono } from "hono";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { ShadowRootAccessStore } from "@/agents/shadow-root-access-store";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { getKernel } from "./kernel";

/**
 * `luna root status --user <id>`: whether a person is trusted with root on the calling
 * Runner's Shadow. The Shadow comes from the runner token, never from the request,
 * and the trusted list itself is not exposed.
 */
export function createRunnerRootRoutes(options: { db?: DrizzleDB } = {}) {
  const db = () => options.db ?? getKernel().database.db;
  return new Hono<{ Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims | undefined } }>()
    .get("/root/status", c => {
      const claims = c.get("lunaAccessTokenClaims");
      if (claims?.source !== "runner" || claims.role !== "runner" || !claims.agentId || !claims.shadowId) {
        return c.json({ error: "runner_token_required" }, 403);
      }
      const user = z.string().min(1).max(128).optional().safeParse(c.req.query("user"));
      if (!user.success) return c.json({ error: "invalid_request" }, 400);
      const store = new ShadowRootAccessStore(db());
      const scope = { agentId: claims.agentId, shadowId: claims.shadowId };
      return c.json({
        rootAccess: store.enabled(scope.shadowId),
        ...(user.data ? { user: user.data, trusted: store.trusted(scope, user.data) } : {}),
      });
    });
}
