import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { agentWorkerAccess, shadowWorkerRouting } from "@/data/schema";
import { AgentError, AgentStore, type AgentScope } from "./agent-store";
import { AgentWorkerAccessStore } from "./agent-worker-access-store";

export type WorkerRouting = { mode: "automatic"; workerId: null } | { mode: "bound"; workerId: string };

/** Service policy for new contexts; existing Runtime routes retain their snapshot. */
export class ShadowWorkerRoutingStore {
  constructor(private readonly db: DrizzleDB) {}

  get(scope: AgentScope): WorkerRouting {
    const row = this.db.select().from(shadowWorkerRouting).where(and(
      eq(shadowWorkerRouting.agentId, scope.agentId), eq(shadowWorkerRouting.shadowId, scope.shadowId),
    )).get();
    return row?.mode === "bound" ? { mode: "bound", workerId: row.workerId! } : { mode: "automatic", workerId: null };
  }

  read(actor: string, scope: AgentScope): WorkerRouting {
    this.authorize(actor, scope);
    const routing=this.get(scope);
    if(routing.mode==="bound")new AgentWorkerAccessStore(this.db).requireWorkerAccess(actor,routing.workerId);
    return routing;
  }

  save(actor: string, scope: AgentScope, routing: WorkerRouting): WorkerRouting {
    return this.db.transaction(() => {
      this.authorize(actor, scope);
      const agents = new AgentStore(this.db);
      agents.requireAccess(agents.ownerUserId(scope.agentId), scope.agentId);
      if (routing.mode === "bound") {
        new AgentWorkerAccessStore(this.db).requireWorkerAccess(actor,routing.workerId);
        const assigned = this.db.select().from(agentWorkerAccess).where(and(
          eq(agentWorkerAccess.agentId, scope.agentId), eq(agentWorkerAccess.workerId, routing.workerId),
          eq(agentWorkerAccess.status, "active"),
        )).get();
        if (!assigned) throw new AgentError("worker_assignment_not_found", 409);
      }
      const values = { ...scope, ...routing, updatedByAccountId: actor, updatedAt: Date.now() };
      this.db.insert(shadowWorkerRouting).values(values).onConflictDoUpdate({
        target: shadowWorkerRouting.shadowId, set: values,
      }).run();
      return this.get(scope);
    });
  }

  private authorize(actor: string, scope: AgentScope): void {
    const agents = new AgentStore(this.db);
    agents.requireOwner(actor, scope.agentId);
    const shadow = agents.shadow(scope.shadowId);
    if (shadow.agentId !== scope.agentId) throw new AgentError("scope_mismatch", 409);
    if (shadow.status === "deleted") throw new AgentError("shadow_deleted", 409);
  }
}
