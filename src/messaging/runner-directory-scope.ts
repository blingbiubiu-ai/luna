import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { sessions, users } from "@/data/schema";
import { SessionStore } from "@/sessions/session-store";
import { RunnerMessageService } from "./runner-message-service";
import { GatewayError } from "@/server/gateway-error";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import type { ReplyChannel } from "@/channels/outbound";

export function runnerDirectoryScope(db: DrizzleDB, channelFor: (id: string) => ReplyChannel | undefined, claims: LunaAccessTokenClaims | undefined) {
  const actor = new RunnerMessageService(db, channelFor).actor(claims);
  const user = db.select().from(users).where(eq(users.id, actor.userId)).get();
  if (!user || user.status !== "active") throw new GatewayError("actor_inactive", "Actor is inactive", 403);
  const source = db.select().from(sessions).where(eq(sessions.id, actor.currentSessionId)).get();
  new SessionStore(db).requireReplyUserId(actor.currentSessionId);
  const channels = new Set(source?.binding_id && channelFor(source.channel_id) ? [source.channel_id] : []);
  return { actor, channels };
}
