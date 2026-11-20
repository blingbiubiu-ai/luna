import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { accounts } from "./accounts";

/** Singleton row (`id = 'default'`) storing platform-wide runtime settings managed from Dashboard. */
export const platformSettings = sqliteTable("platform_settings", {
  id: text("id").primaryKey(),
  settings: text("settings", { mode: "json" }).notNull().$type<unknown>(),
  updatedByAccountId: text("updated_by_account_id").references(() => accounts.id),
  updatedAt: integer("updated_at").notNull(),
});
