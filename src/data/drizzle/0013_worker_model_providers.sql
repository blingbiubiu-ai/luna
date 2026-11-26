ALTER TABLE agent_profile_revisions ADD COLUMN model_provider_json TEXT;
--> statement-breakpoint
CREATE TABLE agent_model_provider_accounts (
  agent_id TEXT NOT NULL REFERENCES luna_agents(id),
  worker_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (agent_id, worker_id, plugin_id, provider_id, revision)
);
