import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Someone who signs in to the Dashboard: owns Agents, holds personal tokens, may administer the platform. */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  status: text("status", { enum: ["active", "disabled", "deleted"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
