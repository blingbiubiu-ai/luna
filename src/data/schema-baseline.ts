import type { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";

/** Returns true only for an empty database. Never upgrades an unknown schema. */
export function assertDatabaseBaseline(sqlite: Database, migrationsFolder: string): boolean {
  const baseline = readMigrationFiles({ migrationsFolder })[0];
  if (!baseline) throw new Error("Luna database baseline is missing");
  const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  if (tables.length === 0) return true;
  if (tables.some(table => table.name === "__drizzle_migrations")) {
    const first = sqlite.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at LIMIT 1")
      .get() as { hash: string; created_at: number } | null;
    if (first?.hash === baseline.hash && first.created_at === baseline.folderMillis) return false;
  }
  throw new Error(
    "database_baseline_mismatch: this build initializes new Luna databases only. " +
    "Back up the existing database, then use `luna service db reset --home <Service home> --yes` to create a fresh database.",
  );
}
