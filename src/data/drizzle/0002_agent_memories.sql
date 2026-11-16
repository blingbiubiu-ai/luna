CREATE TABLE agent_memories (
 id TEXT PRIMARY KEY NOT NULL,
 agent_id TEXT NOT NULL REFERENCES luna_agents(id),
 type TEXT NOT NULL CHECK(type IN ('persona','person','feedback','project','procedure','reference')),
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
 CONSTRAINT agent_memories_person_subject CHECK ((type='person') = (subject_user_id IS NOT NULL)),
 CONSTRAINT agent_memories_shadow_origin CHECK (visibility='agent' OR origin_shadow_id IS NOT NULL),
 CONSTRAINT agent_memories_core_type CHECK (core=0 OR type NOT IN ('person','persona')),
 CONSTRAINT agent_memories_persona_private CHECK (type<>'persona' OR visibility='shadow')
);

--> statement-breakpoint
CREATE INDEX agent_memories_agent_status_idx ON agent_memories (agent_id, status, updated_at);

--> statement-breakpoint
CREATE UNIQUE INDEX agent_memories_change_seq_idx ON agent_memories (change_seq);

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
-- Bigram terms of each entry, written by AgentMemoryStore; memory_id is indexed so one entry's row can be found by MATCH.
CREATE VIRTUAL TABLE agent_memory_terms USING fts5(memory_id, title, description, body);

--> statement-breakpoint
CREATE TABLE memory_injection_cursors (
 runner_context_id TEXT PRIMARY KEY NOT NULL,
 runner_session_id TEXT NOT NULL,
 injected_through INTEGER NOT NULL
);

--> statement-breakpoint
CREATE TABLE memory_injected_entries (
 runner_context_id TEXT NOT NULL,
 memory_id TEXT NOT NULL,
 PRIMARY KEY (runner_context_id, memory_id)
);

--> statement-breakpoint
CREATE TABLE memory_reflection_checkpoints (
 session_id TEXT PRIMARY KEY NOT NULL,
 reflected_through INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

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
-- Import each legacy Markdown memory document as one entry. The documents stay in agent_document_revisions.
-- The forgetting clock starts at the upgrade: the documents were in every conversation until now, however old the revision.
INSERT INTO agent_memories (id, agent_id, type, title, description, body, subject_user_id, visibility, origin_kind,
 origin_shadow_id, origin_session_id, origin_task_id, origin_user_id, updated_context_id, trusted, revision, change_seq,
 status, superseded_by, core, expires_at, last_used_at, created_at, updated_at)
SELECT lower(hex(randomblob(16))), a.id, 'reference', substr(f.key, 1, 120), substr('Imported memory document ' || f.key, 1, 200), f.value,
 NULL, 'agent', 'migration', NULL, NULL, NULL, r.author_user_id, NULL, 1, 1, row_number() OVER (ORDER BY a.id, f.key),
 'active', NULL, 0, NULL, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), r.created_at, r.created_at
FROM luna_agents a JOIN agent_document_revisions r ON r.id = a.memory_revision AND r.kind = 'memory', json_each(r.files_json) f
WHERE trim(f.value, ' ' || char(9, 10, 13)) <> '';

--> statement-breakpoint
-- Import each Shadow's non-empty legacy USER/SOUL document as a persona entry of that Shadow.
INSERT INTO agent_memories (id, agent_id, type, title, description, body, subject_user_id, visibility, origin_kind,
 origin_shadow_id, origin_session_id, origin_task_id, origin_user_id, updated_context_id, trusted, revision, change_seq,
 status, superseded_by, core, expires_at, last_used_at, created_at, updated_at)
SELECT lower(hex(randomblob(16))), s.agent_id, 'persona', substr(f.key, 1, 120), substr('Imported Shadow document ' || f.key, 1, 200), f.value,
 NULL, 'shadow', 'migration', s.id, NULL, NULL, r.author_user_id, NULL, 1, 1,
 (SELECT coalesce(max(change_seq), 0) FROM agent_memories) + row_number() OVER (ORDER BY s.id, f.key),
 'active', NULL, 0, NULL, r.created_at, r.created_at, r.created_at
FROM agent_shadows s JOIN agent_document_revisions r ON r.id = s.config_revision AND r.kind = 'persona', json_each(r.files_json) f
WHERE trim(f.value, ' ' || char(9, 10, 13)) <> '' AND s.status <> 'deleted';

--> statement-breakpoint
INSERT INTO agent_memory_revisions (memory_id, revision, snapshot_json, change_kind, changed_by_user_id, changed_by_shadow_id, created_at)
SELECT id, 1, json_object('type', type, 'title', title, 'description', description, 'body', body, 'subjectUserId', NULL,
 'visibility', visibility, 'status', status, 'supersededBy', NULL, 'trusted', json('true'), 'core', json('false'), 'expiresAt', NULL), 'migration', origin_user_id, NULL, created_at
FROM agent_memories WHERE origin_kind = 'migration';
