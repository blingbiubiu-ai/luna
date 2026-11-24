import { assertDatabaseBaseline } from "./schema-baseline";
import { drainSessionFileCleanup, drainTaskFileCleanup } from "./session-file-cleanup";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { Database as SQLiteDatabase } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type { Logger } from "@/shared";
import { config, createLogger } from "@/shared";


/** The Drizzle db instance type returned by {@link DataConnection.db}. */
export type DrizzleDB<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = ReturnType<typeof drizzle<TSchema>>;

/**
 * Central SQLite database for the Luna agent runtime.
 *
 * Wraps `bun:sqlite` + Drizzle ORM. The caller injects table schemas so that
 * this module has no dependency on the kernel layer.
 *
 * The consolidated baseline is applied to fresh databases by the Drizzle
 * migrator. Existing databases must already have the same baseline.
 *
 * @typeParam TSchema - The merged Drizzle schema object.
 */
export class DataConnection<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  private _sqlite: SQLiteDatabase;
  private _db: DrizzleDB<TSchema>;
  private _logger: Logger;

  constructor(schemas: TSchema) {
    this._logger = createLogger("database");

    const dbPath = config.paths.resolveDataFilePath("luna.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this._sqlite = new SQLiteDatabase(dbPath, { create: true });
    try {
      const migrationsFolder = resolveMigrationsFolder();
      assertDatabaseBaseline(this._sqlite, migrationsFolder);
      this._sqlite.run("PRAGMA journal_mode = WAL");
      this._sqlite.run("PRAGMA synchronous = NORMAL");
      this._sqlite.run("PRAGMA foreign_keys = ON");
      this._sqlite.run("PRAGMA busy_timeout = 5000");
      this._sqlite.run("PRAGMA cache_size = -131072");
      this._sqlite.run("PRAGMA mmap_size = 536870912");
      this._sqlite.run("PRAGMA temp_store = MEMORY");
      this._sqlite.run("PRAGMA journal_size_limit = 67108864");
      this._db = drizzle(this._sqlite, { schema: schemas });
      migrate(this._db, { migrationsFolder });
      repairChannelSurfaceKinds(this._sqlite);
    } catch (error) {
      this._sqlite.close();
      throw error;
    }
    try { drainSessionFileCleanup(this._db); } catch (error) { this._logger.error({ error }, "Session file cleanup will retry on next startup or delete request"); }

    try { drainTaskFileCleanup(this._db); } catch (error) { this._logger.error({ error }, "Task file cleanup will retry on next startup or delete request"); }

    this._logger.info(`Database "${dbPath}" opened`);
  }

  /** The Drizzle database instance for executing typed queries. */
  get db(): DrizzleDB<TSchema> {
    return this._db;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this._sqlite.close();
    this._logger.info("database closed");
  }
}

/**
 * Executes resolve Migrations Folder logic for database connection management.
 */
export function resolveMigrationsFolder(
  input: {
    readonly moduleDir?: string;
    readonly cwd?: string;
    readonly env?: {
      readonly LUNA_MIGRATIONS_DIR?: string;
    };
  } = {},
): string {
  const candidates = migrationFolderCandidates(input);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }
  throw new Error(
    `Luna migrations folder not found. Checked: ${candidates.join(", ")}`,
  );
}

export function migrationFolderCandidates(
  input: {
    readonly moduleDir?: string;
    readonly cwd?: string;
    readonly env?: {
      readonly LUNA_MIGRATIONS_DIR?: string;
    };
  } = {},
): string[] {
  const moduleDir = input.moduleDir ?? import.meta.dir;
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  return uniquePaths([
    env.LUNA_MIGRATIONS_DIR,
    join(moduleDir, "drizzle"),
    join(moduleDir, "..", "..", "drizzle"),
    join(moduleDir, "..", "drizzle"),
    join(moduleDir, "..", "src", "data", "drizzle"),
    join(moduleDir, "..", "..", "..", "src", "data", "drizzle"),
    join(cwd, "src", "data", "drizzle"),
    join(cwd, "luna", "src", "data", "drizzle"),
  ]);
}

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (path === undefined || path.trim().length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }
  return result;
}

/**
 * Repairs channel_surfaces rows whose surface_kind was overwritten by earlier
 * profile-less synthetic status-card/result upserts despite p2p raw metadata.
 */
function repairChannelSurfaceKinds(sqlite: SQLiteDatabase): void {
  sqlite.run(`
    UPDATE channel_surfaces
    SET surface_kind = 'p2p'
    WHERE surface_kind != 'p2p'
      AND (
        (
          raw_profile_json IS NOT NULL
          AND json_valid(raw_profile_json)
          AND (
            json_extract(raw_profile_json, '$.chat_mode') = 'p2p'
            OR json_extract(raw_profile_json, '$.chatMode') = 'p2p'
            OR json_extract(raw_profile_json, '$.chat_type') = 'p2p'
            OR json_extract(raw_profile_json, '$.chatType') = 'p2p'
          )
        )
        OR (
          raw_profile_json IS NULL
          AND EXISTS (
            SELECT 1
            FROM messages m
            WHERE m.channel_type = channel_surfaces.channel_type
              AND m.channel_id = channel_surfaces.channel_id
              AND m.role = 'user'
              AND m.raw_payload_json IS NOT NULL
              AND json_valid(m.raw_payload_json)
              AND json_extract(m.raw_payload_json, '$.surface.externalId') = channel_surfaces.external_id
              AND json_extract(m.raw_payload_json, '$.surface.kind') = 'p2p'
          )
        )
      )
  `);
}
