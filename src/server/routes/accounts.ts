import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { DrizzleDB } from "@/data";
import { accessTokens, accounts, authorizationRules, lunaAgents } from "@/data/schema";
import { deleteAccount } from "@/dashboard-api/deletion";
import { isSuperAdminAccountId } from "@/identity/account-store";
import { isGuardResponse, requireAdmin } from "../auth/guards";
import { AuthorizationRuleStore } from "../policy/authorization-rule-store";
import { isPlatformAdministrator, isSuperAdministrator } from "../policy/platform-administrator";

const adminBodySchema = z.object({
  isPlatformAdmin: z.boolean(),
}).strict();

const statusBodySchema = z.object({
  status: z.enum(["active", "disabled"]),
}).strict();

/** Platform accounts and administrator grants: managed by platform administrators and the built-in super administrator. */
export function createAccountRoutes(db: DrizzleDB) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof HTTPException) {
        return c.json(
          { status: "error", message: error.message || "请求失败。" },
          error.status,
        );
      }
      throw error;
    })
    .use("*", async (c, next) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      await next();
    })
    .get("/", (c) => {
      const counts = agentCountsByOwner(db);
      const rows = db
        .select()
        .from(accounts)
        .where(ne(accounts.status, "deleted"))
        .orderBy(asc(accounts.createdAt), asc(accounts.id))
        .all()
        .map((account) => serializeAccount(db, account, counts.get(account.id) ?? 0))
        .sort((a, b) => Number(b.isSuperAdmin) - Number(a.isSuperAdmin));
      return c.json({ accounts: rows });
    })
    .put("/:id/admin", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      const targetId = c.req.param("id");
      const parsed = adminBodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ status: "error", code: "invalid_request", message: "请求参数无效。" }, 400);
      }
      if (isSuperAdminAccountId(targetId)) {
        return c.json({ status: "error", code: "super_admin_immutable", message: "内置超级管理员权限不可修改。" }, 409);
      }
      if (!parsed.data.isPlatformAdmin && targetId === admin.account.id) {
        return c.json({ status: "error", code: "cannot_revoke_self", message: "不能撤销当前登录账号的管理员权限。" }, 409);
      }
      const target = db.select().from(accounts).where(eq(accounts.id, targetId)).get();
      if (!target || target.status === "deleted") {
        return c.json({ status: "error", code: "account_not_found", message: "账号不存在。" }, 404);
      }
      if (parsed.data.isPlatformAdmin && target.status !== "active") {
        return c.json({ status: "error", code: "account_inactive", message: "请先启用该账号，再授予管理员权限。" }, 409);
      }
      db.transaction((tx) => {
        const txDb = tx as unknown as DrizzleDB;
        txDb
          .delete(authorizationRules)
          .where(
            and(
              eq(authorizationRules.scopeType, "platform"),
              eq(authorizationRules.subjectType, "user"),
              eq(authorizationRules.subjectId, targetId),
              eq(authorizationRules.target, "system.admin"),
            ),
          )
          .run();
        if (parsed.data.isPlatformAdmin) {
          new AuthorizationRuleStore(txDb, { kind: "platform" }).addGrant({
            subjectType: "user",
            subjectId: targetId,
            target: "system.admin",
            effect: "allow",
          });
        }
      });
      return c.json({ account: serializeAccount(db, target, agentCountForOwner(db, targetId)) });
    })
    .put("/:id/status", async (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      const targetId = c.req.param("id");
      const parsed = statusBodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ status: "error", code: "invalid_request", message: "请求参数无效。" }, 400);
      }
      if (isSuperAdminAccountId(targetId)) {
        return c.json({ status: "error", code: "super_admin_immutable", message: "内置超级管理员账号不可停用。" }, 409);
      }
      if (parsed.data.status === "disabled" && targetId === admin.account.id) {
        return c.json({ status: "error", code: "cannot_disable_self", message: "不能停用当前登录账号。" }, 409);
      }
      const target = db.select().from(accounts).where(eq(accounts.id, targetId)).get();
      if (!target || target.status === "deleted") {
        return c.json({ status: "error", code: "account_not_found", message: "账号不存在。" }, 404);
      }
      const now = Date.now();
      db.transaction((tx) => {
        tx.update(accounts)
          .set({ status: parsed.data.status, updatedAt: now })
          .where(eq(accounts.id, targetId))
          .run();
        if (parsed.data.status === "disabled") {
          tx.update(accessTokens)
            .set({ revokedAt: now })
            .where(and(eq(accessTokens.accountId, targetId), isNull(accessTokens.revokedAt)))
            .run();
        }
      });
      const updated = db.select().from(accounts).where(eq(accounts.id, targetId)).get()!;
      return c.json({ account: serializeAccount(db, updated, agentCountForOwner(db, targetId)) });
    })
    .delete("/:id", (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      deleteAccount(db, c.req.param("id"), admin.account.id);
      return c.json({ status: "ok" });
    });
}

function serializeAccount(
  db: DrizzleDB,
  account: typeof accounts.$inferSelect,
  agentCount: number,
) {
  return {
    ...account,
    isSuperAdmin: isSuperAdministrator(db, account.id),
    isPlatformAdmin: isPlatformAdministrator(db, account.id),
    agentCount,
  };
}

function agentCountsByOwner(db: DrizzleDB): Map<string, number> {
  const rows = db
    .select({
      ownerAccountId: lunaAgents.ownerAccountId,
      count: sql<number>`count(*)`,
    })
    .from(lunaAgents)
    .where(ne(lunaAgents.status, "deleted"))
    .groupBy(lunaAgents.ownerAccountId)
    .all();
  return new Map(rows.map((row) => [row.ownerAccountId, Number(row.count)]));
}

function agentCountForOwner(db: DrizzleDB, ownerAccountId: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(lunaAgents)
    .where(and(eq(lunaAgents.ownerAccountId, ownerAccountId), ne(lunaAgents.status, "deleted")))
    .get();
  return Number(row?.count ?? 0);
}
