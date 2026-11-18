import { AgentStore } from "@/agents/agent-store";
import { ShadowRootAccessStore } from "@/agents/shadow-root-access-store";
import type { DrizzleDB } from "@/data";
import type { PeopleResolver, PersonFacts } from "./turn-envelope";

/**
 * Whether each sender is the Agent owner and, while the Shadow's root switch is on, whether they
 * may authorize root actions (the same answer `luna root status --user` gives).
 */
export function shadowPeople(db: DrizzleDB, scope: { readonly agentId: string; readonly shadowId: string }): PeopleResolver {
  const agents = new AgentStore(db), root = new ShadowRootAccessStore(db);
  const rootOn = root.enabled(scope.shadowId);
  const known = new Map<string, PersonFacts>();
  return (userId) => {
    let facts = known.get(userId);
    if (!facts) {
      facts = { role: agents.isOwnerUser(scope.agentId, userId) ? "owner" : "member", ...(rootOn ? { trusted: root.trusted(scope, userId) } : {}) };
      known.set(userId, facts);
    }
    return facts;
  };
}
