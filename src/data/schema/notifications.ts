import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Drizzle table definition for idempotent notification delivery attempts.
 */
export const notificationAttempts = sqliteTable(
  "notification_attempts",
  {
    id: text("id").primaryKey(),
    idempotency_key: text("idempotency_key").notNull(),
    task_id: text("task_id").notNull(),
    subscription_id: text("subscription_id").notNull(),
    message_id: text("message_id").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    outbound_id: text("outbound_id"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("notification_attempts_idempotency_key_unique").on(
      table.idempotency_key,
    ),
  ],
);
