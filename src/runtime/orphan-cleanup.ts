import { z } from "zod";
import type { SqlDatabase } from "@luna/execution-store";

/**
 * Platform setting for Worker data Service no longer knows. When enabled, Service asks
 * each Worker every `intervalMinutes` which Shadows it holds; those whose Shadow or Agent
 * is unknown or deleted lose their containers at once and their /data volumes and HOME
 * after `retentionDays`.
 */
export const OrphanCleanupSettings = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(24 * 60),
  retentionDays: z.number().int().min(1).max(365),
}).strict();
export type OrphanCleanupSettings = z.infer<typeof OrphanCleanupSettings>;

export const DEFAULT_ORPHAN_CLEANUP: OrphanCleanupSettings = { enabled: true, intervalMinutes: 60, retentionDays: 7 };

const KEY = "orphan_cleanup";

/** Kept in the runtime database, which creates its tables on open. */
export class OrphanCleanupStore {
  constructor(private readonly db: SqlDatabase) {
    db.exec("CREATE TABLE IF NOT EXISTS runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  get(): OrphanCleanupSettings {
    const row = this.db.prepare("SELECT value FROM runtime_settings WHERE key=?").get(KEY) as { value: string } | undefined;
    const parsed = row ? OrphanCleanupSettings.safeParse(JSON.parse(row.value)) : undefined;
    return parsed?.success ? parsed.data : DEFAULT_ORPHAN_CLEANUP;
  }
  set(input: unknown): OrphanCleanupSettings {
    const settings = OrphanCleanupSettings.parse(input);
    this.db.prepare("INSERT INTO runtime_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY, JSON.stringify(settings));
    return settings;
  }
}
