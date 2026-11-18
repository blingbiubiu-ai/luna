import {AgentStore} from "@/agents/agent-store";
import {SessionAccessPolicy} from "@/agents/session-access";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { messages, users } from "@/data/schema";
import type { ChannelAdapter, NormalizedInboundMessage } from "@/channels";
import type { DashboardAccount } from "@/server/auth";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import { GatewayError } from "@/server/gateway-error";
import { SessionStore } from "@/sessions/session-store";
import type { OutboundChannelOperation } from "@/work/types";

export const DASHBOARD_CHANNEL_ID = "luna-dashboard";
type Operation = Omit<OutboundChannelOperation, "id" | "channelId">;

/** HTTP transport adapter. All message persistence, batching and execution belong to ingress. */
export class DashboardChannel implements ChannelAdapter {
  readonly id = DASHBOARD_CHANNEL_ID;
  readonly type = "dashboard";
  private handler?: (message: NormalizedInboundMessage) => Promise<void>;
  private readonly submissions = new Map<string, { text: string; promise: Promise<{ messageId: string | null }> }>();

  constructor(private readonly db: DrizzleDB) {}
  async start() {}
  async stop() {}
  async subscribeInbound(handler: (message: NormalizedInboundMessage) => Promise<void>) { this.handler = handler; }

  submit(sessionId: string, account: DashboardAccount, text: string, key: string): Promise<{ messageId: string | null }> {
    const id = `dashboard:${JSON.stringify([sessionId, account.id, key])}`;
    const pending = this.submissions.get(id);
    if (pending) {
      if (pending.text !== text) throw new GatewayError("idempotency_conflict", "Key already used with different text", 409);
      return pending.promise;
    }
    const promise = this.receive(sessionId, account, text, id).finally(() => { this.submissions.delete(id); });
    this.submissions.set(id, { text, promise });
    return promise;
  }

  /**
   * The account acts as its user in the session's Agent. The Dashboard channel is
   * shared by all Agents, so its identity is keyed by that user, not the account.
   */
  private async receive(sessionId: string, account: DashboardAccount, text: string, id: string) {
    if (!this.handler) throw new GatewayError("channel_unavailable", "Dashboard channel is not ready", 503);
    const store = new SessionStore(this.db);
    const agentId = store.getById(sessionId)?.agent_id;
    if (!agentId) throw new GatewayError("session_unavailable", "Session is unavailable", 404);
    const agents = new AgentStore(this.db);
    agents.requireOwner(account.id, agentId);
    const userId = agents.ownerUserId(agentId);
    const session = new SessionAccessPolicy(this.db).requireAccess(userId, sessionId);
    if (session.status !== "active") throw new GatewayError("session_unavailable", "Session is unavailable", 404);
    store.requireReplyUserId(sessionId);
    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (user?.status !== "active") throw new GatewayError("actor_inactive", "Actor is inactive", 403);
    new ChannelDirectoryStore(this.db).ensureAuthenticatedIdentity({ type: this.type, id: this.id },
      { externalId: userId, kind: "user", displayName: user.displayName }, userId);
    const find = () => this.db.select().from(messages).where(and(eq(messages.channelId, this.id), eq(messages.externalMessageId, id))).get();
    const existing = find();
    if (existing) {
      const original = existing.contentJson as { type: string; text?: string }[];
      if (original.map(part => part.text ?? "").join("") !== text) throw new GatewayError("idempotency_conflict", "Key already used with different text", 409);
      return { messageId: existing.id };
    }
    await this.handler({
      id, targetSessionId: sessionId, channel: { type: this.type, id: this.id }, surface: { externalId: sessionId, kind: "p2p" },
      sender: { externalId: userId, kind: "user", displayName: user.displayName,
        requesterIdentity: { provider: "local", externalUserId: userId, canonicalUserId: userId } },
      text, contentKind: "text", mentions: [], addressing: { addressedToBot: true, reason: "p2p" },
      rawPayload: { origin: "dashboard" },
    });
    return { messageId: find()?.id ?? null };
  }

  async send(_inbound: NormalizedInboundMessage, operation: Operation): Promise<OutboundChannelOperation> {
    // Compatibility for ingress control responses only. Session replies never deliver here.
    return { ...operation, id: operation.replyMode === "update_status_card" ? operation.targetMessageId!
      : `dashboard-reply:${operation.idempotencyKey ?? crypto.randomUUID()}`, channelId: this.id };
  }
}
