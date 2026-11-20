import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { EncryptedSecret } from "@/agent-config/secret-cipher";
import { accounts } from "./accounts";

/** Platform-wide OAuth sign-in settings (e.g. Feishu Dashboard login), managed by platform administrators. */
export const platformAuthSettings = sqliteTable("platform_auth_settings", {
  provider: text("provider").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  appId: text("app_id").notNull(),
  secret: text("secret", { mode: "json" }).$type<EncryptedSecret>().notNull(),
  feishuHost: text("feishu_host").notNull().default("https://open.feishu.cn"),
  publicBaseUrl: text("public_base_url").notNull().default(""),
  updatedByAccountId: text("updated_by_account_id").notNull().references(() => accounts.id),
  updatedAt: integer("updated_at").notNull(),
});
