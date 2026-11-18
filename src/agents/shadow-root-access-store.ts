import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { shadowRootAccess, users } from "@/data/schema";
import { decodeInvocation } from "@/runners/invocation-codec";
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
 * With the switch on, the container is configured for sudo, while OS-level `privileged`
 * execution is granted only to invocations whose actor or turn sender is trusted.
 */
export class ShadowRootAccessStore {
  constructor(private readonly db: DrizzleDB) {}

  settings(accountId: string, scope: { agentId: string; shadowId: string }): ShadowRootSettings {
    this.requireOwnedShadow(accountId, scope);
    return { shadowId: scope.shadowId, enabled: this.enabled(scope.shadowId) };
  }

  setEnabled(accountId: string, scope: { agentId: string; shadowId: string }, enabled: boolean): ShadowRootSettings {
    this.requireOwnedShadow(accountId, scope);
    const values = { shadowId: scope.shadowId, agentId: scope.agentId, enabled, updatedByAccountId: accountId, updatedAt: Date.now() };
    this.db.insert(shadowRootAccess).values(values).onConflictDoUpdate({ target: shadowRootAccess.shadowId, set: values }).run();
    logger.info({ event: enabled ? "enabled" : "disabled", accountId, ...scope }, "shadow_root_access");
    return this.settings(accountId, scope);
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
    // An id that is not a user of this Agent (a mistyped or foreign sender id) is not trusted.
    if (!this.db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.agentId, scope.agentId))).get()) return false;
    if (new AgentStore(this.db).isOwnerUser(scope.agentId, userId)) return true;
    const grants = new AuthorizationRuleStore(this.db, { kind: "agent", agentId: scope.agentId }).getEffectiveGrantsForUser(userId);
    if (grants.some(grant => grant.effect === "deny" && ruleMatchesOperation(grant, ROOT_OPERATION))) return false;
    return grants.some(grant => grant.effect === "allow" && ruleMatchesOperation(grant, ROOT_OPERATION));
  }

  /**
   * Container `rootAccess` follows the Shadow switch so containers are not recreated per turn;
   * process-level `privileged` requires at least one trusted requester in this invocation.
   */
  invocationPrivileged(invocation: { agentId: string; shadowId: string; actorUserId: string; inputSnapshot?: unknown }): { rootAccess: boolean; privileged: boolean } {
    if (!this.enabled(invocation.shadowId)) return { rootAccess: false, privileged: false };
    const scope = { agentId: invocation.agentId, shadowId: invocation.shadowId };
    const candidates = new Set<string>([invocation.actorUserId]);
    if (invocation.inputSnapshot !== undefined) {
      try {
        const parsed = decodeInvocation(invocation.inputSnapshot);
        if (parsed.kind === "main") {
          const command = parsed.input.input;
          if (command.type === "user_messages") {
            for (const msg of command.messages) if (msg.role === "user" && msg.senderUserId) candidates.add(msg.senderUserId);
          } else if (command.type === "session_trigger" && command.requesterUserId) {
            candidates.add(command.requesterUserId);
          }
        }
      } catch { /* Validated at registration; fall back to actorUserId if malformed. */ }
    }
    const privileged = [...candidates].some(userId => this.trusted(scope, userId));
    return { rootAccess: true, privileged };
  }

  private requireOwnedShadow(accountId: string, scope: { agentId: string; shadowId: string }): void {
    new AgentStore(this.db).requireOwner(accountId, scope.agentId);
    const shadow = new AgentStore(this.db).shadow(scope.shadowId);
    if (shadow.agentId !== scope.agentId) throw new AgentError("scope_mismatch", 409);
  }
}
