-- Luna schema. New installations only; existing databases are not upgraded.
-- Keep table constraints, indexes and triggers together when changing this baseline.

CREATE TABLE accounts (
 id TEXT PRIMARY KEY NOT NULL,
 display_name TEXT NOT NULL,
 avatar_url TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','disabled','deleted')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_tokens" (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text REFERENCES users(id),
	`account_id` text REFERENCES accounts(id),
	`source` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`source_runner_job_id` text,
	`source_session_id` text,
	`source_turn_id` text,
	`source_task_id` text,
	`source_task_run_id` text,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`metadata_json` text
, agent_id TEXT REFERENCES luna_agents(id), shadow_id TEXT REFERENCES agent_shadows(id),
	CHECK((`user_id` IS NULL) <> (`account_id` IS NULL)));
--> statement-breakpoint
CREATE TABLE active_agent_config (
 agent_id TEXT PRIMARY KEY NOT NULL REFERENCES luna_agents(id),
 agent_type TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 revision_id TEXT NOT NULL,
 activation_sequence INTEGER NOT NULL,
 activated_by_account_id TEXT REFERENCES accounts(id),
 activated_at INTEGER NOT NULL,
 FOREIGN KEY(agent_id,profile_id) REFERENCES agent_profiles(agent_id,id),
 FOREIGN KEY(profile_id,revision_id) REFERENCES agent_profile_revisions(profile_id,id)
);
--> statement-breakpoint
CREATE TABLE agent_lifecycle_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 agent_id TEXT NOT NULL REFERENCES luna_agents(id),
 shadow_id TEXT REFERENCES agent_shadows(id),
 actor_account_id TEXT NOT NULL REFERENCES accounts(id),
 idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 target_status TEXT NOT NULL CHECK(target_status IN ('active','disabled','deleted')),
 status TEXT NOT NULL CHECK(status IN ('pending','completed')),
 last_error TEXT,
 created_at INTEGER NOT NULL,
 completed_at INTEGER,
 FOREIGN KEY(agent_id,shadow_id) REFERENCES agent_shadows(agent_id,id)
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
 id TEXT PRIMARY KEY NOT NULL,
 agent_id TEXT NOT NULL REFERENCES luna_agents(id),
 type TEXT NOT NULL CHECK(type IN ('persona','person','feedback','project','procedure','reference','episode')),
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 body TEXT NOT NULL,
 subject_user_id TEXT,
 visibility TEXT NOT NULL CHECK(visibility IN ('agent','shadow')),
 origin_kind TEXT NOT NULL CHECK(origin_kind IN ('inline','reflection','consolidation','owner','migration')),
 origin_shadow_id TEXT,
 origin_session_id TEXT,
 origin_task_id TEXT,
 origin_user_id TEXT,
 updated_context_id TEXT,
 trusted INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 change_seq INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','deleted','archived')),
 superseded_by TEXT,
 core INTEGER NOT NULL,
 expires_at INTEGER,
 last_used_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 occurred_at INTEGER,
 participants_json TEXT NOT NULL DEFAULT '[]',
 CONSTRAINT agent_memories_person_subject CHECK ((type='person') = (subject_user_id IS NOT NULL)),
 CONSTRAINT agent_memories_shadow_origin CHECK (visibility='agent' OR origin_shadow_id IS NOT NULL),
 CONSTRAINT agent_memories_core_type CHECK (core=0 OR type NOT IN ('person','persona','episode')),
 CONSTRAINT agent_memories_persona_private CHECK (type<>'persona' OR visibility='shadow'),
 CONSTRAINT agent_memories_episode_time CHECK ((type='episode') = (occurred_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE agent_memory_revisions (
 memory_id TEXT NOT NULL REFERENCES agent_memories(id),
 revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL,
 change_kind TEXT NOT NULL CHECK(change_kind IN ('inline','reflection','consolidation','owner','migration','forgetting')),
 changed_by_user_id TEXT,
 changed_by_shadow_id TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY (memory_id, revision)
);
--> statement-breakpoint
CREATE VIRTUAL TABLE agent_memory_terms USING fts5(memory_id, title, description, body);
--> statement-breakpoint
CREATE TABLE agent_mutation_receipts (
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(actor_account_id,operation,key)
);
--> statement-breakpoint
CREATE TABLE agent_plugin_configs (
 agent_id TEXT NOT NULL REFERENCES luna_agents(id),
 plugin_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 config_json TEXT NOT NULL,
 secrets_json TEXT NOT NULL,
 updated_by_account_id TEXT NOT NULL REFERENCES accounts(id),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(agent_id,plugin_id)
);
--> statement-breakpoint
CREATE TABLE `agent_profile_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`model` text NOT NULL,
	`resume_on_model_change` integer DEFAULT true NOT NULL,
	`env_json` text DEFAULT '{}' NOT NULL,
	`config_fingerprint` text NOT NULL,
	`validation_state` text DEFAULT 'draft' NOT NULL,
	`validation_result_json` text,
	`validated_at` integer,
	`created_by_account_id` text REFERENCES accounts(id),
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_profile_secrets` (
	`revision_id` text NOT NULL,
	`env_key` text NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`auth_tag` text NOT NULL,
	`algorithm` text NOT NULL,
	`key_version` integer NOT NULL,
	`credential_identity` text NOT NULL,
	`updated_by_account_id` text REFERENCES accounts(id),
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`agent_type` text NOT NULL,
	`deleted_at` integer,
	`created_by_account_id` text REFERENCES accounts(id),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, agent_id TEXT NOT NULL REFERENCES luna_agents(id));
--> statement-breakpoint
CREATE TABLE agent_shadows (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES luna_agents(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  reply_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('active','disabled','deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent_id,id)
);
--> statement-breakpoint
CREATE TABLE agent_worker_access (
 agent_id TEXT NOT NULL REFERENCES luna_agents(id),
 worker_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','disabled')),
 updated_by_account_id TEXT NOT NULL REFERENCES accounts(id),
 updated_at INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
 PRIMARY KEY(agent_id,worker_id)
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`timeline_event_id` text,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`path` text,
	`content` text,
	`metadata` text,
	`status` text DEFAULT 'active' NOT NULL,
	`retention_expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE authorization_rules (
  id text PRIMARY KEY NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  match_type text NOT NULL CHECK(match_type IN ('exact','prefix')),
  target text NOT NULL,
  effect text NOT NULL CHECK(effect IN ('allow','deny')),
  expires_at integer,
  created_at text NOT NULL,
  updated_at text NOT NULL
, scope_type TEXT NOT NULL CHECK(scope_type IN ('platform','agent')), agent_id TEXT REFERENCES luna_agents(id)
  CHECK((scope_type='platform' AND agent_id IS NULL) OR (scope_type='agent' AND agent_id IS NOT NULL)));
--> statement-breakpoint
CREATE TABLE `channel_auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL REFERENCES users(id),
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_identity_id` text,
	`purpose` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE channel_configs(id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,app_id TEXT NOT NULL UNIQUE,secret TEXT NOT NULL,chat_id TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,bot_identity TEXT,updated_at INTEGER NOT NULL, agent_id TEXT NOT NULL REFERENCES luna_agents(id));
--> statement-breakpoint
CREATE TABLE `channel_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`external_id` text NOT NULL,
	`identity_kind` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`provider_ids_json` text,
	`raw_profile_json` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`profile_updated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_message_markers` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`marker_type` text NOT NULL,
	`provider_marker_id` text NOT NULL,
	`provider_payload_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_surfaces` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`external_id` text NOT NULL,
	`surface_kind` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`provider_ids_json` text,
	`raw_profile_json` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`profile_updated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE channel_user_bindings (
  channel_identity_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_auth_sessions" (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code_hash` text NOT NULL,
	`status` text NOT NULL,
	`approved_by_account_id` text REFERENCES accounts(id),
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer,
	`consumed_at` integer,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE `context_pack_items` (
	`id` text PRIMARY KEY NOT NULL,
	`context_pack_id` text NOT NULL,
	`item_kind` text NOT NULL,
	`item_id` text NOT NULL,
	`source_session_id` text,
	`source_entry_id` text,
	`source_message_id` text,
	`source_identity_id` text,
	`role` text NOT NULL,
	`reason` text NOT NULL,
	`display_order` integer NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE `context_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`selection_strategy` text NOT NULL,
	`trigger_entry_id` text,
	`trigger_message_id` text,
	`created_for_invocation_id` text,
	`created_at` integer NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE deleted_task_references (
 task_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '',
 PRIMARY KEY (task_id, session_id, message_id)
);
--> statement-breakpoint
CREATE TABLE direct_recipients (
 id TEXT PRIMARY KEY NOT NULL,
 channel_id TEXT NOT NULL,
 id_type TEXT NOT NULL,
 recipient_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 surface_id TEXT
, claim_id TEXT);
--> statement-breakpoint
CREATE TABLE `group_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`avatar_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
, agent_id TEXT NOT NULL REFERENCES luna_agents(id));
--> statement-breakpoint
CREATE TABLE identity_observations (
  claim_id TEXT NOT NULL REFERENCES user_identity_links(id),
  channel_identity_id TEXT NOT NULL REFERENCES channel_user_bindings(channel_identity_id),
  confidence TEXT NOT NULL CHECK(confidence IN ('verified','inferred','manual')),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(claim_id,channel_identity_id)
);
--> statement-breakpoint
CREATE TABLE invocation_resource_snapshots (
 invocation_id TEXT PRIMARY KEY NOT NULL REFERENCES runner_invocations(invocation_id),
 digest TEXT NOT NULL REFERENCES runner_resource_snapshots(digest),
 created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE luna_agents (
  id TEXT PRIMARY KEY NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  default_shadow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','disabled','deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(id, default_shadow_id) REFERENCES agent_shadows(agent_id,id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE `managed_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`related_user_id` text,
	`producer` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`storage_backend` text DEFAULT 'local' NOT NULL,
	`storage_key` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`retention_policy` text DEFAULT 'task' NOT NULL,
	`retention_expires_at` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`plugin_id` text,
	"operation_id" text,
	`invocation_id` text,
	`invocation_source` text,
	`invocation_subject_id` text,
	`message_id` text
, agent_id TEXT NOT NULL REFERENCES luna_agents(id), shadow_id TEXT NOT NULL REFERENCES agent_shadows(id));
--> statement-breakpoint
CREATE TABLE memory_consolidations (
 agent_id TEXT PRIMARY KEY NOT NULL REFERENCES luna_agents(id),
 session_id TEXT NOT NULL,
 change_seq INTEGER NOT NULL,
 covered_from INTEGER NOT NULL DEFAULT 0,
 command_id TEXT,
 ran_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE memory_injected_entries (
 runner_context_id TEXT NOT NULL,
 memory_id TEXT NOT NULL,
 PRIMARY KEY (runner_context_id, memory_id)
);
--> statement-breakpoint
CREATE TABLE memory_injection_cursors (
 runner_context_id TEXT PRIMARY KEY NOT NULL,
 runner_session_id TEXT NOT NULL,
 injected_through INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE memory_reflection_checkpoints (
 session_id TEXT PRIMARY KEY NOT NULL,
 reflected_through INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`mention_key` text NOT NULL,
	`mention_label` text NOT NULL,
	`target_identity_id` text,
	`target_external_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`raw_mention_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_identity_id`) REFERENCES `channel_identities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`external_message_id` text NOT NULL,
	`sender_user_id` text NOT NULL,
	`sender_identity_id` text,
	`role` text NOT NULL,
	`content_kind` text NOT NULL,
	`presentation_kind` text NOT NULL,
	`provider_message_type` text,
	`content_json` text NOT NULL,
	`raw_payload_json` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL
, owner_session_id TEXT, deleted_at INTEGER, agent_id TEXT NOT NULL REFERENCES luna_agents(id), shadow_id TEXT NOT NULL REFERENCES agent_shadows(id), binding_id TEXT REFERENCES shadow_bot_bindings(id));
--> statement-breakpoint
CREATE TABLE native_progress_deliveries (
  id text PRIMARY KEY NOT NULL,
  channel_id text NOT NULL,
  message_id text,
  state text NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`task_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`message_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`outbound_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_invocation_audits" (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	"operation_id" text NOT NULL,
	`provider_type` text NOT NULL,
	`plugin_id` text,
	`subject_type` text,
	`subject_id` text,
	`source` text NOT NULL,
	`session_id` text,
	`task_id` text,
	`message_id` text,
	`status` text NOT NULL,
	`error_code` text,
	`artifact_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer,
	`expires_at` integer NOT NULL
, authorization_json text, agent_id TEXT NOT NULL REFERENCES luna_agents(id), shadow_id TEXT NOT NULL REFERENCES agent_shadows(id));
--> statement-breakpoint
CREATE TABLE `plugin_installations` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`desired_state` text DEFAULT 'disabled' NOT NULL,
	`desired_version` text,
	`desired_release_sha256` text,
	`desired_installed_path` text,
	`active_state` text DEFAULT 'disabled' NOT NULL,
	`active_version` text,
	`active_release_sha256` text,
	`active_installed_path` text,
	`pending_action` text DEFAULT 'none' NOT NULL,
	`last_activated_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `plugin_marketplaces` (
	`id` text PRIMARY KEY NOT NULL,
	`git_url` text NOT NULL,
	`branch` text NOT NULL,
	`local_path` text NOT NULL,
	`last_commit` text,
	`last_fetched_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `plugin_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`marketplace_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`version` text NOT NULL,
	`release_path` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`plugin_js_sha256` text NOT NULL,
	`release_sha256` text NOT NULL,
	`luna_api_version` text NOT NULL,
	`marketplace_commit` text,
	`validation_status` text DEFAULT 'valid' NOT NULL,
	`validation_error` text,
	`discovered_at` integer NOT NULL,
	`package_sha256` text,
	`manifest_json` text
);
--> statement-breakpoint
CREATE TABLE runner_context_origins (context_id TEXT PRIMARY KEY NOT NULL, runtime_id TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE `runner_context_seed_records` (
	`id` text PRIMARY KEY NOT NULL,
	`runner_context_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`seed_context_pack_id` text NOT NULL,
	`seed_hash` text NOT NULL,
	`seed_entry_ids_json` text NOT NULL,
	`seed_context_item_ids_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runner_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`runner_type` text NOT NULL,
	`runner_session_id` text,
	`runner_root_path` text NOT NULL,
	`last_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`instruction_fingerprint` text,
	`provider_fingerprint` text,
	`model_fingerprint` text
, agent_id TEXT NOT NULL REFERENCES luna_agents(id), shadow_id TEXT NOT NULL REFERENCES agent_shadows(id));
--> statement-breakpoint
CREATE TABLE runner_invocations (
 invocation_id TEXT PRIMARY KEY NOT NULL,
 runner_kind TEXT NOT NULL, actor_user_id TEXT NOT NULL, runner_context_id TEXT NOT NULL,
 session_id TEXT, task_id TEXT, task_run_id TEXT, origin_id TEXT NOT NULL,
 state TEXT NOT NULL, input_snapshot_json TEXT NOT NULL, context_pack_ids_json TEXT NOT NULL,
 token_id TEXT, active_job_id TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER,
 settled_at INTEGER, revoke_reason TEXT
, agent_id TEXT NOT NULL REFERENCES luna_agents(id), shadow_id TEXT NOT NULL REFERENCES agent_shadows(id), agent_config_json TEXT);
--> statement-breakpoint
CREATE TABLE runner_jobs (
 job_id TEXT PRIMARY KEY NOT NULL, runtime_id TEXT NOT NULL,
 invocation_id TEXT NOT NULL REFERENCES runner_invocations(invocation_id),
 request_json TEXT NOT NULL, request_hash TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL, last_event_json TEXT, terminal_sequence INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
, provider_state_json TEXT, credentials_revision INTEGER NOT NULL DEFAULT 0, credentials_hash TEXT);
--> statement-breakpoint
CREATE TABLE runner_operations (
 id TEXT PRIMARY KEY NOT NULL,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 origin_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 request_json TEXT NOT NULL,
 context_json TEXT NOT NULL,
 status TEXT NOT NULL,
 result_json TEXT,
 error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE runner_resource_snapshots (
 digest TEXT PRIMARY KEY NOT NULL,
 agent_id TEXT NOT NULL,
 shadow_id TEXT NOT NULL,
 selection_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 FOREIGN KEY(agent_id,shadow_id) REFERENCES agent_shadows(agent_id,id),
 CHECK(json_valid(selection_json) AND json_type(selection_json,'$.digest') IS 'text' AND json_extract(selection_json,'$.digest')=digest)
);
--> statement-breakpoint
CREATE TABLE schedule_deletions (schedule_id TEXT PRIMARY KEY NOT NULL, deleted_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE schedule_occurrences(id TEXT PRIMARY KEY NOT NULL,schedule_id TEXT NOT NULL,scheduled_at INTEGER NOT NULL,revision INTEGER NOT NULL,command_id TEXT,status TEXT NOT NULL,reason TEXT,snapshot TEXT NOT NULL,created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE session_channel_bindings (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, channel_type TEXT NOT NULL, channel_id TEXT NOT NULL, surface_id TEXT NOT NULL, thread_id TEXT, root_message_id TEXT);
--> statement-breakpoint
CREATE TABLE session_channel_deliveries (id TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL,binding_id TEXT NOT NULL,channel_id TEXT NOT NULL,inbound TEXT NOT NULL,operation TEXT NOT NULL,receipt TEXT,status TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE session_commands(id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,session_id TEXT NOT NULL,source_session_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,origin_id TEXT NOT NULL,dedupe_key TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,error TEXT,message_id TEXT,provider_message_id TEXT,correlation_id TEXT NOT NULL,hops INTEGER NOT NULL DEFAULT 3,available_at INTEGER NOT NULL,expires_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0,claim TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE session_deletions (
 session_id TEXT PRIMARY KEY NOT NULL,
 deleted_at INTEGER NOT NULL,
 pending_paths TEXT NOT NULL DEFAULT '[]'
, pending_execution TEXT NOT NULL DEFAULT '[]', agent_id TEXT REFERENCES luna_agents(id));
--> statement-breakpoint
CREATE TABLE `session_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sender_identity_id` text,
	`received_at` integer NOT NULL,
	`status` text NOT NULL,
	`turn_id` text,
	`claimed_at` integer,
	`completed_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE session_reply_dispatches (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,signature TEXT NOT NULL,receipt TEXT,created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE `session_runner_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`runner_context_id` text,
	`runner_type` text NOT NULL,
	`runner_session_id` text,
	`attempt_kind` text NOT NULL,
	`attempt_index` integer NOT NULL,
	`status` text NOT NULL,
	`input_prompt` text NOT NULL,
	`raw_output` text,
	`raw_output_truncated` integer NOT NULL,
	`parsed_action_json` text,
	`parse_error_json` text,
	`repair_source_attempt_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE session_schedules(id TEXT PRIMARY KEY NOT NULL,actor_user_id TEXT NOT NULL,source_session_id TEXT NOT NULL,target_session_id TEXT NOT NULL,action TEXT NOT NULL,timezone TEXT NOT NULL,next_at INTEGER NOT NULL,interval_ms INTEGER,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,overlap TEXT NOT NULL,misfire TEXT NOT NULL,expires_after_ms INTEGER NOT NULL,created_at INTEGER NOT NULL, title text NOT NULL DEFAULT '', paused integer NOT NULL DEFAULT 0, recurrence text);
--> statement-breakpoint
CREATE TABLE `session_states` (
	`session_id` text PRIMARY KEY NOT NULL,
	`clarification_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_surface_aliases` (
	`alias_key` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_timeline_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`entry_kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_timeline_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`event_type` text NOT NULL,
	`control_kind` text NOT NULL,
	`reason_kind` text NOT NULL,
	`source_message_id` text NOT NULL,
	`anchor_message_id` text NOT NULL,
	`session_source_message_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`summary` text NOT NULL,
	`payload_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE session_triggers (
 id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
 dedupe_key TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_turn_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_kind` text NOT NULL,
	`status` text NOT NULL,
	`runner_invoked` integer NOT NULL,
	`reason` text NOT NULL,
	`materialized_prompt` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`surface_key` text,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`group_id` text,
	`root_message_key` text,
	`thread_key` text,
	`parent_session_id` text,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_activity_at` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL DEFAULT 'main'
, bot_user_id TEXT REFERENCES users(id), agent_id TEXT NOT NULL REFERENCES luna_agents(id), shadow_id TEXT NOT NULL REFERENCES agent_shadows(id), binding_id TEXT REFERENCES shadow_bot_bindings(id));
--> statement-breakpoint
CREATE TABLE shadow_bot_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES luna_agents(id),
  shadow_id TEXT NOT NULL,
  channel_config_id TEXT NOT NULL REFERENCES channel_configs(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  FOREIGN KEY(agent_id,shadow_id) REFERENCES agent_shadows(agent_id,id),
  FOREIGN KEY(agent_id,channel_config_id) REFERENCES channel_configs(agent_id,id),
  CHECK((status='active' AND retired_at IS NULL) OR (status='retired' AND retired_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `shadow_model_selections` (
  `shadow_id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `mode` text NOT NULL,
  `profile_id` text,
  `revision_id` text,
  `updated_by_account_id` text NOT NULL REFERENCES accounts(id),
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`agent_id`,`shadow_id`) REFERENCES `agent_shadows`(`agent_id`,`id`),
  FOREIGN KEY (`agent_id`,`profile_id`) REFERENCES `agent_profiles`(`agent_id`,`id`),
  FOREIGN KEY (`profile_id`,`revision_id`) REFERENCES `agent_profile_revisions`(`profile_id`,`id`),
  CONSTRAINT `shadow_model_selection_mode` CHECK ((`mode`='inherit' AND `profile_id` IS NULL AND `revision_id` IS NULL) OR (`mode`='fixed' AND `profile_id` IS NOT NULL AND `revision_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE shadow_root_access (
 shadow_id TEXT PRIMARY KEY NOT NULL,
 agent_id TEXT NOT NULL,
 enabled INTEGER NOT NULL,
 updated_by_account_id TEXT NOT NULL REFERENCES accounts(id),
 updated_at INTEGER NOT NULL,
 FOREIGN KEY (agent_id, shadow_id) REFERENCES agent_shadows(agent_id, id)
);
--> statement-breakpoint
CREATE TABLE `shadow_worker_routing` (
  `shadow_id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `mode` text NOT NULL,
  `worker_id` text,
  `updated_by_account_id` text NOT NULL REFERENCES accounts(id),
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`agent_id`,`shadow_id`) REFERENCES `agent_shadows`(`agent_id`,`id`),
  FOREIGN KEY (`agent_id`,`worker_id`) REFERENCES `agent_worker_access`(`agent_id`,`worker_id`),
  CONSTRAINT `shadow_worker_routing_mode` CHECK ((`mode`='automatic' AND `worker_id` IS NULL) OR (`mode`='bound' AND `worker_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE task_deletions (task_id TEXT PRIMARY KEY NOT NULL, deleted_at INTEGER NOT NULL, pending_paths TEXT NOT NULL DEFAULT '[]', pending_execution TEXT NOT NULL DEFAULT '[]', agent_id TEXT REFERENCES luna_agents(id));
--> statement-breakpoint
CREATE TABLE `task_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_report_commands` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `task_run_id` text NOT NULL REFERENCES `task_runs`(`id`) ON DELETE CASCADE,
  `request_id` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `content` text NOT NULL,
  `report_artifact_id` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_run_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`task_run_id` text NOT NULL,
	`run_index` integer NOT NULL,
	`subscription_id` text NOT NULL,
	`session_id` text NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`group_id` text,
	`thread_key` text,
	`root_message_key` text,
	`surface_key` text,
	`status_message_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, status_card_style text NOT NULL DEFAULT 'card');
--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_index` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`input_snapshot` text NOT NULL,
	`materialized_prompt` text,
	`runner_type` text NOT NULL,
	`runner_context_id` text,
	`source_message_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`cancel_reason` text,
	`error` text,
	`final_report_artifact_id` text
);
--> statement-breakpoint
CREATE TABLE `task_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`group_id` text,
	`thread_key` text,
	`root_message_key` text,
	`surface_key` text,
	`visibility` text NOT NULL,
	`notification_level` text DEFAULT 'major_updates' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, status_card_style text NOT NULL DEFAULT 'card');
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`status` text NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`severity` text,
	`creator_user_id` text,
	`primary_session_id` text,
	`source_message_id` text,
	`source_entry_id` text,
	`context_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`block_reason` text
, agent_id TEXT NOT NULL REFERENCES luna_agents(id), shadow_id TEXT NOT NULL REFERENCES agent_shadows(id));
--> statement-breakpoint
CREATE TABLE `timeline_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text,
	`message_id` text,
	`actor_user_id` text,
	`source_message_id` text,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`data` text,
	`visibility` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL REFERENCES luna_agents(id),
	`user_id` text NOT NULL,
	`identity_namespace` text NOT NULL,
	`identity_kind` text NOT NULL,
	`identity_value` text NOT NULL,
	`identity_scope` text DEFAULT '' NOT NULL,
	`confidence` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL REFERENCES luna_agents(id),
	`account_id` text REFERENCES accounts(id),
	`kind` text NOT NULL CHECK(`kind` IN ('human','bot','shadow','system')),
	`display_name` text NOT NULL,
	`avatar_url` text,
	`status` text DEFAULT 'active' NOT NULL CHECK(`status` IN ('active','blocked','removed','merged')),
	`merged_into_user_id` text,
	`profile_source` text DEFAULT 'channel' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	UNIQUE(`agent_id`,`id`),
	CHECK(`account_id` IS NULL OR `kind`='human')
);
--> statement-breakpoint
CREATE INDEX `access_tokens_runner_job_idx` ON `access_tokens` (`source_runner_job_id`);
--> statement-breakpoint
CREATE INDEX `access_tokens_source_expires_at_idx` ON `access_tokens` (`source`,`expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_token_hash_idx` ON `access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `access_tokens_user_source_idx` ON `access_tokens` (`user_id`,`source`);
--> statement-breakpoint
CREATE INDEX `access_tokens_account_source_idx` ON `access_tokens` (`account_id`,`source`);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_lifecycle_actor_key ON agent_lifecycle_jobs(actor_account_id,idempotency_key);
--> statement-breakpoint
CREATE INDEX agent_lifecycle_pending ON agent_lifecycle_jobs(status,agent_id);
--> statement-breakpoint
CREATE INDEX agent_memories_agent_status_idx ON agent_memories (agent_id, status, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_memories_change_seq_idx ON agent_memories (change_seq);
--> statement-breakpoint
CREATE INDEX agent_memories_timeline_idx ON agent_memories (agent_id, occurred_at) WHERE type = 'episode';
--> statement-breakpoint
CREATE UNIQUE INDEX agent_profile_revisions_profile_id ON agent_profile_revisions(profile_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profile_revisions_profile_number_unique` ON `agent_profile_revisions` (`profile_id`,`revision_number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profile_secrets_revision_key_unique` ON `agent_profile_secrets` (`revision_id`,`env_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_profiles_scope_id ON agent_profiles(agent_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_profiles_type_name_unique ON agent_profiles(agent_id,agent_type,name);
--> statement-breakpoint
CREATE INDEX authorization_rules_operation_idx ON authorization_rules(target);
--> statement-breakpoint
CREATE INDEX authorization_rules_subject_idx ON authorization_rules(subject_type,subject_id);
--> statement-breakpoint
CREATE UNIQUE INDEX authorization_rules_unique ON authorization_rules(scope_type,coalesce(agent_id,''),subject_type,subject_id,target,match_type,effect);
--> statement-breakpoint
CREATE INDEX `channel_auth_tokens_purpose_expires_at_idx` ON `channel_auth_tokens` (`purpose`,`expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_auth_tokens_token_hash_idx` ON `channel_auth_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `channel_auth_tokens_user_purpose_idx` ON `channel_auth_tokens` (`user_id`,`purpose`);
--> statement-breakpoint
CREATE UNIQUE INDEX channel_configs_agent_id ON channel_configs(agent_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_identities_channel_external_unique` ON `channel_identities` (`channel_type`,`channel_id`,`external_id`);
--> statement-breakpoint
CREATE INDEX `channel_identities_kind_idx` ON `channel_identities` (`identity_kind`);
--> statement-breakpoint
CREATE INDEX `channel_message_markers_channel_idx` ON `channel_message_markers` (`channel_type`,`channel_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_message_markers_unique` ON `channel_message_markers` (`channel_type`,`channel_id`,`message_id`,`marker_type`);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_surfaces_channel_external_unique` ON `channel_surfaces` (`channel_type`,`channel_id`,`external_id`);
--> statement-breakpoint
CREATE INDEX `channel_surfaces_kind_idx` ON `channel_surfaces` (`surface_kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_auth_sessions_device_code_hash_idx` ON `cli_auth_sessions` (`device_code_hash`);
--> statement-breakpoint
CREATE INDEX `cli_auth_sessions_status_expires_at_idx` ON `cli_auth_sessions` (`status`,`expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_auth_sessions_user_code_hash_idx` ON `cli_auth_sessions` (`user_code_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_pack_items_pack_item_role_unique` ON `context_pack_items` (`context_pack_id`,`item_kind`,`item_id`,`role`);
--> statement-breakpoint
CREATE INDEX `context_pack_items_pack_role_idx` ON `context_pack_items` (`context_pack_id`,`role`,`display_order`);
--> statement-breakpoint
CREATE INDEX `context_pack_items_source_entry_idx` ON `context_pack_items` (`source_session_id`,`source_entry_id`);
--> statement-breakpoint
CREATE INDEX `context_pack_items_source_message_idx` ON `context_pack_items` (`source_message_id`,`role`);
--> statement-breakpoint
CREATE INDEX `context_packs_owner_idx` ON `context_packs` (`owner_type`,`owner_id`,`kind`,`created_at`);
--> statement-breakpoint
CREATE INDEX `context_packs_trigger_entry_idx` ON `context_packs` (`trigger_entry_id`);
--> statement-breakpoint
CREATE INDEX deleted_task_references_session_idx ON deleted_task_references(session_id);
--> statement-breakpoint
CREATE UNIQUE INDEX direct_recipient_address ON direct_recipients(channel_id,id_type,recipient_id,session_id);
--> statement-breakpoint
CREATE INDEX `group_memberships_group_idx` ON `group_memberships` (`group_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_memberships_unique` ON `group_memberships` (`group_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `group_memberships_user_idx` ON `group_memberships` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX groups_slug_unique ON groups(agent_id,slug);
--> statement-breakpoint
CREATE INDEX `groups_status_idx` ON `groups` (`status`);
--> statement-breakpoint
CREATE INDEX invocation_resources_digest ON invocation_resource_snapshots(digest);
--> statement-breakpoint
CREATE INDEX luna_agents_owner_idx ON luna_agents(owner_account_id);
--> statement-breakpoint
CREATE INDEX `managed_artifacts_invocation_idx` ON `managed_artifacts` (`invocation_id`);
--> statement-breakpoint
CREATE INDEX managed_artifacts_operation_idx ON managed_artifacts(operation_id);
--> statement-breakpoint
CREATE INDEX `managed_artifacts_plugin_idx` ON `managed_artifacts` (`plugin_id`);
--> statement-breakpoint
CREATE INDEX `managed_artifacts_related_user_idx` ON `managed_artifacts` (`related_user_id`);
--> statement-breakpoint
CREATE INDEX `managed_artifacts_scope_idx` ON `managed_artifacts` (`scope_type`,`scope_id`);
--> statement-breakpoint
CREATE INDEX `managed_artifacts_status_idx` ON `managed_artifacts` (`status`);
--> statement-breakpoint
CREATE INDEX `message_mentions_message_idx` ON `message_mentions` (`message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_mentions_unique` ON `message_mentions` (`message_id`,`mention_key`,`mention_label`,`target_external_id`,`target_kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX messages_channel_external_role_unique ON messages(agent_id,shadow_id,coalesce(binding_id,''),channel_type,channel_id,external_message_id,role);
--> statement-breakpoint
CREATE INDEX `messages_channel_sender_created_idx` ON `messages` (`channel_type`,`channel_id`,`sender_user_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX messages_owner_session_idx ON messages(owner_session_id);
--> statement-breakpoint
CREATE UNIQUE INDEX native_progress_channel_message ON native_progress_deliveries(channel_id, message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_attempts_idempotency_key_unique` ON `notification_attempts` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX operation_invocation_audits_expires_idx ON operation_invocation_audits(expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX operation_invocation_audits_invocation_unique ON operation_invocation_audits(invocation_id);
--> statement-breakpoint
CREATE INDEX operation_invocation_audits_operation_idx ON operation_invocation_audits(operation_id);
--> statement-breakpoint
CREATE INDEX operation_invocation_audits_plugin_idx ON operation_invocation_audits(plugin_id);
--> statement-breakpoint
CREATE INDEX operation_invocation_audits_subject_idx ON operation_invocation_audits(subject_type,subject_id);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_releases_marketplace_plugin_version_unique` ON `plugin_releases` (`marketplace_id`, `plugin_id`, `version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_context_seed_records_context_pack_unique` ON `runner_context_seed_records` (`runner_context_id`,`seed_context_pack_id`);
--> statement-breakpoint
CREATE INDEX `runner_context_seed_records_owner_idx` ON `runner_context_seed_records` (`owner_type`,`owner_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_contexts_owner_runner_unique` ON `runner_contexts` (`owner_type`,`owner_id`,`runner_type`);
--> statement-breakpoint
CREATE INDEX runner_invocations_session_idx ON runner_invocations(session_id);
--> statement-breakpoint
CREATE INDEX runner_invocations_state_idx ON runner_invocations(state);
--> statement-breakpoint
CREATE INDEX runner_invocations_task_idx ON runner_invocations(task_id);
--> statement-breakpoint
CREATE INDEX runner_jobs_invocation_idx ON runner_jobs(invocation_id);
--> statement-breakpoint
CREATE INDEX runner_jobs_state_idx ON runner_jobs(state);
--> statement-breakpoint
CREATE INDEX runner_operations_pending_idx ON runner_operations(status);
--> statement-breakpoint
CREATE UNIQUE INDEX runner_operations_request_unique ON runner_operations(session_id, origin_id, request_id);
--> statement-breakpoint
CREATE UNIQUE INDEX schedule_occurrence_unique ON schedule_occurrences(schedule_id,revision,scheduled_at);
--> statement-breakpoint
CREATE UNIQUE INDEX session_channel_binding_unique ON session_channel_bindings(session_id,channel_id);
--> statement-breakpoint
CREATE UNIQUE INDEX session_channel_delivery_unique ON session_channel_deliveries(dispatch_id,binding_id);
--> statement-breakpoint
CREATE UNIQUE INDEX session_commands_dedupe ON session_commands(dedupe_key);
--> statement-breakpoint
CREATE INDEX session_commands_pending ON session_commands(status,available_at);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_inbox_entry_unique` ON `session_inbox` (`entry_id`);
--> statement-breakpoint
CREATE INDEX `session_inbox_queue_idx` ON `session_inbox` (`session_id`,`status`,`received_at`);
--> statement-breakpoint
CREATE INDEX `session_inbox_turn_idx` ON `session_inbox` (`turn_id`);
--> statement-breakpoint
CREATE INDEX `session_runner_attempts_repair_source_idx` ON `session_runner_attempts` (`repair_source_attempt_id`);
--> statement-breakpoint
CREATE INDEX `session_runner_attempts_session_idx` ON `session_runner_attempts` (`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `session_runner_attempts_turn_idx` ON `session_runner_attempts` (`turn_id`,`attempt_index`);
--> statement-breakpoint
CREATE INDEX `session_timeline_entries_message_idx` ON `session_timeline_entries` (`message_id`);
--> statement-breakpoint
CREATE INDEX `session_timeline_entries_session_created_idx` ON `session_timeline_entries` (`session_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_timeline_entries_unique` ON `session_timeline_entries` (`session_id`,`message_id`,`entry_kind`);
--> statement-breakpoint
CREATE INDEX `session_timeline_events_session_created_idx` ON `session_timeline_events` (`session_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_timeline_events_source_control_unique` ON `session_timeline_events` (`session_id`,`source_message_id`,`control_kind`,`reason_kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX session_triggers_dedupe ON session_triggers(dedupe_key);
--> statement-breakpoint
CREATE INDEX `session_turn_entries_entry_idx` ON `session_turn_entries` (`entry_id`);
--> statement-breakpoint
CREATE INDEX `session_turn_entries_turn_idx` ON `session_turn_entries` (`turn_id`);
--> statement-breakpoint
CREATE INDEX `session_turns_session_idx` ON `session_turns` (`session_id`,`started_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_surface_key_unique` ON `sessions` (`surface_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX sessions_surface_unique ON sessions(binding_id,channel_type,channel_id,group_id,root_message_key,thread_key);
--> statement-breakpoint
CREATE UNIQUE INDEX shadow_bot_bindings_active_channel ON shadow_bot_bindings(channel_config_id) WHERE status='active';
--> statement-breakpoint
CREATE UNIQUE INDEX shadow_bot_bindings_active_shadow ON shadow_bot_bindings(shadow_id) WHERE status='active';
--> statement-breakpoint
CREATE UNIQUE INDEX shadow_bot_bindings_revision ON shadow_bot_bindings(channel_config_id,revision);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_participants_task_user_role_unique` ON `task_participants` (`task_id`,`user_id`,`role`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_report_commands_run_unique` ON `task_report_commands` (`task_run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_run_notifications_channel_message_unique` ON `task_run_notifications` (`channel_type`,`channel_id`,`status_message_id`) WHERE `status_message_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `task_run_notifications_run_subscription_unique` ON `task_run_notifications` (`task_run_id`,`subscription_id`);
--> statement-breakpoint
CREATE INDEX `task_run_notifications_subscription_idx` ON `task_run_notifications` (`subscription_id`);
--> statement-breakpoint
CREATE INDEX `task_run_notifications_task_idx` ON `task_run_notifications` (`task_id`);
--> statement-breakpoint
CREATE INDEX `task_run_notifications_task_run_idx` ON `task_run_notifications` (`task_run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_one_running_per_task_unique` ON `task_runs` (`task_id`) WHERE `status` = 'running';
--> statement-breakpoint
CREATE INDEX `task_runs_task_id_idx` ON `task_runs` (`task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_task_run_index_unique` ON `task_runs` (`task_id`,`run_index`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_task_source_reason_unique` ON `task_runs` (`task_id`,`source_message_id`,`reason`);
--> statement-breakpoint
CREATE INDEX `task_runs_task_status_idx` ON `task_runs` (`task_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_subscriptions_task_surface_unique` ON `task_subscriptions` (`task_id`,`surface_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `timeline_events_task_message_type_unique` ON `timeline_events` (`task_id`,`message_id`,`type`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identity_links_identity_unique` ON `user_identity_links` (`agent_id`,`identity_namespace`,`identity_kind`,`identity_value`,`identity_scope`);
--> statement-breakpoint
CREATE INDEX `user_identity_links_user_idx` ON `user_identity_links` (`user_id`);
--> statement-breakpoint
CREATE INDEX `users_agent_idx` ON `users` (`agent_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_agent_account_unique` ON `users` (`agent_id`,`account_id`) WHERE `account_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `users_merged_into_idx` ON `users` (`merged_into_user_id`);
--> statement-breakpoint
CREATE TRIGGER agent_plugin_config_scope_immutable BEFORE UPDATE OF agent_id,plugin_id ON agent_plugin_configs
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.plugin_id IS NOT NEW.plugin_id
BEGIN SELECT RAISE(ABORT,'plugin_config_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER agent_profiles_immutable_scope BEFORE UPDATE OF agent_id ON agent_profiles
WHEN OLD.agent_id IS NOT NEW.agent_id
BEGIN SELECT RAISE(ABORT,'profile_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER agent_worker_access_scope_immutable BEFORE UPDATE OF agent_id,worker_id ON agent_worker_access
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.worker_id IS NOT NEW.worker_id
BEGIN SELECT RAISE(ABORT,'agent_worker_access_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER artifacts_reject_deleted_task BEFORE INSERT ON artifacts
WHEN EXISTS (SELECT 1 FROM task_deletions WHERE task_id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'Task has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER command_trigger_insert AFTER INSERT ON session_commands WHEN NEW.kind='session.invoke' BEGIN
 INSERT INTO session_triggers(id,session_id,kind,dedupe_key,payload_json,status,error,created_at,updated_at)
 VALUES(NEW.id,NEW.session_id,'session_trigger','session_trigger:'||NEW.id,json_object('commandId',NEW.id),NEW.status,NEW.error,NEW.created_at,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER command_trigger_update AFTER UPDATE ON session_commands WHEN NEW.kind='session.invoke' BEGIN
 UPDATE session_triggers SET status=NEW.status,error=NEW.error,updated_at=NEW.updated_at WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER deleted_message_immutable BEFORE UPDATE ON messages
WHEN OLD.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Deleted message cannot be modified'); END;
--> statement-breakpoint
CREATE TRIGGER invocation_resource_immutable BEFORE UPDATE ON invocation_resource_snapshots
BEGIN SELECT RAISE(ABORT,'invocation_resource_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER invocation_resource_retain BEFORE DELETE ON invocation_resource_snapshots
WHEN EXISTS(SELECT 1 FROM runner_invocations WHERE invocation_id=OLD.invocation_id AND settled_at IS NULL)
BEGIN SELECT RAISE(ABORT,'invocation_resource_still_referenced'); END;
--> statement-breakpoint
CREATE TRIGGER invocation_resource_scope BEFORE INSERT ON invocation_resource_snapshots
WHEN NOT EXISTS(SELECT 1 FROM runner_invocations i JOIN runner_resource_snapshots s
 ON i.agent_id=s.agent_id AND i.shadow_id=s.shadow_id
 WHERE i.invocation_id=NEW.invocation_id AND s.digest=NEW.digest AND i.state='active' AND i.settled_at IS NULL)
BEGIN SELECT RAISE(ABORT,'invocation_resource_scope_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER managed_artifacts_immutable_scope BEFORE UPDATE OF agent_id,shadow_id ON managed_artifacts
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.shadow_id IS NOT NEW.shadow_id
BEGIN SELECT RAISE(ABORT,'artifact_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER managed_artifacts_reject_deleted_session BEFORE INSERT ON managed_artifacts
WHEN NEW.scope_type = 'session' AND EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER managed_artifacts_reject_deleted_task BEFORE INSERT ON managed_artifacts
WHEN NEW.scope_type = 'task' AND EXISTS (SELECT 1 FROM task_deletions WHERE task_id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'Task has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER managed_artifacts_validate_owner BEFORE INSERT ON managed_artifacts
WHEN NOT (
  (NEW.scope_type='session' AND EXISTS(SELECT 1 FROM sessions WHERE id=NEW.scope_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id)) OR
  (NEW.scope_type='task' AND EXISTS(SELECT 1 FROM tasks WHERE id=NEW.scope_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id))
)
BEGIN SELECT RAISE(ABORT,'artifact_owner_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER managed_artifacts_validate_owner_update BEFORE UPDATE OF scope_type,scope_id ON managed_artifacts
WHEN NOT (
  (NEW.scope_type='session' AND EXISTS(SELECT 1 FROM sessions WHERE id=NEW.scope_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id)) OR
  (NEW.scope_type='task' AND EXISTS(SELECT 1 FROM tasks WHERE id=NEW.scope_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id))
)
BEGIN SELECT RAISE(ABORT,'artifact_owner_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER message_owner_from_first_entry AFTER INSERT ON session_timeline_entries
WHEN NEW.entry_kind = 'message'
BEGIN
 UPDATE messages SET owner_session_id = NEW.session_id WHERE id = NEW.message_id AND owner_session_id IS NULL AND deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER messages_immutable_scope BEFORE UPDATE OF agent_id,shadow_id,binding_id ON messages
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.shadow_id IS NOT NEW.shadow_id OR OLD.binding_id IS NOT NEW.binding_id
BEGIN SELECT RAISE(ABORT,'message_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER messages_reject_deleted_session BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.owner_session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER messages_validate_owner BEFORE UPDATE OF owner_session_id ON messages
WHEN NEW.owner_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.owner_session_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id AND binding_id IS NEW.binding_id)
BEGIN SELECT RAISE(ABORT,'message_owner_scope_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER messages_validate_scope BEFORE INSERT ON messages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agent_shadows WHERE id=NEW.shadow_id AND agent_id=NEW.agent_id)
 THEN RAISE(ABORT,'message_scope_mismatch') END;
 SELECT CASE WHEN NEW.binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shadow_bot_bindings WHERE id=NEW.binding_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id)
 THEN RAISE(ABORT,'message_binding_mismatch') END;
 SELECT CASE WHEN NEW.owner_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.owner_session_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id AND binding_id IS NEW.binding_id)
 THEN RAISE(ABORT,'message_owner_scope_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER occurrences_reject_deleted_schedule BEFORE INSERT ON schedule_occurrences
WHEN EXISTS (SELECT 1 FROM schedule_deletions WHERE schedule_id = NEW.schedule_id)
BEGIN SELECT RAISE(ABORT, 'Schedule has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER operation_audit_scope BEFORE INSERT ON operation_invocation_audits
WHEN NOT EXISTS(SELECT 1 FROM agent_shadows WHERE id=NEW.shadow_id AND agent_id=NEW.agent_id)
BEGIN SELECT RAISE(ABORT,'operation_audit_scope_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER operation_audit_scope_immutable BEFORE UPDATE OF agent_id,shadow_id ON operation_invocation_audits
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.shadow_id IS NOT NEW.shadow_id
BEGIN SELECT RAISE(ABORT,'operation_audit_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER runner_contexts_immutable_owner BEFORE UPDATE OF agent_id,shadow_id,owner_type,owner_id ON runner_contexts
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.shadow_id IS NOT NEW.shadow_id OR OLD.owner_type IS NOT NEW.owner_type OR OLD.owner_id IS NOT NEW.owner_id
BEGIN SELECT RAISE(ABORT,'runner_context_owner_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER runner_contexts_reject_deleted_session BEFORE INSERT ON runner_contexts
WHEN NEW.owner_type = 'session' AND EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.owner_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER runner_contexts_reject_deleted_task BEFORE INSERT ON runner_contexts
WHEN NEW.owner_type = 'task' AND EXISTS (SELECT 1 FROM task_deletions WHERE task_id = NEW.owner_id)
BEGIN SELECT RAISE(ABORT, 'Task has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER runner_contexts_validate_owner BEFORE INSERT ON runner_contexts
WHEN NOT (
  (NEW.owner_type='session' AND EXISTS(SELECT 1 FROM sessions WHERE id=NEW.owner_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id)) OR
  (NEW.owner_type='task' AND EXISTS(SELECT 1 FROM tasks WHERE id=NEW.owner_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id))
)
BEGIN SELECT RAISE(ABORT,'runner_context_owner_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER runner_invocation_config_immutable BEFORE UPDATE OF agent_config_json ON runner_invocations
WHEN OLD.agent_config_json IS NOT NEW.agent_config_json
BEGIN SELECT RAISE(ABORT,'invocation_config_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER runner_invocation_config_scope BEFORE INSERT ON runner_invocations
WHEN NEW.agent_config_json IS NOT NULL AND (
 json_extract(NEW.agent_config_json,'$.agentId') IS NOT NEW.agent_id OR
 NOT EXISTS (
  SELECT 1 FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id
  WHERE p.agent_id=NEW.agent_id AND p.id=json_extract(NEW.agent_config_json,'$.profileId')
  AND r.id=json_extract(NEW.agent_config_json,'$.revisionId') AND p.deleted_at IS NULL
  AND r.validation_state='validated' AND p.agent_type=json_extract(NEW.agent_config_json,'$.agentType')
  AND r.model=json_extract(NEW.agent_config_json,'$.model')
  AND r.config_fingerprint=json_extract(NEW.agent_config_json,'$.configFingerprint')
 ))
BEGIN SELECT RAISE(ABORT,'invocation_config_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER runner_invocations_immutable_scope BEFORE UPDATE OF agent_id,shadow_id,runner_context_id,session_id,task_id,task_run_id,actor_user_id ON runner_invocations
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.shadow_id IS NOT NEW.shadow_id OR OLD.runner_context_id IS NOT NEW.runner_context_id OR OLD.session_id IS NOT NEW.session_id OR OLD.task_id IS NOT NEW.task_id OR OLD.task_run_id IS NOT NEW.task_run_id OR OLD.actor_user_id IS NOT NEW.actor_user_id
BEGIN SELECT RAISE(ABORT,'invocation_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER runner_resource_snapshot_immutable BEFORE UPDATE ON runner_resource_snapshots
BEGIN SELECT RAISE(ABORT,'resource_snapshot_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER session_channel_bindings_reject_deleted_session BEFORE INSERT ON session_channel_bindings
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_commands_reject_deleted_session BEFORE INSERT ON session_commands
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_commands_reject_deleted_source BEFORE INSERT ON session_commands
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.source_session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_inbox_reject_deleted_session BEFORE INSERT ON session_inbox
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_inbox_trigger_insert AFTER INSERT ON session_inbox BEGIN
 INSERT INTO session_triggers(id,session_id,kind,dedupe_key,payload_json,status,error,created_at,updated_at)
 VALUES(NEW.id,NEW.session_id,'user_messages','user_messages:'||NEW.entry_id,json_object('inboxId',NEW.id,'entryId',NEW.entry_id),CASE NEW.status WHEN 'claimed' THEN 'running' ELSE NEW.status END,NEW.error,NEW.created_at,NEW.updated_at)
 ON CONFLICT(dedupe_key) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER session_inbox_trigger_update AFTER UPDATE ON session_inbox BEGIN
 UPDATE session_triggers SET status=CASE NEW.status WHEN 'claimed' THEN 'running' ELSE NEW.status END,error=NEW.error,updated_at=NEW.updated_at WHERE dedupe_key='user_messages:'||NEW.entry_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_reply_dispatches_reject_deleted_session BEFORE INSERT ON session_reply_dispatches
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_runner_attempts_reject_deleted_session BEFORE INSERT ON session_runner_attempts
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_states_reject_deleted_session BEFORE INSERT ON session_states
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_timeline_entries_reject_deleted_session BEFORE INSERT ON session_timeline_entries
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_timeline_update_scope BEFORE UPDATE OF session_id,message_id ON session_timeline_entries
WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN messages m ON m.id=NEW.message_id AND m.agent_id=s.agent_id AND m.shadow_id=s.shadow_id AND m.binding_id IS s.binding_id WHERE s.id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'message_reference_scope_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER session_timeline_validate_scope BEFORE INSERT ON session_timeline_entries
WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN messages m ON m.id=NEW.message_id AND m.agent_id=s.agent_id AND m.shadow_id=s.shadow_id AND m.binding_id IS s.binding_id WHERE s.id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'message_reference_scope_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER session_triggers_reject_deleted_session BEFORE INSERT ON session_triggers
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER session_turns_reject_deleted_session BEFORE INSERT ON session_turns
WHEN EXISTS (SELECT 1 FROM session_deletions WHERE session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER sessions_immutable_scope BEFORE UPDATE OF agent_id,shadow_id,binding_id,bot_user_id,channel_type,channel_id ON sessions
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.shadow_id IS NOT NEW.shadow_id OR OLD.binding_id IS NOT NEW.binding_id OR OLD.bot_user_id IS NOT NEW.bot_user_id OR OLD.channel_type IS NOT NEW.channel_type OR OLD.channel_id IS NOT NEW.channel_id
BEGIN SELECT RAISE(ABORT,'session_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER sessions_validate_scope BEFORE INSERT ON sessions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agent_shadows WHERE id=NEW.shadow_id AND agent_id=NEW.agent_id AND reply_user_id=NEW.bot_user_id)
 THEN RAISE(ABORT,'session_scope_mismatch') END;
 SELECT CASE WHEN (NEW.channel_type='dashboard' AND NEW.binding_id IS NOT NULL) OR
 (NEW.channel_type!='dashboard' AND (NEW.binding_id IS NULL OR NOT EXISTS(
 SELECT 1 FROM shadow_bot_bindings WHERE id=NEW.binding_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id AND channel_config_id=NEW.channel_id)))
 THEN RAISE(ABORT,'session_binding_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER task_participants_reject_deleted_task BEFORE INSERT ON task_participants
WHEN EXISTS (SELECT 1 FROM task_deletions WHERE task_id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'Task has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER task_run_notifications_reject_deleted_task BEFORE INSERT ON task_run_notifications
WHEN EXISTS (SELECT 1 FROM task_deletions WHERE task_id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'Task has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER task_runs_reject_deleted_task BEFORE INSERT ON task_runs
WHEN EXISTS (SELECT 1 FROM task_deletions WHERE task_id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'Task has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER task_subscriptions_reject_deleted_task BEFORE INSERT ON task_subscriptions
WHEN EXISTS (SELECT 1 FROM task_deletions WHERE task_id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'Task has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER task_subscriptions_update_scope BEFORE UPDATE OF task_id,session_id,channel_type,channel_id ON task_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM tasks t JOIN sessions s ON s.id=NEW.session_id AND s.agent_id=t.agent_id AND s.shadow_id=t.shadow_id
 WHERE t.id=NEW.task_id AND s.channel_type=NEW.channel_type AND s.channel_id=NEW.channel_id)
BEGIN SELECT RAISE(ABORT,'task_subscription_scope_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER task_subscriptions_validate_scope BEFORE INSERT ON task_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM tasks t JOIN sessions s ON s.id=NEW.session_id AND s.agent_id=t.agent_id AND s.shadow_id=t.shadow_id
 WHERE t.id=NEW.task_id AND s.channel_type=NEW.channel_type AND s.channel_id=NEW.channel_id)
BEGIN SELECT RAISE(ABORT,'task_subscription_scope_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER tasks_immutable_scope BEFORE UPDATE OF agent_id,shadow_id ON tasks
WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.shadow_id IS NOT NEW.shadow_id
BEGIN SELECT RAISE(ABORT,'task_scope_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tasks_validate_primary_session BEFORE UPDATE OF primary_session_id ON tasks
WHEN NEW.primary_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.primary_session_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id)
BEGIN SELECT RAISE(ABORT,'task_session_scope_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER tasks_validate_scope BEFORE INSERT ON tasks BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agent_shadows WHERE id=NEW.shadow_id AND agent_id=NEW.agent_id)
 THEN RAISE(ABORT,'task_scope_mismatch') END;
 SELECT CASE WHEN NEW.primary_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.primary_session_id AND agent_id=NEW.agent_id AND shadow_id=NEW.shadow_id)
 THEN RAISE(ABORT,'task_session_scope_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER timeline_events_reject_deleted_task BEFORE INSERT ON timeline_events
WHEN EXISTS (SELECT 1 FROM task_deletions WHERE task_id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'Task has been deleted'); END;
--> statement-breakpoint
CREATE TRIGGER messages_user_agent_insert BEFORE INSERT ON messages
WHEN (NEW.sender_user_id IS NOT NULL AND NEW.sender_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.sender_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER messages_user_agent_update BEFORE UPDATE OF agent_id,sender_user_id ON messages
WHEN (NEW.sender_user_id IS NOT NULL AND NEW.sender_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.sender_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER sessions_user_agent_insert BEFORE INSERT ON sessions
WHEN (NEW.created_by_user_id IS NOT NULL AND NEW.created_by_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by_user_id AND agent_id=NEW.agent_id)) OR (NEW.bot_user_id IS NOT NULL AND NEW.bot_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.bot_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER sessions_user_agent_update BEFORE UPDATE OF agent_id,created_by_user_id,bot_user_id ON sessions
WHEN (NEW.created_by_user_id IS NOT NULL AND NEW.created_by_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by_user_id AND agent_id=NEW.agent_id)) OR (NEW.bot_user_id IS NOT NULL AND NEW.bot_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.bot_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER tasks_user_agent_insert BEFORE INSERT ON tasks
WHEN (NEW.creator_user_id IS NOT NULL AND NEW.creator_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.creator_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER tasks_user_agent_update BEFORE UPDATE OF agent_id,creator_user_id ON tasks
WHEN (NEW.creator_user_id IS NOT NULL AND NEW.creator_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.creator_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER runner_invocations_user_agent_insert BEFORE INSERT ON runner_invocations
WHEN (NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER runner_invocations_user_agent_update BEFORE UPDATE OF agent_id,actor_user_id ON runner_invocations
WHEN (NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER agent_memories_user_agent_insert BEFORE INSERT ON agent_memories
WHEN (NEW.subject_user_id IS NOT NULL AND NEW.subject_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.subject_user_id AND agent_id=NEW.agent_id)) OR (NEW.origin_user_id IS NOT NULL AND NEW.origin_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.origin_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER agent_memories_user_agent_update BEFORE UPDATE OF agent_id,subject_user_id,origin_user_id ON agent_memories
WHEN (NEW.subject_user_id IS NOT NULL AND NEW.subject_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.subject_user_id AND agent_id=NEW.agent_id)) OR (NEW.origin_user_id IS NOT NULL AND NEW.origin_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.origin_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER access_tokens_user_agent_insert BEFORE INSERT ON access_tokens
WHEN (NEW.user_id IS NOT NULL AND NEW.user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER access_tokens_user_agent_update BEFORE UPDATE OF agent_id,user_id ON access_tokens
WHEN (NEW.user_id IS NOT NULL AND NEW.user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER user_identity_links_user_agent_insert BEFORE INSERT ON user_identity_links
WHEN (NEW.user_id IS NOT NULL AND NEW.user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER user_identity_links_user_agent_update BEFORE UPDATE OF agent_id,user_id ON user_identity_links
WHEN (NEW.user_id IS NOT NULL AND NEW.user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER agent_shadows_user_agent_insert BEFORE INSERT ON agent_shadows
WHEN (NEW.reply_user_id IS NOT NULL AND NEW.reply_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.reply_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER agent_shadows_user_agent_update BEFORE UPDATE OF agent_id,reply_user_id ON agent_shadows
WHEN (NEW.reply_user_id IS NOT NULL AND NEW.reply_user_id <> '' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.reply_user_id AND agent_id=NEW.agent_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER group_memberships_user_agent_insert BEFORE INSERT ON group_memberships
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND agent_id=(SELECT agent_id FROM groups WHERE id=NEW.group_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER group_memberships_user_agent_update BEFORE UPDATE OF group_id,user_id ON group_memberships
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND agent_id=(SELECT agent_id FROM groups WHERE id=NEW.group_id))
BEGIN SELECT RAISE(ABORT,'user_agent_mismatch'); END;
