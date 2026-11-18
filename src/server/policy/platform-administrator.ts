import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {accounts} from "@/data/schema";
import {resolveOperationPolicy} from "@/operations/operation-registry";
import {AuthorizationRuleStore} from "./authorization-rule-store";
import {evaluateOperationPolicy} from "./operation-policy";

/** Platform management requires an active account and a platform-scoped grant. */
export function isPlatformAdministrator(db:DrizzleDB,accountId:string):boolean {
 const account=db.select().from(accounts).where(eq(accounts.id,accountId)).get();
 if(account?.status!=="active")return false;
 const operation=resolveOperationPolicy(db,"system.admin");
 return Boolean(operation && evaluateOperationPolicy({operation,
  grants:new AuthorizationRuleStore(db,{kind:"platform"}).getEffectiveGrantsForUser(accountId),
 }).decision==="allow");
}
