import {and, asc, eq} from "drizzle-orm";
import type {RunnerSoul} from "@luna/host-runtime/runner-instructions";
import type {DrizzleDB} from "@/data";
import {agentMemories, agentShadows, lunaAgents, users} from "@/data/schema";
import {ownerUserId} from "@/identity/account-store";

/**
 * Who a Shadow is, for the top of its Runner instructions: names from the Agent and Shadow
 * records, the owner, and the Shadow's persona entries in the order they were written. Persona
 * entries are owner-only and Shadow-private, so every active one belongs here.
 */
export function shadowSoul(db: DrizzleDB, scope: {agentId: string; shadowId: string}): RunnerSoul | undefined {
  const shadow = db.select({name: agentShadows.name}).from(agentShadows)
    .where(and(eq(agentShadows.id, scope.shadowId), eq(agentShadows.agentId, scope.agentId))).get();
  const agent = db.select({name: lunaAgents.name}).from(lunaAgents).where(eq(lunaAgents.id, scope.agentId)).get();
  if (!shadow || !agent) return undefined;
  const ownerId = ownerUserId(db, scope.agentId);
  const owner = db.select({name: users.displayName}).from(users).where(eq(users.id, ownerId)).get();
  const persona = db.select({body: agentMemories.body}).from(agentMemories).where(and(
    eq(agentMemories.agentId, scope.agentId), eq(agentMemories.originShadowId, scope.shadowId),
    eq(agentMemories.type, "persona"), eq(agentMemories.status, "active"),
  )).orderBy(asc(agentMemories.createdAt), asc(agentMemories.id)).all();
  return {name: shadow.name, agent: agent.name, owner: {id: ownerId, name: owner?.name ?? ownerId}, persona: persona.map(row => row.body)};
}
