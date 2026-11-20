import { and, eq, sql } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { channelUserBindings, userIdentityLinks, users } from "@/data/schema";

/**
 * Moves everything a user of `agentId` holds into `targetId`: chat identities,
 * verified claims, and Agent-scoped references (messages, sessions, tasks,
 * memories, group memberships, authorization rules). Finished audit/invocation
 * records keep the old id, which now points to `targetId` via `mergedIntoUserId`.
 */
export function mergeAgentUser(
  db: DrizzleDB,
  agentId: string,
  sourceId: string,
  targetId: string,
  now = Date.now(),
): void {
  if (sourceId === targetId) return;
  const timestamp = String(now);
  db.update(channelUserBindings).set({ userId: targetId }).where(eq(channelUserBindings.userId, sourceId)).run();
  db.update(userIdentityLinks)
    .set({ userId: targetId, isPrimary: false, updatedAt: timestamp })
    .where(and(eq(userIdentityLinks.userId, sourceId), eq(userIdentityLinks.agentId, agentId)))
    .run();
  db.run(sql`UPDATE messages SET sender_user_id = ${targetId} WHERE sender_user_id = ${sourceId} AND agent_id = ${agentId} AND deleted_at IS NULL`);
  db.run(sql`UPDATE sessions SET created_by_user_id = ${targetId} WHERE created_by_user_id = ${sourceId} AND agent_id = ${agentId}`);
  db.run(sql`UPDATE tasks SET creator_user_id = ${targetId} WHERE creator_user_id = ${sourceId} AND agent_id = ${agentId}`);
  db.run(sql`UPDATE OR IGNORE task_participants SET user_id = ${targetId} WHERE user_id = ${sourceId}`);
  db.run(sql`DELETE FROM task_participants WHERE user_id = ${sourceId}`);
  db.run(sql`UPDATE session_schedules SET actor_user_id = ${targetId} WHERE actor_user_id = ${sourceId}`);
  db.run(sql`UPDATE agent_memories SET subject_id = ${targetId} WHERE type = 'person' AND subject_id = ${sourceId} AND agent_id = ${agentId}`);
  db.run(sql`UPDATE agent_memories SET origin_user_id = ${targetId} WHERE origin_user_id = ${sourceId} AND agent_id = ${agentId}`);
  db.run(sql`UPDATE agent_memories SET participants_json = (
      SELECT json_group_array(DISTINCT CASE WHEN value = ${sourceId} THEN ${targetId} ELSE value END) FROM json_each(agent_memories.participants_json))
    WHERE agent_id = ${agentId} AND EXISTS (SELECT 1 FROM json_each(agent_memories.participants_json) WHERE value = ${sourceId})`);
  db.run(sql`UPDATE OR IGNORE group_memberships SET user_id = ${targetId} WHERE user_id = ${sourceId}`);
  db.run(sql`DELETE FROM group_memberships WHERE user_id = ${sourceId}`);
  db.run(sql`UPDATE OR IGNORE authorization_rules SET subject_id = ${targetId}
    WHERE scope_type = 'agent' AND agent_id = ${agentId} AND subject_type = 'user' AND subject_id = ${sourceId}`);
  db.run(sql`DELETE FROM authorization_rules WHERE scope_type = 'agent' AND agent_id = ${agentId} AND subject_type = 'user' AND subject_id = ${sourceId}`);
  db.update(users).set({ status: "merged", mergedIntoUserId: targetId, updatedAt: timestamp }).where(eq(users.id, sourceId)).run();
}
