import { runnerDirectoryScope } from "@/messaging/runner-directory-scope";
import { Hono } from "hono";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { channelIdentities, channelSurfaces, channelUserBindings, sessions, users } from "@/data/schema";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import { recipientSearchText, recordGroupBotIdentities, resolveGroupBotBindings } from "@/messaging/runner-bot-directory";
import { GatewayError } from "../gateway-error";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import type { WorkReplyChannel } from "@/work/types";
import { getKernel } from "./kernel";

/** Minimal recipient directory for active Main invocations, independent of dashboard APIs. */
export function createRunnerUserRoutes(options: { db?: DrizzleDB; channelFor?: (id: string) => WorkReplyChannel | undefined } = {}) {
  const db = () => options.db ?? getKernel().database.db;
  const channelFor = options.channelFor ?? ((id: string) => getKernel().replyChannel(id));
  const scope = (claims: LunaAccessTokenClaims | undefined) => runnerDirectoryScope(db(), channelFor, claims).channels;
  const directory = (channels: Set<string>, kind?: "user" | "bot", query = "") => {
    if (!channels.size) return [];
    const rows = db().select({ user: users, identity: channelIdentities }).from(users)
      .innerJoin(channelUserBindings, eq(channelUserBindings.userId, users.id))
      .innerJoin(channelIdentities, eq(channelIdentities.id, channelUserBindings.channelIdentityId))
      .where(and(eq(users.status, "active"), isNull(users.mergedIntoUserId), inArray(channelIdentities.identityKind, kind ? [kind] : ["user", "bot"]), inArray(channelIdentities.channelId, [...channels]))).all();
    const result = new Map<string, { id: string; displayName: string; identities: { channelId: string; channelType: string; externalId: string; providerIds: Record<string, string> }[] }>();
    const matched = new Set<string>();
    const search = recipientSearchText(query);
    for (const { user, identity } of rows) {
      const ids = JSON.parse(identity.providerIdsJson ?? "{}") as Record<string, string>;
      if (identity.identityKind === "bot" && !ids.open_id) continue;
      const entry = result.get(user.id) ?? { id: user.id, displayName: user.displayName, identities: [] };
      const providerIds = Object.fromEntries(Object.entries(ids).filter(([key]) => ["open_id", "user_id", "union_id"].includes(key)));
      if (!entry.identities.some(i => i.channelId === identity.channelId && i.externalId === identity.externalId)) {
        entry.identities.push({ channelId: identity.channelId, channelType: identity.channelType, externalId: identity.externalId, providerIds });
      }
      const names = [user.id, user.displayName, identity.externalId, ...Object.values(providerIds)];
      if (identity.displayName) names.push(identity.displayName);
      if (names.some(name => recipientSearchText(name).includes(search))) matched.add(user.id);
      result.set(user.id, entry);
    }
    return [...result.values()].filter(row => matched.has(row.id)).sort((a, b) => a.id.localeCompare(b.id));
  };
  return new Hono<{ Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims | undefined } }>()
    .onError((error, c) => error instanceof GatewayError ? c.json({ error: error.code, message: error.message }, error.status as 400) : c.json({ error: "invalid_request" }, 400))
    .get("/users", async c => {
      const claims = c.get("lunaAccessTokenClaims");
      const { actor, channels } = runnerDirectoryScope(db(), channelFor, claims);
      const params = z.object({ q: z.string().max(200).default(""), kind: z.enum(["user", "bot"]).optional(), channelId: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }).parse(c.req.query());
      if (params.channelId && !channels.has(params.channelId)) throw new GatewayError("channel_forbidden", "Channel is outside invocation scope", 403);
      const visible = params.channelId ? new Set([params.channelId]) : channels;
      let rows = directory(visible, params.kind, params.q);
      const query = recipientSearchText(params.q);
      if (params.kind !== "user" && query && !rows.length) {
        const source = db().select().from(sessions).where(eq(sessions.id, actor.currentSessionId)).get();
        const adapter = source && visible.has(source.channel_id) ? channelFor(source.channel_id) : undefined;
        const groupId = source?.group_id;
        if (source && groupId && adapter?.listGroupBots && db().select().from(channelSurfaces).where(and(
          eq(channelSurfaces.channelId, source.channel_id), eq(channelSurfaces.externalId, groupId),
          eq(channelSurfaces.surfaceKind, "group"),
        )).get()) {
          const channel = { id: source.channel_id, type: source.channel_type };
          let roster;
          try { roster = await adapter.listGroupBots(groupId); }
          catch { throw new GatewayError("provider_lookup_failed", "Could not read the current group bot list", 502); }
          const matches = roster.filter(bot => [bot.displayName ?? "", bot.externalId].some(value => recipientSearchText(value).includes(query)));
          const resolved = await resolveGroupBotBindings(db(), channel, source.agent_id, groupId, roster, matches, channelFor);
          if (!scope(claims).has(channel.id)) throw new GatewayError("channel_forbidden", "Channel scope changed", 403);
          recordGroupBotIdentities(db(), channel, resolved);
          rows = directory(visible, params.kind, params.q);
        }
      }
      return c.json({ users: rows.slice(params.offset, params.offset + params.limit), total: rows.length, nextOffset: params.offset + params.limit < rows.length ? params.offset + params.limit : null });
    })
    .get("/users/lookup", async c => {
      const channels = scope(c.get("lunaAccessTokenClaims"));
      const input = z.object({ channelId: z.string().min(1), idType: z.enum(["open_id", "user_id", "union_id"]), id: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) }).parse(c.req.query());
      if (!channels.has(input.channelId)) throw new GatewayError("channel_forbidden", "Channel is outside invocation scope", 403);
      const channel = channelFor(input.channelId);
      if (!channel?.lookupUser) throw new GatewayError("lookup_unavailable", "Channel user lookup is unavailable", 409);
      let identity;
      try { identity = await channel.lookupUser(input.idType, input.id); }
      catch { throw new GatewayError("provider_lookup_failed", "Feishu user lookup failed; check ID and contact permissions", 502); }
      if (!scope(c.get("lunaAccessTokenClaims")).has(input.channelId))
        throw new GatewayError("channel_forbidden", "Channel scope changed", 403);
      new ChannelDirectoryStore(db()).upsertIdentity({ channel: { type: "feishu", id: input.channelId }, identity });
      const user = directory(new Set([input.channelId]), "user").find(u => u.identities.some(i => i.externalId === identity.externalId));
      return c.json({ user });
    })
    .get("/users/:id", c => {
      const user = directory(scope(c.get("lunaAccessTokenClaims"))).find(u => u.id === c.req.param("id"));
      if (!user) throw new GatewayError("user_not_found", "User not found in invocation directory", 404);
      return c.json({ user });
    });
}
