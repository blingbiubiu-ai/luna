import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const pluginMarketplaces = sqliteTable("plugin_marketplaces", {
  id: text("id").primaryKey(),
  git_url: text("git_url").notNull(),
  branch: text("branch").notNull(),
  local_path: text("local_path").notNull(),
  last_commit: text("last_commit"),
  last_fetched_at: integer("last_fetched_at"),
  last_error: text("last_error"),
});

export const pluginReleases = sqliteTable(
  "plugin_releases",
  {
    id: text("id").primaryKey(),
    marketplace_id: text("marketplace_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    version: text("version").notNull(),
    release_path: text("release_path").notNull(),
    manifest_sha256: text("manifest_sha256").notNull(),
    plugin_js_sha256: text("plugin_js_sha256").notNull(),
    package_sha256: text("package_sha256"),
    release_sha256: text("release_sha256").notNull(),
    luna_api_version: text("luna_api_version").notNull(),
    marketplace_commit: text("marketplace_commit"),
    validation_status: text("validation_status").notNull().default("valid"),
    validation_error: text("validation_error"),
    manifest_json: text("manifest_json"),
    discovered_at: integer("discovered_at").notNull(),
  },
  (table) => [
    uniqueIndex("plugin_releases_marketplace_plugin_version_unique").on(
      table.marketplace_id,
      table.plugin_id,
      table.version,
    ),
  ],
);

export const pluginInstallations = sqliteTable("plugin_installations", {
  plugin_id: text("plugin_id").primaryKey(),
  desired_state: text("desired_state").notNull().default("disabled"),
  desired_version: text("desired_version"),
  desired_release_sha256: text("desired_release_sha256"),
  desired_installed_path: text("desired_installed_path"),
  active_state: text("active_state").notNull().default("disabled"),
  active_version: text("active_version"),
  active_release_sha256: text("active_release_sha256"),
  active_installed_path: text("active_installed_path"),
  pending_action: text("pending_action").notNull().default("none"),
  last_activated_at: integer("last_activated_at"),
  last_error: text("last_error"),
});
