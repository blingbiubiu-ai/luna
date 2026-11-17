import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { shadowRootAccess, users } from "@/data/schema";
import { AuthorizationRuleStore } from "@/server/policy/authorization-rule-store";
import { ruleMatchesOperation } from "@/server/policy/operation-policy";
import { createLogger } from "@/shared";
import { AgentError, AgentStore } from "./agent-store";

const logger = createLogger("shadow-root-access");

/** Granted on the Users/Groups pages like any operation. */
export const ROOT_OPERATION = "agent.root";
export interface ShadowRootSettings { shadowId: string; enabled: boolean }
/**
 * Shadow root switch, and who is trusted with it (the `agent.root` grant).
 * With the switch on, every Job of the Shadow may use sudo. Whether to use it is the
 * Runner's judgement (prompts/runner-root-access.md): it checks requesters with
 * `luna root status --user` and acts on what trusted people want or agree to.
 */
export class ShadowRootAccessStore {
  constructor(private readonly db: DrizzleDB) {}

  settings(actorUserId: string, scope: { agentId: string; shadowId: string }): ShadowRootSettings {
    this.requireOwnedShadow(actorUserId, scope);
    return { shadowId: scope.shadowId, enabled: this.enabled(scope.shadowId) };
  }

  setEnabled(actorUserId: string, scope: { agentId: string; shadowId: string }, enabled: boolean): ShadowRootSettings {
    this.requireOwnedShadow(actorUserId, scope);
    const values = { shadowId: scope.shadowId, agentId: scope.agentId, enabled, updatedBy: actorUserId, updatedAt: Date.now() };
    this.db.insert(shadowRootAccess).values(values).onConflictDoUpdate({ target: shadowRootAccess.shadowId, set: values }).run();
    logger.info({ event: enabled ? "enabled" : "disabled", userId: actorUserId, ...scope }, "shadow_root_access");
    return this.settings(actorUserId, scope);
  }

  enabled(shadowId: string): boolean {
    return this.db.select({ enabled: shadowRootAccess.enabled }).from(shadowRootAccess).where(eq(shadowRootAccess.shadowId, shadowId)).get()?.enabled === true;
  }

  /**
   * The Agent owner, or a user granted `agent.root` (directly or through a group) on this
   * Agent's Users/Groups pages. Trust is per Agent; which Shadows use it is the switch.
   */
  trusted(scope: { agentId: string; shadowId: string }, userId: string | null | undefined): boolean {
    if (!userId) return false;
    if (new AgentStore(this.db).get(scope.agentId).ownerUserId === userId) return true;
    // An id that is not a user (a mistyped or foreign sender id) is not trusted.
    if (!this.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) return false;
    const grants = new AuthorizationRuleStore(this.db, { kind: "agent", agentId: scope.agentId }).getEffectiveGrantsForUser(userId);
    if (grants.some(grant => grant.effect === "deny" && ruleMatchesOperation(grant, ROOT_OPERATION))) return false;
    return grants.some(grant => grant.effect === "allow" && ruleMatchesOperation(grant, ROOT_OPERATION));
  }

  private requireOwnedShadow(actorUserId: string, scope: { agentId: string; shadowId: string }): void {
    new AgentStore(this.db).requireOwner(actorUserId, scope.agentId);
    const shadow = new AgentStore(this.db).shadow(scope.shadowId);
    if (shadow.agentId !== scope.agentId) throw new AgentError("scope_mismatch", 409);
  }
}
