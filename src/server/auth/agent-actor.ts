import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import type { DrizzleDB } from "@/data";
import { AgentError, AgentStore, type AgentRecord } from "@/agents/agent-store";
import { isGuardResponse, requireAuthenticated, requireDashboardOnly, type AuthenticatedContext } from "./guards";

/** Who acts inside one Agent for this request. */
export interface AgentActor {
  readonly agent: AgentRecord;
  /** The user of this Agent the request acts as. */
  readonly userId: string;
  /** The signed-in account; absent for a runner token. */
  readonly accountId?: string;
  readonly runner: boolean;
}

/** The account of a Dashboard cookie or a personal token, or a runner token. */
export function requireRequester(c: Context): AuthenticatedContext {
  const auth = requireAuthenticated(c);
  if (isGuardResponse(auth)) throw new HTTPException(auth.status as 401 | 403, { res: auth });
  return auth;
}

/** A signed-in account through the Dashboard cookie. */
export function requireDashboardAccount(c: Context): string {
  const auth = requireDashboardOnly(c);
  if (isGuardResponse(auth)) throw new HTTPException(auth.status as 401 | 403, { res: auth });
  return auth.account.id;
}

/**
 * Resolves the request to a user of `agentId`, once, at the HTTP boundary. A
 * runner token acts as its own user and must belong to that Agent. An account
 * must own the Agent and acts as its owner user there.
 */
export function agentActor(c: Context, db: DrizzleDB, agentId: string, options: { includeDeleted?: boolean } = {}): AgentActor {
  return actorFor(requireRequester(c), db, agentId, options);
}

export function actorFor(auth: AuthenticatedContext, db: DrizzleDB, agentId: string, options: { includeDeleted?: boolean } = {}): AgentActor {
  const agents = new AgentStore(db);
  if (auth.authKind === "luna-access-token" && auth.token.source === "runner") {
    if (auth.token.agentId !== agentId || !auth.token.actorUserId) throw new AgentError("scope_mismatch", 403);
    return { agent: agents.get(agentId), userId: auth.token.actorUserId, runner: true };
  }
  if (!auth.account) throw new AgentError("authentication_required", 403);
  const agent = agents.requireOwner(auth.account.id, agentId, options);
  return { agent, userId: agents.ownerUserId(agentId), accountId: auth.account.id, runner: false };
}
