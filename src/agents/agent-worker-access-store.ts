import {and,asc,eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {agentWorkerAccess} from "@/data/schema";
import {AgentError,AgentStore} from "./agent-store";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {readPrivateJson} from "@luna/execution-store";
import {RuntimeConfig} from "@/runtime/config";
import {config} from "@/shared/config";
import {isPlatformAdministrator} from "@/server/policy/platform-administrator";

/** Runtime topology is deployment-owned; a client cannot mark its Worker as local. */
function configuredHomeWorkerId(): string | undefined {
 const file=config.sandbox.runtimeConfigFile ?? join(config.paths.home,"runtime","runtime.json");
 return existsSync(file) ? RuntimeConfig.parse(readPrivateJson(file)).homeWorkerId : undefined;
}

/** Stores the Worker assignments for each Agent. */
export class AgentWorkerAccessStore {
 private readonly configuredHomeWorkerId=configuredHomeWorkerId();
 constructor(private readonly db:DrizzleDB,private readonly homeWorkerId?:string|(()=>string|undefined)){}
 canUse(accountId:string,workerId:string):boolean {
  const localId=(typeof this.homeWorkerId==="function" ? this.homeWorkerId() : this.homeWorkerId) ?? this.configuredHomeWorkerId;
  return workerId!==localId || isPlatformAdministrator(this.db,accountId);
 }
 requireWorkerAccess(accountId:string,workerId:string):void {
  if(!this.canUse(accountId,workerId))throw new AgentError("local_worker_admin_required",403);
 }
 list(accountId:string,agentId:string){
  new AgentStore(this.db).requireOwner(accountId,agentId);
  return this.db.select().from(agentWorkerAccess).where(eq(agentWorkerAccess.agentId,agentId)).orderBy(asc(agentWorkerAccess.workerId)).all()
   .filter(row=>this.canUse(accountId,row.workerId));
 }
 /** Only call with the Worker owner verified by the Runtime or the pairing code. */
 setOwned(ownerAccountId: string, agentId: string, workerId: string, status: "active" | "disabled"): void {
  this.db.transaction(() => {
   const agent = new AgentStore(this.db).requireOwner(ownerAccountId, agentId);
   if (status === "active" && agent.status !== "active") throw new AgentError("agent_disabled", 409);
   this.requireWorkerAccess(ownerAccountId,workerId);
   this.save(ownerAccountId, agentId, workerId, status);
  });
 }
 private save(accountId: string, agentId: string, workerId: string, status: "active" | "disabled"): void {
  const values = { agentId, workerId, status, updatedByAccountId: accountId, updatedAt: Date.now() };
  this.db.insert(agentWorkerAccess).values(values)
   .onConflictDoUpdate({
    target: [agentWorkerAccess.agentId, agentWorkerAccess.workerId],
    set: status === "disabled" ? {...values, paused: false} : values,
   }).run();
 }
 setPaused(accountId: string, agentId: string, workerId: string, paused: boolean): void {
  new AgentStore(this.db).requireOwner(accountId, agentId);
  this.requireWorkerAccess(accountId,workerId);
  const result = this.db.update(agentWorkerAccess).set({paused, updatedByAccountId: accountId, updatedAt: Date.now()})
   .where(and(eq(agentWorkerAccess.agentId, agentId), eq(agentWorkerAccess.workerId, workerId), eq(agentWorkerAccess.status, "active")))
   .returning({workerId: agentWorkerAccess.workerId}).get();
  if (!result) throw new AgentError("worker_assignment_not_found", 404);
 }
 /** Internal admission lookup; no default grant to local/global Workers. */
 allowed(agentId: string, options?: {includePaused?: boolean}): string[] {
  const agent=new AgentStore(this.db).get(agentId);
  if(agent.status!=="active")throw new AgentError("agent_disabled",409);
  return this.db.select({id:agentWorkerAccess.workerId}).from(agentWorkerAccess)
   .where(and(eq(agentWorkerAccess.agentId,agentId),eq(agentWorkerAccess.status,"active"),
    options?.includePaused ? undefined : eq(agentWorkerAccess.paused, false)))
   .orderBy(asc(agentWorkerAccess.workerId)).all().map(row=>row.id).filter(id=>this.canUse(agent.ownerAccountId,id));
 }
}
