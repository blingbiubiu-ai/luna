-- Removes what nothing uses any more: the `service` origin, which no writer produces since episodes became
-- reflection-only, and the document memory that entries replaced (0002 imported it): its revision table,
-- the triggers guarding it and the Agent and Shadow pointers into it. Revisions wait in a table without
-- their reference while entries are rebuilt, because dropping a referenced table fails with foreign keys on.
CREATE TABLE agent_memory_revisions_hold AS SELECT * FROM agent_memory_revisions;

--> statement-breakpoint
DROP TABLE agent_memory_revisions;

--> statement-breakpoint
CREATE TABLE agent_memories_next (
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
INSERT INTO agent_memories_next (id, agent_id, type, title, description, body, subject_user_id, visibility, origin_kind, origin_shadow_id, origin_session_id, origin_task_id, origin_user_id, updated_context_id, trusted, revision, change_seq, status, superseded_by, core, expires_at, last_used_at, created_at, updated_at, occurred_at, participants_json)
SELECT id, agent_id, type, title, description, body, subject_user_id, visibility, origin_kind, origin_shadow_id, origin_session_id, origin_task_id, origin_user_id, updated_context_id, trusted, revision, change_seq, status, superseded_by, core, expires_at, last_used_at, created_at, updated_at, occurred_at, participants_json FROM agent_memories;

--> statement-breakpoint
DROP TABLE agent_memories;

--> statement-breakpoint
ALTER TABLE agent_memories_next RENAME TO agent_memories;

--> statement-breakpoint
CREATE INDEX agent_memories_agent_status_idx ON agent_memories (agent_id, status, updated_at);

--> statement-breakpoint
CREATE UNIQUE INDEX agent_memories_change_seq_idx ON agent_memories (change_seq);

--> statement-breakpoint
CREATE INDEX agent_memories_timeline_idx ON agent_memories (agent_id, occurred_at) WHERE type = 'episode';

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
INSERT INTO agent_memory_revisions SELECT memory_id, revision, snapshot_json, change_kind, changed_by_user_id, changed_by_shadow_id, created_at FROM agent_memory_revisions_hold;

--> statement-breakpoint
DROP TABLE agent_memory_revisions_hold;

--> statement-breakpoint
DROP TRIGGER agent_memory_pointer_scope;

--> statement-breakpoint
DROP TRIGGER shadow_persona_pointer_scope;

--> statement-breakpoint
DROP TRIGGER agent_document_revision_immutable;

--> statement-breakpoint
DROP TABLE agent_document_revisions;

--> statement-breakpoint
ALTER TABLE luna_agents DROP COLUMN memory_revision;

--> statement-breakpoint
ALTER TABLE agent_shadows DROP COLUMN config_revision;
