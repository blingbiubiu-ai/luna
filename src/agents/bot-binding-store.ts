import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { channelConfigs, shadowBotBindings } from "@/data/schema";
import { AgentError, AgentStore } from "./agent-store";

export type BotBinding = typeof shadowBotBindings.$inferSelect;

/** Resolves stable bot-to-Shadow ownership; rebinding requires explicit retirement. */
export class BotBindingStore {
  constructor(private readonly db: DrizzleDB) {}

  activeForChannel(channelConfigId: string): BotBinding | undefined {
    return this.db.select().from(shadowBotBindings).where(and(
      eq(shadowBotBindings.channelConfigId, channelConfigId), eq(shadowBotBindings.status, "active"))).get();
  }

  requireActive(channelConfigId: string): BotBinding {
    const binding = this.activeForChannel(channelConfigId);
    if (!binding) throw new AgentError("bot_binding_required", 409);
    const store = new AgentStore(this.db);
    const agent = store.get(binding.agentId), shadow = store.shadow(binding.shadowId);
    if (agent.status !== "active" || shadow.status !== "active") throw new AgentError("shadow_disabled", 409);
    return binding;
  }

  bind(accountId: string, shadowId: string, channelConfigId: string): BotBinding {
    return this.db.transaction(tx => {
      const db = tx as unknown as DrizzleDB;
      const agents = new AgentStore(db), store = new BotBindingStore(db);
      const shadow = agents.shadow(shadowId), agent = agents.requireOwner(accountId, shadow.agentId);
      agents.requireScope(agents.ownerUserId(agent.id), {agentId: agent.id, shadowId});
      if (agent.defaultShadowId === shadowId) throw new AgentError("default_shadow_dashboard_only", 409);
      const channel = db.select().from(channelConfigs).where(eq(channelConfigs.id, channelConfigId)).get();
      if (!channel || channel.agentId !== agent.id) throw new AgentError("channel_scope_mismatch", 409);
      const prior = store.activeForChannel(channelConfigId);
      if (prior) {
        if (prior.shadowId !== shadowId) throw new AgentError("bot_already_bound", 409);
        return prior;
      }
      const occupied = db.select().from(shadowBotBindings).where(and(
        eq(shadowBotBindings.shadowId, shadowId), eq(shadowBotBindings.status, "active"))).get();
      if (occupied) throw new AgentError("shadow_already_bound", 409);
      const previous = db.select().from(shadowBotBindings).where(eq(shadowBotBindings.channelConfigId, channelConfigId))
        .orderBy(desc(shadowBotBindings.revision)).get();
      const binding: BotBinding = {id: randomUUID(), agentId: agent.id, shadowId, channelConfigId,
        revision: (previous?.revision ?? 0) + 1, status: "active", createdAt: Date.now(), retiredAt: null};
      db.insert(shadowBotBindings).values(binding).run();
      return binding;
    });
  }

  retire(accountId: string, bindingId: string): BotBinding {
    return this.db.transaction(tx => {
      const binding = tx.select().from(shadowBotBindings).where(eq(shadowBotBindings.id, bindingId)).get();
      if (!binding) throw new AgentError("bot_binding_not_found", 404);
      new AgentStore(tx as unknown as DrizzleDB).requireOwner(accountId, binding.agentId);
      if (binding.status === "retired") return binding;
      const retired = {...binding, status: "retired" as const, retiredAt: Date.now()};
      tx.update(shadowBotBindings).set({status: retired.status, retiredAt: retired.retiredAt})
        .where(eq(shadowBotBindings.id, binding.id)).run();
      return retired;
    });
  }
}
