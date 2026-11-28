CREATE TABLE agent_lineages (
  id TEXT PRIMARY KEY NOT NULL,
  source_agent_id TEXT NOT NULL UNIQUE REFERENCES luna_agents(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  intake_guidelines TEXT NOT NULL DEFAULT '',
  allow_ancestor_lookup INTEGER NOT NULL DEFAULT 1,
  allow_member_invite INTEGER NOT NULL DEFAULT 0,
  template_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE lineage_maintainers (
  lineage_id TEXT NOT NULL REFERENCES agent_lineages(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL DEFAULT 'reviewer' CHECK (role IN ('admin', 'reviewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lineage_id, account_id)
);
--> statement-breakpoint
CREATE TABLE lineage_invites (
  id TEXT PRIMARY KEY NOT NULL,
  lineage_id TEXT NOT NULL REFERENCES agent_lineages(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  require_approval INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX lineage_invites_lineage_status_idx ON lineage_invites(lineage_id, status);
--> statement-breakpoint
CREATE TABLE lineage_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES luna_agents(id),
  lineage_id TEXT NOT NULL REFERENCES agent_lineages(id),
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'active', 'left', 'revoked')),
  invite_id TEXT REFERENCES lineage_invites(id),
  approved_by_account_id TEXT REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX lineage_subscriptions_active_agent_idx ON lineage_subscriptions(agent_id) WHERE status IN ('pending_approval', 'active');
--> statement-breakpoint
CREATE INDEX lineage_subscriptions_lineage_status_idx ON lineage_subscriptions(lineage_id, status);
--> statement-breakpoint
CREATE TABLE lineage_memories (
  id TEXT PRIMARY KEY NOT NULL,
  lineage_id TEXT NOT NULL REFERENCES agent_lineages(id),
  type TEXT NOT NULL CHECK (type IN ('procedure', 'feedback', 'reference', 'project')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  revision INTEGER NOT NULL DEFAULT 1,
  change_seq INTEGER NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('owner_publish', 'contribution_approved', 'lineage_edit')),
  contributor_agent_id TEXT REFERENCES luna_agents(id),
  contributor_account_id TEXT REFERENCES accounts(id),
  approved_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX lineage_memories_lineage_status_idx ON lineage_memories(lineage_id, status, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX lineage_memories_change_seq_idx ON lineage_memories(change_seq);
--> statement-breakpoint
CREATE TABLE lineage_memory_revisions (
  memory_id TEXT NOT NULL REFERENCES lineage_memories(id),
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('owner_publish', 'contribution_approved', 'lineage_edit', 'revert', 'archive', 'restore', 'delete')),
  changed_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  contribution_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, revision)
);
--> statement-breakpoint
CREATE VIRTUAL TABLE lineage_memory_terms USING fts5(memory_id, title, description, body);
--> statement-breakpoint
CREATE TABLE lineage_memory_overrides (
  agent_id TEXT NOT NULL REFERENCES luna_agents(id),
  lineage_memory_id TEXT NOT NULL REFERENCES lineage_memories(id),
  mode TEXT NOT NULL CHECK (mode IN ('muted', 'overridden')),
  local_memory_id TEXT REFERENCES agent_memories(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, lineage_memory_id)
);
--> statement-breakpoint
CREATE TABLE lineage_contributions (
  id TEXT PRIMARY KEY NOT NULL,
  lineage_id TEXT NOT NULL REFERENCES agent_lineages(id),
  source_agent_id TEXT NOT NULL REFERENCES luna_agents(id),
  source_owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  source_local_memory_id TEXT REFERENCES agent_memories(id),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('consolidation', 'manual_dashboard', 'manual_chat')),
  batch_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('add', 'update')),
  target_lineage_memory_id TEXT REFERENCES lineage_memories(id),
  base_revision INTEGER,
  proposed_type TEXT NOT NULL CHECK (proposed_type IN ('procedure', 'feedback', 'reference', 'project')),
  proposed_title TEXT NOT NULL,
  proposed_description TEXT NOT NULL,
  proposed_body TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending_owner', 'pending_lineage', 'approved', 'rejected_by_owner', 'rejected_by_lineage', 'cancelled', 'expired')),
  owner_request_id TEXT,
  lineage_request_id TEXT,
  reviewed_by_account_id TEXT REFERENCES accounts(id),
  review_comment TEXT,
  result_lineage_memory_id TEXT REFERENCES lineage_memories(id),
  result_revision INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX lineage_contributions_lineage_status_idx ON lineage_contributions(lineage_id, status, created_at);
--> statement-breakpoint
CREATE INDEX lineage_contributions_agent_status_idx ON lineage_contributions(source_agent_id, status, created_at);
