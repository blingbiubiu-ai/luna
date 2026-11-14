import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {users} from "@/data/schema";
import {resolveOperationPolicy} from "@/operations/operation-registry";
import {AuthorizationRuleStore} from "./authorization-rule-store";
import {evaluateOperationPolicy} from "./operation-policy";

/** Platform management requires an active human and a platform-scoped grant. */
export function isPlatformAdministrator(db:DrizzleDB,userId:string):boolean {
 const user=db.select().from(users).where(eq(users.id,userId)).get();
 if(user?.kind!=="human" || user.status!=="active")return false;
 const operation=resolveOperationPolicy(db,"system.admin");
 return Boolean(operation && evaluateOperationPolicy({operation,
  grants:new AuthorizationRuleStore(db,{kind:"platform"}).getEffectiveGrantsForUser(userId),
 }).decision==="allow");
}
