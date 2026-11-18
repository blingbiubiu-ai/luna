import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { AgentError, AgentStore } from "@/agents/agent-store";
import type { DrizzleDB } from "@/data";
import { channelConfigs } from "@/data/schema";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import { isPlatformAdministrator } from "../policy/platform-administrator";
import { getKernel } from "./kernel";

const startTime = Date.now();

/**
 * Read-only runtime observability. Channel connection status belongs to the Agent that owns
 * the channel: `?agentId=` returns that Agent's channels to its owner; without it only a
 * platform administrator sees every channel. Test injection stays in the test harness.
 */
export const runtimeRoutes = new Hono()
  .onError((error, c) => error instanceof AgentError ? c.json({ status: "error", code: error.code }, error.status) : Promise.reject(error))
  .get("/status", (c) => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) return auth;
    // The authentication middleware supplies the policy database for this request.
    const db = (c.get("lunaAuthorizationDb" as never) as DrizzleDB | undefined) ?? getKernel().database.db;
    const agentId = c.req.query("agentId")?.trim();
    const all = getKernel().channelStatuses();
    let channels: typeof all = [];
    if (agentId) {
      new AgentStore(db).requireOwner(auth.account.id, agentId);
      const own = new Set(db.select({ id: channelConfigs.id }).from(channelConfigs).where(eq(channelConfigs.agentId, agentId)).all().map(row => row.id));
      channels = all.filter(channel => own.has(channel.id));
    } else if (isPlatformAdministrator(db, auth.account.id)) {
      channels = all;
    }
    return c.json({ status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000), channels });
  });
