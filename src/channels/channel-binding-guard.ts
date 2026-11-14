import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {channelConfigs} from "@/data/schema";
import {AgentError} from "@/agents/agent-store";
import {BotBindingStore} from "@/agents/bot-binding-store";
import {DASHBOARD_CHANNEL_ID} from "./dashboard/dashboard-channel";

/** Captures adapter ownership once; a later binding cannot inherit an old adapter's callbacks. */
export class ChannelBindingGuard {
  readonly bindingId: string | null;
  private retired = false;
  constructor(private readonly db: DrizzleDB, private readonly channel: {id: string; type: string}) {
    this.bindingId = channel.type === "dashboard" && channel.id === DASHBOARD_CHANNEL_ID
      ? null : new BotBindingStore(db).requireActive(channel.id).id;
    this.assertCurrent();
  }
  retire(): void { this.retired = true; }
  restore(): void {
    this.retired = false;
    try { this.assertCurrent(); } catch (error) { this.retired = true; throw error; }
  }
  assertCurrent(messageChannel = this.channel): void {
    if (this.retired) throw new AgentError("channel_adapter_retired", 409);
    if (messageChannel.id !== this.channel.id || messageChannel.type !== this.channel.type) throw new AgentError("channel_scope_mismatch", 409);
    if (this.bindingId === null) return;
    const binding = new BotBindingStore(this.db).requireActive(this.channel.id);
    if (binding.id !== this.bindingId) throw new AgentError("bot_binding_retired", 409);
    const config = this.db.select().from(channelConfigs).where(eq(channelConfigs.id, this.channel.id)).get();
    if (!config?.enabled || config.type !== this.channel.type) throw new AgentError("channel_disabled", 409);
  }
}
