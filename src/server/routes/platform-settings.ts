import { Hono } from "hono";
import { ZodError } from "zod";

import type { DrizzleDB } from "@/data";
import { isGuardResponse, requireAdmin, requireDashboardOnly } from "../auth/guards";
import { isPlatformAdministrator } from "../policy/platform-administrator";
import { getKernel } from "./kernel";
import type { OrphanCleanupStore } from "@/runtime/orphan-cleanup";

/** Platform settings: every signed-in account reads them, platform administrators change them. */
export function createPlatformSettingsRoutes(db: DrizzleDB, store: () => OrphanCleanupStore | undefined = runtimeSettings) {
  return new Hono()
    .get("/", c => {
      const auth = requireDashboardOnly(c);
      if (isGuardResponse(auth)) return auth;
      const settings = store();
      if (!settings) return c.json({ status: "error", code: "runtime_unavailable" }, 503);
      return c.json({ orphanCleanup: settings.get(), canEdit: isPlatformAdministrator(db, auth.account.id) });
    })
    .put("/orphan-cleanup", async c => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      const settings = store();
      if (!settings) return c.json({ status: "error", code: "runtime_unavailable" }, 503);
      try { return c.json({ orphanCleanup: settings.set(await c.req.json()) }); }
      catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ status: "error", code: "invalid_settings" }, 400);
        throw error;
      }
    });
}

/** The running Service's settings; absent until its runtime has started. */
function runtimeSettings(): OrphanCleanupStore | undefined {
  try { return getKernel().executionRuntime?.orphanCleanup(); } catch { return undefined; }
}
