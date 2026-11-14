import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlDatabase = Database;

/** All Luna execution services use the same private, durable Bun SQLite setup. */
export function openExecutionDatabase(path: string): SqlDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") chmodSync(path, 0o600);
  initializeDatabase(db);
  return db;
}

/** Runtime and Worker may initialize empty stores or open an offline-converted store. */
export function openPlatformExecutionDatabase(path: string): SqlDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    if (tables.length) {
      const ready = tables.some(table => table.name === "platform_execution_state") &&
        db.query("SELECT 1 FROM platform_execution_state WHERE version=1 AND phase='ready'").get();
      if (!ready) throw new Error("platform_execution_migration_required: convert Runtime and Worker storage offline before starting");
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    initializeDatabase(db);
    if (!tables.length) transaction(db, () => db.exec(`
      CREATE TABLE platform_execution_state(version INTEGER PRIMARY KEY, phase TEXT NOT NULL);
      INSERT INTO platform_execution_state VALUES (1,'ready');
    `));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function initializeDatabase(db: SqlDatabase): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
}

/** Transactions must never span asynchronous network or filesystem operations. */
export function transaction<T>(db: SqlDatabase, action: () => T): T {
  return db.transaction(action).immediate();
}

/** Canonical JSON gives retries a stable hash independent of object key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Undefined is not a wire value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const fields = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${fields.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** A fixed Shadow placement shares an environment across its contexts. */
export function environmentKey(spec: {environmentId: string; scope: {agentId: string; shadowId: string; placementGeneration: number}}): string {
  return `env_${contentHash([spec.environmentId, spec.scope]).slice(0, 40)}`;
}

/** A safe protocol error contains identifiers, never credentials or raw bodies. */
export class ExecutionError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "ExecutionError";
  }
}

export { readPrivateJson, writePrivateJson } from "./private-files";
