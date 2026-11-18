import {and,asc,eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {agentWorkerAccess} from "@/data/schema";
import {AgentError,AgentStore} from "./agent-store";

/** Stores the Worker assignments for each Agent. */
export class AgentWorkerAccessStore {
 constructor(private readonly db:DrizzleDB){}
 list(accountId:string,agentId:string){
  new AgentStore(this.db).requireOwner(accountId,agentId);
  return this.db.select().from(agentWorkerAccess).where(eq(agentWorkerAccess.agentId,agentId)).orderBy(asc(agentWorkerAccess.workerId)).all();
 }
 /** Only call with the Worker owner verified by the Runtime or the pairing code. */
 setOwned(ownerAccountId: string, agentId: string, workerId: string, status: "active" | "disabled"): void {
  this.db.transaction(() => {
   const agent = new AgentStore(this.db).requireOwner(ownerAccountId, agentId);
   if (status === "active" && agent.status !== "active") throw new AgentError("agent_disabled", 409);
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
  const result = this.db.update(agentWorkerAccess).set({paused, updatedByAccountId: accountId, updatedAt: Date.now()})
   .where(and(eq(agentWorkerAccess.agentId, agentId), eq(agentWorkerAccess.workerId, workerId), eq(agentWorkerAccess.status, "active")))
   .returning({workerId: agentWorkerAccess.workerId}).get();
  if (!result) throw new AgentError("worker_assignment_not_found", 404);
 }
 /** Internal admission lookup; no default grant to local/global Workers. */
 allowed(agentId: string, options?: {includePaused?: boolean}): string[] {
  if(new AgentStore(this.db).get(agentId).status!=="active")throw new AgentError("agent_disabled",409);
  return this.db.select({id:agentWorkerAccess.workerId}).from(agentWorkerAccess)
   .where(and(eq(agentWorkerAccess.agentId,agentId),eq(agentWorkerAccess.status,"active"),
    options?.includePaused ? undefined : eq(agentWorkerAccess.paused, false)))
   .orderBy(asc(agentWorkerAccess.workerId)).all().map(row=>row.id);
 }
}
