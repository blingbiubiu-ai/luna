import { asc } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { DrizzleDB } from "@/data";
import { accounts } from "@/data/schema";
import { deleteAccount } from "@/dashboard-api/deletion";
import { isGuardResponse, requireAdmin } from "../auth/guards";
import { isPlatformAdministrator } from "../policy/platform-administrator";

/** Platform accounts: listed and deleted by platform administrators only. */
export function createAccountRoutes(db: DrizzleDB) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    })
    .use("*", async (c, next) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      await next();
    })
    .get("/", c => c.json({
      accounts: db.select().from(accounts).orderBy(asc(accounts.createdAt), asc(accounts.id)).all()
        .map(account => ({ ...account, isPlatformAdmin: isPlatformAdministrator(db, account.id) })),
    }))
    .delete("/:id", c => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      deleteAccount(db, c.req.param("id"), admin.account.id);
      return c.json({ status: "ok" });
    });
}
