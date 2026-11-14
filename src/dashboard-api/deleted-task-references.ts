import { sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";

export interface DeletedTaskReference {
  taskId: string;
  sessionId: string;
  messageId: string;
}

/** Only relationship IDs survive deletion; titles and task content are not retained. */
export function deletedTaskReferences(db: DrizzleDB): DeletedTaskReference[] {
  return db.all<DeletedTaskReference>(sql`
    SELECT task_id AS taskId, session_id AS sessionId, message_id AS messageId FROM deleted_task_references
    UNION
    SELECT d.task_id AS taskId, e.session_id AS sessionId, m.id AS messageId
    FROM task_deletions d JOIN messages m ON
      json_extract(m.raw_payload_json, '$.sourceTaskId') = d.task_id
      OR instr(m.content_json, '/tasks/' || d.task_id) > 0
    JOIN session_timeline_entries e ON e.message_id = m.id
    WHERE m.deleted_at IS NULL
  `);
}
