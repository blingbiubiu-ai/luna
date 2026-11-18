import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { channelConfigs } from "@/data/schema";
import { AgentStore } from "@/agents/agent-store";
import { BotBindingStore } from "@/agents/bot-binding-store";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import type { ChannelIdentity } from "@/channels/types";
import { IdentityDirectory } from "./identity-directory";
import { scopeFeishuIdentity } from "./feishu-identity-scopes";
import { followShadowBotAvatar, followShadowBotName } from "./shadow-name";

/** Only verified adapter self-identities can update the current Shadow's external bot link. */
export function recordShadowBotIdentity(db: DrizzleDB, channelConfigId: string, identity: ChannelIdentity): string {
  return db.transaction(tx => {
    const storeDb = tx as unknown as DrizzleDB;
    const binding = new BotBindingStore(storeDb).requireActive(channelConfigId);
    const shadow = new AgentStore(storeDb).shadow(binding.shadowId);
    const channel = tx.select().from(channelConfigs).where(eq(channelConfigs.id, channelConfigId)).get();
    if (!channel || channel.agentId !== binding.agentId || identity.kind !== "bot") throw new Error("bot_identity_scope_mismatch");
    const scoped = scopeFeishuIdentity(identity, {environment: "feishu", appId: channel.appId});
    const persisted = new ChannelDirectoryStore(storeDb).upsertIdentity({channel: {id: channel.id, type: channel.type}, identity: scoped});
    new IdentityDirectory(storeDb).bindBotIdentityToUser(persisted.id, shadow.replyUserId);
    followShadowBotName(tx as unknown as DrizzleDB, shadow.replyUserId, identity.displayName);
    followShadowBotAvatar(tx as unknown as DrizzleDB, shadow.replyUserId, identity.avatarUrl);
    return shadow.replyUserId;
  });
}
