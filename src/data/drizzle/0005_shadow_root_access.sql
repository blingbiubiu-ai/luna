CREATE TABLE shadow_root_access (
 shadow_id TEXT PRIMARY KEY NOT NULL,
 agent_id TEXT NOT NULL,
 enabled INTEGER NOT NULL,
 updated_by TEXT NOT NULL REFERENCES users(id),
 updated_at INTEGER NOT NULL,
 FOREIGN KEY (agent_id, shadow_id) REFERENCES agent_shadows(agent_id, id)
);
