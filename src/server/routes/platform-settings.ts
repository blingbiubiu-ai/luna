import { Hono } from "hono";
import { ZodError } from "zod";

import type { DrizzleDB } from "@/data";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import type { OrphanCleanupStore } from "@/runtime/orphan-cleanup";
import { FeishuAuthConfigError, FeishuAuthConfigStore } from "../auth/feishu-oauth";
import { isGuardResponse, requireAdmin, requireDashboardOnly } from "../auth/guards";
import { isPlatformAdministrator } from "../policy/platform-administrator";
import { getKernel } from "./kernel";

/** Platform settings: every signed-in account reads them, platform administrators change them. */
export function createPlatformSettingsRoutes(
  db: DrizzleDB,
  store: () => OrphanCleanupStore | undefined = runtimeSettings,
  feishuAuth: FeishuAuthConfigStore = new FeishuAuthConfigStore({ db }),
  platformStore: PlatformSettingsStore = new PlatformSettingsStore(db),
) {
  return new Hono()
    .get("/", (c) => {
      const auth = requireDashboardOnly(c);
      if (isGuardResponse(auth)) return auth;
      const settings = store();
      if (!settings) return c.json({ status: "error", code: "runtime_unavailable" }, 503);
      return c.json({
        platform: platformStore.get(),
        orphanCleanup: settings.get(),
        feishuAuth: feishuAuth.getPublicSettings(),
        canEdit: isPlatformAdministrator(db, auth.account.id),
      });
    })
    .put("/", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      try {
        const platform = platformStore.patch(await c.req.json(), admin.account.id);
        return c.json({
          platform,
          feishuAuth: feishuAuth.getPublicSettings(),
        });
      } catch (error) {
        if (error instanceof ZodError) {
          const message = error.issues[0]?.message ?? "平台设置格式无效。";
          return c.json({ status: "error", code: "invalid_settings", message }, 400);
        }
        if (error instanceof SyntaxError) {
          return c.json({ status: "error", code: "invalid_settings", message: "请求格式无效。" }, 400);
        }
        throw error;
      }
    })
    .put("/orphan-cleanup", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      const settings = store();
      if (!settings) return c.json({ status: "error", code: "runtime_unavailable" }, 503);
      try {
        return c.json({ orphanCleanup: settings.set(await c.req.json()) });
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) {
          return c.json({ status: "error", code: "invalid_settings" }, 400);
        }
        throw error;
      }
    })
    .put("/feishu-auth", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      try {
        const saved = await feishuAuth.save(await c.req.json(), admin.account.id);
        return c.json({ feishuAuth: saved });
      } catch (error) {
        if (error instanceof FeishuAuthConfigError) {
          return c.json({ status: "error", code: error.code, message: error.message }, error.status);
        }
        if (error instanceof ZodError || error instanceof SyntaxError) {
          return c.json({ status: "error", code: "invalid_settings", message: "请求格式无效。" }, 400);
        }
        throw error;
      }
    })
    .delete("/feishu-auth", (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      return c.json({ feishuAuth: feishuAuth.clear() });
    });
}

/** The running Service's settings; absent until its runtime has started. */
function runtimeSettings(): OrphanCleanupStore | undefined {
  try {
    return getKernel().executionRuntime?.orphanCleanup();
  } catch {
    return undefined;
  }
}
