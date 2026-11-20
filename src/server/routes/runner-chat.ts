import {Hono} from "hono";
import {eq} from "drizzle-orm";
import {z} from "zod";
import type {DrizzleDB} from "@/data";
import {sessions} from "@/data/schema";
import {AgentStore} from "@/agents/agent-store";
import {InvocationService} from "@/runners/invocation-service";
import {ChatListeningStore} from "@/sessions/chat-listening-store";
import type {LunaAccessTokenClaims} from "../auth/access-token-service";
import {GatewayError} from "../gateway-error";
import {AuthorizationRuleStore} from "../policy/authorization-rule-store";
import {ruleMatchesOperation} from "../policy/operation-policy";
import {getKernel} from "./kernel";

/**
 * Listening for the group chat of the active invocation. The chat comes from the invocation's session, never
 * from the request. Switching decides whether everyone's unaddressed messages in the chat reach the model, so
 * it is done only in a turn where the Agent owner, or a member allowed `chat.listen`, addressed the Agent.
 */
export function createRunnerChatRoutes(options: {db?: DrizzleDB} = {}) {
  const db = () => options.db ?? getKernel().database.db;
  const scope = (claims: LunaAccessTokenClaims | undefined) => {
    if (claims?.source !== "runner" || !claims.runnerKind) throw new GatewayError("runner_required", "A Runner token is required", 403);
    const {invocation, snapshot} = new InvocationService(db()).requireActive(claims, claims.runnerKind);
    const input = snapshot.kind === "main" ? snapshot.input.input as {type: string; ambient?: boolean; latestMessage?: {surface?: {kind?: string}}} : undefined;
    const session = invocation.sessionId ? db().select().from(sessions).where(eq(sessions.id, invocation.sessionId)).get() : undefined;
    if (!session?.group_id || session.kind !== "main" || input?.type !== "user_messages" || input.latestMessage?.surface?.kind !== "group")
      throw new GatewayError("chat_listening_unavailable", "Listening is switched from a conversation in the group chat it is about, in a turn where someone there addressed you. This turn is not one.", 409);
    return {invocation, session, ambient: input.ambient === true};
  };
  return new Hono<{Variables: {lunaAccessTokenClaims: LunaAccessTokenClaims | undefined}}>()
    .onError((error, c) => {
      if (error instanceof GatewayError) return c.json({error: error.code, message: error.message}, error.status as 400);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({error: "invalid_request"}, 400);
      throw error;
    })
    .get("/chat/listening", c => {
      const {session} = scope(c.get("lunaAccessTokenClaims"));
      return c.json({listening: new ChatListeningStore(db()).enabled(session)});
    })
    .put("/chat/listening", async c => {
      const {invocation, session, ambient} = scope(c.get("lunaAccessTokenClaims"));
      const {enabled} = z.object({enabled: z.boolean()}).strict().parse(await c.req.json());
      if (ambient) throw new GatewayError("chat_listening_forbidden", "Nobody addressed you in this turn, so nobody asked for this. Listening is switched only when the Agent owner or a member allowed to asks you.", 403);
      const allowed = new AgentStore(db()).isOwnerUser(invocation.agentId, invocation.actorUserId)
        || new AuthorizationRuleStore(db(), {kind: "agent", agentId: invocation.agentId}).getEffectiveGrantsForUser(invocation.actorUserId)
          .some(grant => grant.effect === "allow" && ruleMatchesOperation(grant, "chat.listen"));
      if (!allowed) throw new GatewayError("chat_listening_forbidden", "The person who asked is not the Agent owner and is not allowed to switch listening (`chat.listen`). Tell them only the owner, or someone the owner allowed, can ask for this.", 403);
      const store = new ChatListeningStore(db());
      store.set(session.shadow_id, session.group_id!, enabled, invocation.actorUserId);
      return c.json({listening: store.enabled(session)});
    });
}
