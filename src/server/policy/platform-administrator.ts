import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { accounts } from "@/data/schema";
import { isSuperAdminAccountId } from "@/identity/account-store";
import { resolveOperationPolicy } from "@/operations/operation-registry";
import { AuthorizationRuleStore } from "./authorization-rule-store";
import { evaluateOperationPolicy } from "./operation-policy";

/** Built-in access-token operator account holds unrevokable super-administrator authority. */
export function isSuperAdministrator(db: DrizzleDB, accountId: string): boolean {
  if (!isSuperAdminAccountId(accountId)) return false;
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  return account === undefined || account.status === "active";
}

/** Platform management requires either the built-in super administrator or an active account with `system.admin`. */
export function isPlatformAdministrator(db: DrizzleDB, accountId: string): boolean {
  if (isSuperAdministrator(db, accountId)) return true;
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (account?.status !== "active") return false;
  const operation = resolveOperationPolicy(db, "system.admin");
  return Boolean(
    operation &&
      evaluateOperationPolicy({
        operation,
        grants: new AuthorizationRuleStore(db, { kind: "platform" }).getEffectiveGrantsForUser(accountId),
      }).decision === "allow",
  );
}
