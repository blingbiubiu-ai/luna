import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDB } from "@/data";
import { agentPluginConfigs, channelConfigs, lunaAgents } from "@/data/schema";
import { assertDatabaseBaseline } from "@/data/schema-baseline";
import { resolveMigrationsFolder } from "@/data/data-connection";
import { readOption } from "@luna/cli-support/options";
import type { CliResult, Env } from "@luna/cli-support/types";
import { defaultLunaHome } from "@luna/host-runtime/env";
import { AgentProfileStore, AgentSecretCipher, ActiveAgentConfigService } from "@/agent-config";
import type { EncryptedSecret } from "@/agent-config/secret-cipher";
import { AgentStore } from "@/agents/agent-store";
import { BotBindingStore } from "@/agents/bot-binding-store";
import { ShadowModelSelectionStore } from "@/agents/shadow-model-selection-store";
import { AccountStore } from "@/identity/account-store";
import type { ChannelIdentity } from "@/channels/types";


const usage = "luna service admin import-config --from <old luna.db> --account-id <owner account id> [--from-key-file <path>] [--home <path>]";

interface OldAgent { id: string; name: string; default_shadow_id: string }
interface OldShadow { id: string; agent_id: string; name: string }
interface OldChannel { id: string; agent_id: string; type: string; name: string; app_id: string; secret: string; chat_id: string; enabled: number; bot_identity: string | null }
interface OldBinding { shadow_id: string; channel_config_id: string }
interface OldProfile { id: string; agent_id: string; name: string; agent_type: string }
interface OldRevision { id: string; profile_id: string; revision_number: number; model: string; resume_on_model_change: number; env_json: string; validation_state: string }
interface OldSecret { env_key: string; ciphertext: string; nonce: string; auth_tag: string; algorithm: string; key_version: number; credential_identity: string }
interface OldPlugin { agent_id: string; plugin_id: string; revision: string; enabled: number; config_json: string; secrets_json: string }

/**
 * Copies the configuration of an old Luna database into a new, empty one: its
 * active Agents and Shadows, Feishu bots, model profiles and plugin settings.
 * Conversations, memory, users and grants stay behind. Secrets are bound to
 * their row ids, so each is decrypted with the old key and encrypted anew.
 */
export function runImportConfigCli(argv: string[], env: Env): CliResult {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") return { status: "ok", output: usage };
  try {
    const from = readOption(argv, "--from"), accountId = readOption(argv, "--account-id")?.trim();
    if (argv[0] !== "import-config" || !from || !accountId) throw new Error(usage);
    const home = readOption(argv, "--home") ?? defaultLunaHome(env);
    const cipher = AgentSecretCipher.fromEnvironment(env);
    const keyFile = readOption(argv, "--from-key-file");
    const oldCipher = keyFile ? AgentSecretCipher.fromEnvironment({ LUNA_AGENT_CONFIG_MASTER_KEY_FILE: keyFile }) : cipher;
    const old = new Database(from, { readonly: true });
    const sqlite = new Database(join(home, "data", "luna.db"), { readwrite: true, create: false });
    try {
      sqlite.run("PRAGMA busy_timeout = 5000");
      sqlite.run("PRAGMA foreign_keys = ON");
      if (assertDatabaseBaseline(sqlite, resolveMigrationsFolder())) throw new Error("Start Luna Service once to create the new database first.");
      const db = drizzle(sqlite) as unknown as DrizzleDB;
      if (new AccountStore(db).get(accountId)?.status !== "active") throw new Error("Sign in to the new Service once so the owner account exists.");
      if (db.select({ id: lunaAgents.id }).from(lunaAgents).get()) throw new Error("The new database already has Agents; import only into a fresh database.");
      const report = sqlite.transaction(() => importAll(old, db, accountId, oldCipher, cipher)).immediate();
      return { status: "ok", output: JSON.stringify(report, null, 2) };
    } finally {
      sqlite.close();
      old.close();
    }
  } catch (error) {
    return { status: "error", code: "import_config_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function importAll(old: Database, db: DrizzleDB, accountId: string, oldCipher: AgentSecretCipher, cipher: AgentSecretCipher) {
  const agents = new AgentStore(db);
  const report: { agents: { from: string; id: string; name: string; shadows: number; channels: number; profiles: number; plugins: number }[] } = { agents: [] };
  for (const oldAgent of old.query("SELECT id, name, default_shadow_id FROM luna_agents WHERE status = 'active' ORDER BY created_at").all() as OldAgent[]) {
    const agent = agents.create(accountId, { name: oldAgent.name }, `import:${oldAgent.id}`);
    const shadowIds = new Map<string, string>();
    for (const shadow of old.query("SELECT id, agent_id, name FROM agent_shadows WHERE agent_id = ? AND status = 'active' ORDER BY created_at").all(oldAgent.id) as OldShadow[]) {
      if (shadow.id === oldAgent.default_shadow_id) {
        if (shadow.name !== "本体") agents.renameShadow(accountId, { agentId: agent.id, shadowId: agent.defaultShadowId }, { name: shadow.name });
        shadowIds.set(shadow.id, agent.defaultShadowId);
      } else {
        shadowIds.set(shadow.id, agents.createShadow(accountId, agent.id, { name: shadow.name }, `import:${shadow.id}`).id);
      }
    }

    let channels = 0;
    for (const channel of old.query("SELECT id, agent_id, type, name, app_id, secret, chat_id, enabled, bot_identity FROM channel_configs WHERE agent_id = ?").all(oldAgent.id) as OldChannel[]) {
      const secret = oldCipher.decrypt({ ...(JSON.parse(channel.secret) as EncryptedSecret), profileId: channel.id, revisionId: "channel-v1", key: "app_secret" });
      db.insert(channelConfigs).values({
        id: channel.id, agentId: agent.id, type: channel.type, name: channel.name, appId: channel.app_id,
        secret: cipher.encrypt({ profileId: channel.id, revisionId: "channel-v1", key: "app_secret", plaintext: secret }),
        chatId: channel.chat_id, enabled: channel.enabled === 1,
        botIdentity: channel.bot_identity ? JSON.parse(channel.bot_identity) as ChannelIdentity : null, updatedAt: Date.now(),
      }).run();
      const binding = old.query("SELECT shadow_id, channel_config_id FROM shadow_bot_bindings WHERE channel_config_id = ? AND status = 'active'").get(channel.id) as OldBinding | null;
      const shadowId = binding ? shadowIds.get(binding.shadow_id) : undefined;
      if (shadowId) new BotBindingStore(db).bind(accountId, shadowId, channel.id);
      channels++;
    }

    const profiles = new AgentProfileStore(db, cipher, agent.id);
    const revisionIds = new Map<string, string>();
    const active = old.query("SELECT profile_id, revision_id FROM active_agent_config WHERE agent_id = ?").get(oldAgent.id) as { profile_id: string; revision_id: string } | null;
    const selections = old.query("SELECT shadow_id, mode, revision_id FROM shadow_model_selections WHERE agent_id = ?").all(oldAgent.id) as { shadow_id: string; mode: string; revision_id: string | null }[];
    const wanted = new Set([active?.revision_id, ...selections.map(row => row.revision_id)].filter((id): id is string => Boolean(id)));
    let profileCount = 0;
    const hasExecutionDriver = (old.query("PRAGMA table_info(agent_profile_revisions)").all() as { name: string }[]).some(col => col.name === "execution_driver");
    for (const profile of old.query("SELECT id, agent_id, name, agent_type FROM agent_profiles WHERE agent_id = ? AND deleted_at IS NULL ORDER BY created_at").all(oldAgent.id) as OldProfile[]) {
      const revisions = (old.query(`SELECT id, profile_id, revision_number, model, ${hasExecutionDriver ? "execution_driver," : ""} resume_on_model_change, env_json, validation_state FROM agent_profile_revisions WHERE profile_id = ? ORDER BY revision_number`).all(profile.id) as (OldRevision & { execution_driver?: string })[]);
      const latest = revisions.at(-1);
      const chosen = revisions.filter(revision => wanted.has(revision.id) || revision === latest);
      let newProfileId: string | undefined;
      for (const revision of chosen) {
        const secrets = Object.fromEntries((old.query("SELECT env_key, ciphertext, nonce, auth_tag, algorithm, key_version, credential_identity FROM agent_profile_secrets WHERE revision_id = ?").all(revision.id) as OldSecret[])
          .map(row => [row.env_key, { set: oldCipher.decrypt({ ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, algorithm: row.algorithm as "aes-256-gcm",
            keyVersion: row.key_version, credentialIdentity: row.credential_identity, profileId: profile.id, revisionId: revision.id, key: row.env_key }) }]));
        const input = { model: revision.model, ...(revision.execution_driver ? { executionDriver: revision.execution_driver } : {}), resumeOnModelChange: revision.resume_on_model_change === 1,
          env: JSON.parse(revision.env_json) as Record<string, string>, secrets, actorId: accountId };
        let created;
        if (newProfileId === undefined) {
          const createdProfile = profiles.createProfile({ ...input, name: profile.name, agentType: profile.agent_type });
          newProfileId = createdProfile.id;
          created = createdProfile.latestRevision;
        } else {
          created = profiles.createRevision(newProfileId, input);
        }
        // A revision validated in the old Service was checked against its provider there.
        if (revision.validation_state === "validated") profiles.recordValidation(created.id, { success: true, message: "Imported validated revision" });
        revisionIds.set(revision.id, created.id);
      }
      profileCount++;
    }
    if (active && revisionIds.has(active.revision_id)) {
      new ActiveAgentConfigService(db, cipher).activate(agent.id, revisionIds.get(active.revision_id)!, accountId);
    }
    for (const selection of selections) {
      const shadowId = shadowIds.get(selection.shadow_id), revisionId = selection.revision_id ? revisionIds.get(selection.revision_id) : undefined;
      if (!shadowId) continue;
      new ShadowModelSelectionStore(db).save(accountId, { agentId: agent.id, shadowId },
        selection.mode === "fixed" && revisionId ? { mode: "fixed", revisionId } : { mode: "inherit" });
    }

    let plugins = 0;
    for (const plugin of old.query("SELECT agent_id, plugin_id, revision, enabled, config_json, secrets_json FROM agent_plugin_configs WHERE agent_id = ?").all(oldAgent.id) as OldPlugin[]) {
      const revision = randomUUID();
      const oldSecrets = JSON.parse(plugin.secrets_json) as Record<string, EncryptedSecret & { revision: string }>;
      const secrets = Object.fromEntries(Object.entries(oldSecrets).map(([key, value]) => {
        const plaintext = oldCipher.decrypt({ ...value, profileId: `plugin:${oldAgent.id}:${plugin.plugin_id}`, revisionId: value.revision, key });
        return [key, { ...cipher.encrypt({ profileId: `plugin:${agent.id}:${plugin.plugin_id}`, revisionId: revision, key, plaintext }), revision }];
      }));
      db.insert(agentPluginConfigs).values({ agentId: agent.id, pluginId: plugin.plugin_id, revision, enabled: plugin.enabled === 1,
        config: JSON.parse(plugin.config_json) as Record<string, unknown>, secrets, updatedByAccountId: accountId, updatedAt: Date.now() }).run();
      plugins++;
    }
    report.agents.push({ from: oldAgent.id, id: agent.id, name: oldAgent.name, shadows: shadowIds.size, channels, profiles: profileCount, plugins });
  }
  return report;
}
