import { resolveMessageTarget } from "@/messaging/delivery-target";
import { resolveFeishuMemberProviderIds, resolveLunaAddress } from "@/messaging/luna-address";
import { RunnerMessageService } from "@/messaging/runner-message-service";
import { Hono } from "hono";
import { eq, inArray, and, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { agentShadows, channelSurfaces, messages, sessions, shadowBotBindings } from "@/data/schema";
import type { ReplyChannel } from "@/channels/outbound";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";
import { runnerDirectoryScope } from "@/messaging/runner-directory-scope";
import { groupCreationSchema, groupInvitationSchema, groupContextMessageIdsSchema } from "@/messaging/group-commands";
import { sessionCommandsFor } from "@/messaging/session-command-service";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import { SessionStore } from "@/sessions/session-store";

const memberRefSchema = z.array(z.string().trim().min(1).max(256)).min(1).max(50);
const createGroupInput = z.object({
  channelId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  idType: z.enum(["open_id", "user_id", "union_id"]).default("open_id"),
  memberIds: memberRefSchema,
  contextMessageIds: groupContextMessageIdsSchema.default([]),
}).strict();
const inviteGroupInput = z.object({
  channelId: z.string().min(1).optional(),
  chatId: z.string().min(1).max(256).optional(),
  to: z.string().min(1).max(512).optional(),
  idType: z.enum(["open_id", "user_id", "union_id"]).default("open_id"),
  memberIds: memberRefSchema,
}).strict();

/** Match the bot's own recorded group conversations, then intersect with the caller's directory. */
function observedBotGroups(db: DrizzleDB, agentId: string, botUserId: string): ReadonlySet<string> {
  const rows = db.select({chatId: channelSurfaces.externalId}).from(sessions)
    .innerJoin(shadowBotBindings, and(eq(shadowBotBindings.id, sessions.binding_id), eq(shadowBotBindings.status, "active")))
    .innerJoin(agentShadows, and(eq(agentShadows.id, sessions.shadow_id), eq(agentShadows.replyUserId, botUserId), eq(agentShadows.status, "active")))
    .innerJoin(channelSurfaces, and(eq(channelSurfaces.channelType, "feishu"), eq(channelSurfaces.channelId, sessions.channel_id),
      eq(channelSurfaces.externalId, sessions.group_id), eq(channelSurfaces.surfaceKind, "group")))
    .where(and(eq(sessions.agent_id, agentId), eq(sessions.channel_type, "feishu"),
      eq(sessions.bot_user_id, botUserId), eq(sessions.status, "active")))
    .all();
  return new Set(rows.map(row => row.chatId));
}

function observedUserGroups(db: DrizzleDB, agentId: string, channels: Set<string>, userId: string): ReadonlySet<string> {
  if (!channels.size) return new Set();
  const rows = db.selectDistinct({channelId: sessions.channel_id, chatId: sessions.group_id}).from(messages)
    .innerJoin(sessions, and(eq(sessions.id, messages.ownerSessionId), eq(sessions.binding_id, messages.bindingId),
      eq(sessions.channel_id, messages.channelId), eq(sessions.agent_id, messages.agentId)))
    .innerJoin(shadowBotBindings, and(eq(shadowBotBindings.id, sessions.binding_id), eq(shadowBotBindings.status, "active")))
    .where(and(eq(messages.channelType, "feishu"), inArray(messages.channelId, [...channels]),
      eq(messages.senderUserId, userId), eq(messages.role, "user"), isNull(messages.deletedAt),
      eq(messages.agentId, agentId), eq(sessions.status, "active")))
    .all();
  return new Set(rows.map(row => JSON.stringify([row.channelId, row.chatId])));
}

export function createRunnerGroupRoutes(options: { db?: DrizzleDB; channelFor?: (id: string) => ReplyChannel | undefined } = {}) {
  const db = () => options.db ?? getKernel().database.db;
  const channelFor = options.channelFor ?? ((id: string) => getKernel().replyChannel(id));
  const scope = (claims: LunaAccessTokenClaims | undefined) => runnerDirectoryScope(db(), channelFor, claims);
  const groupSource = (claims: LunaAccessTokenClaims | undefined, channelId?: string) => {
    const { actor, channels } = scope(claims);
    const session = new SessionStore(db()).getById(actor.currentSessionId);
    if (session?.channel_type !== "feishu" || !channels.has(session.channel_id) ||
      (channelId !== undefined && channelId !== session.channel_id))
      throw new GatewayError("channel_forbidden", "Group operations require the current session's Feishu channel", 403);
    return { actor, session };
  };
  const visible = (channels: Set<string>, matches = (_row: typeof channelSurfaces.$inferSelect) => true) => channels.size ? db().select().from(channelSurfaces).where(and(inArray(channelSurfaces.channelId, [...channels]), eq(channelSurfaces.surfaceKind, "group"))).all()
    .filter(matches).map(row => ({
    id: row.id, channelId: row.channelId, chatId: row.externalId, name: row.displayName,
    sessionId: db().select().from(sessions).where(and(eq(sessions.channel_id, row.channelId), eq(sessions.group_id, row.externalId))).all().find(session => !session.thread_key && session.status === "active")?.id ?? null,
  })).sort((a, b) => a.id.localeCompare(b.id)) : [];
  return new Hono<{ Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims | undefined } }>()
    .onError((error, c) => error instanceof GatewayError ? c.json({ error: error.code, message: error.message }, error.status as 400) : c.json({ error: "invalid_request" }, 400))
    .get("/groups", c => {
      const { actor, channels } = scope(c.get("lunaAccessTokenClaims"));
      const memberId = z.string().trim().min(1).max(256).optional();
      const input = z.object({ q: z.string().max(200).default(""), channelId: z.string().optional(),
        userId: memberId, limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0) }).parse(c.req.query());
      if (input.channelId && !channels.has(input.channelId)) throw new GatewayError("channel_forbidden", "Channel is outside invocation scope", 403);
      const selectedChannels = input.channelId ? new Set([input.channelId]) : channels;
      const source = input.userId === undefined ? undefined : new SessionStore(db()).getById(actor.currentSessionId);
      const memberGroups = source && input.userId !== undefined ? {
        botChats: observedBotGroups(db(), source.agent_id, input.userId),
        messageChats: observedUserGroups(db(), source.agent_id, selectedChannels, input.userId),
      } : undefined;
      const rows = visible(selectedChannels, row => memberGroups === undefined || (row.channelType === "feishu" &&
        (memberGroups.botChats.has(row.externalId) || memberGroups.messageChats.has(JSON.stringify([row.channelId, row.externalId])))))
        .filter(row => [row.name ?? "", row.chatId, row.id].some(value => value.toLocaleLowerCase().includes(input.q.toLocaleLowerCase())));
      return c.json({ groups: rows.slice(input.offset, input.offset + input.limit), total: rows.length, nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null });
    })
    .get("/groups/lookup", async c => {
      const { channels } = scope(c.get("lunaAccessTokenClaims"));
      const input = z.object({ channelId: z.string().min(1), chatId: z.string().min(1).max(256) }).parse(c.req.query());
      if (!channels.has(input.channelId)) throw new GatewayError("channel_forbidden", "Channel is outside invocation scope", 403);
      const channel = channelFor(input.channelId);
      if (!channel?.lookupGroup) throw new GatewayError("lookup_unavailable", "Group lookup unavailable", 409);
      let surface;
      try { surface = await channel.lookupGroup(input.chatId); }
      catch { throw new GatewayError("provider_lookup_failed", "Group lookup failed; verify group ID and bot access", 502); }
      if (!scope(c.get("lunaAccessTokenClaims")).channels.has(input.channelId)) throw new GatewayError("channel_forbidden", "Channel scope changed", 403);
      if (surface.kind !== "group" || surface.externalId !== input.chatId) throw new GatewayError("invalid_group", "Expected a group conversation", 409);
      const row = db().transaction(tx => {
        const storeDb = tx as unknown as DrizzleDB;
        const result = new ChannelDirectoryStore(storeDb).upsertSurface({ channel: { type: "feishu", id: input.channelId }, surface });
        new SessionStore(storeDb).resolveByChannelSurface({ channelType: "feishu", channelId: input.channelId, groupId: input.chatId });
        return result;
      });
      return c.json({ group: visible(new Set([input.channelId])).find(group => group.id === row.id) });
    })
    .get("/groups/:id", c => {
      const group = visible(scope(c.get("lunaAccessTokenClaims")).channels).find(row => row.id === c.req.param("id"));
      if (!group) throw new GatewayError("group_not_found", "Group not found in invocation directory", 404);
      return c.json({ group });
    })
    .post("/groups/invite", async c => {
      const input = inviteGroupInput.parse(await c.req.json());
      const claims = c.get("lunaAccessTokenClaims");
      let resolvedChatId = input.chatId;
      let resolvedChannelId = input.channelId;
      if (input.to) {
        const msgActor = new RunnerMessageService(db(), channelFor).actor(claims);
        const addr = resolveLunaAddress(
          db(),
          { agentId: msgActor.agentId, shadowId: msgActor.shadowId, currentSessionId: msgActor.currentSessionId },
          input.to,
          { create: false },
        );
        resolvedChannelId = addr.channelId ?? resolvedChannelId;
        resolvedChatId = addr.chatId ?? resolvedChatId;
      }
      const { actor, session } = groupSource(claims, resolvedChannelId);
      const chatId = resolvedChatId ?? session.group_id;
      if (!chatId) throw new GatewayError("group_required", "Specify group address / chatId or run from a group conversation", 400);
      const resolvedMembers = resolveFeishuMemberProviderIds(db(), session.channel_id, input.idType, input.memberIds);
      const invitation = groupInvitationSchema.parse({
        idType: input.idType,
        memberIds: resolvedMembers,
        channelId: session.channel_id,
        chatId,
      });
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w.-]{1,128}$/.test(key)) throw new GatewayError("invalid_idempotency_key", "Stable idempotency key required", 400);
      const surface = db().select().from(channelSurfaces).where(and(eq(channelSurfaces.channelId, invitation.channelId), eq(channelSurfaces.externalId, invitation.chatId))).get();
      if (surface?.surfaceKind !== "group") {
        if (!resolvedChatId) throw new GatewayError("group_required", "Specify group address / chatId or run from a group conversation", 400);
        throw new GatewayError("group_not_found", "Resolve the group before inviting members", 404);
      }
      const targetId = resolveMessageTarget(db(), { kind: "surface", channelId: invitation.channelId, surfaceId: invitation.chatId }, actor.currentSessionId);
      const row = sessionCommandsFor(db(), channelFor).accept(actor, targetId, "group.invite", key, { content: "Invite group members", invitation });
      return c.json({ commandId: row.id, kind: "group.invite", status: row.status, result: row.payload.result ?? null, error: row.error }, ["pending", "running"].includes(row.status) ? 202 : 200);
    })
    .post("/groups", async c => {
      const input = createGroupInput.parse(await c.req.json());
      const { actor, session } = groupSource(c.get("lunaAccessTokenClaims"), input.channelId);
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w.-]{1,128}$/.test(key)) throw new GatewayError("invalid_idempotency_key", "Stable idempotency key required", 400);
      const resolvedMembers = resolveFeishuMemberProviderIds(db(), session.channel_id, input.idType, input.memberIds);
      const group = groupCreationSchema.parse({
        name: input.name,
        idType: input.idType,
        memberIds: resolvedMembers,
        channelId: session.channel_id,
      });
      const row = sessionCommandsFor(db(), channelFor).accept(actor, actor.sourceSessionId, "group.create", key, { content: group.name, group, contextMessageIds: input.contextMessageIds });
      return c.json({ commandId: row.id, kind: "group.create", status: row.status, result: row.payload.result ?? null, error: row.error }, ["pending", "running"].includes(row.status) ? 202 : 200);
    });
}
