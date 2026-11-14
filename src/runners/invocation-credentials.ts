import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { accessTokens } from "@/data/schema";
import { AccessTokenService } from "@/server/auth/access-token-service";
import { InvocationService } from "./invocation-service";

const TTL_MS = 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 60 * 60 * 1000;

/** Renew only a still-eligible invocation, preserving its scope and artifact allowlist. */
export function renewInvocationCredentials(db: DrizzleDB, id: string, env: Record<string, string>, signingSecret: string, now = Date.now()) {
  return db.transaction(() => {
    const authority = new InvocationService(db);
    const invocation = authority.requireEligible(id);
    const previous = invocation.tokenId ? db.select().from(accessTokens).where(eq(accessTokens.id, invocation.tokenId)).get() : undefined;
    if (!previous || previous.revokedAt !== null) throw new Error("Invocation credential was revoked or removed");
    if (previous.expiresAt > now + RENEW_BEFORE_MS) return { env, expiresAt: previous.expiresAt };
    const issued = new AccessTokenService({ db, signingSecret }).issueToken({
      userId: invocation.actorUserId, name: previous.name, source: "runner", role: "runner", now, ttlMs: TTL_MS,
      runnerKind: invocation.runnerKind, sourceRunnerJobId: invocation.runnerContextId,
      ...(invocation.sessionId ? { sourceSessionId: invocation.sessionId } : {}),
      ...(invocation.taskId ? { sourceTaskId: invocation.taskId } : {}),
      ...(invocation.taskRunId ? { sourceTaskRunId: invocation.taskRunId } : {}),
      metadata: { ...(previous.metadataJson ?? {}), invocationId: id },
    });
    authority.store.bindToken(id, issued.record.id);
    return { env: { ...env, LUNA_ACCESS_TOKEN: issued.token }, expiresAt: issued.record.expiresAt };
  });
}
