import { rmSync, realpathSync, existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { sql } from "drizzle-orm";
import type { DrizzleDB } from "./data-connection";
import { config } from "@/shared";

/** Durable cleanup manifests contain only paths; completed manifests retain no paths. */
export function drainSessionFileCleanup(db: DrizzleDB, sessionId?: string): void {
  drainOwnerFileCleanup(db, "session", sessionId);
}

export function drainTaskFileCleanup(db: DrizzleDB, taskId?: string): void {
  drainOwnerFileCleanup(db, "task", taskId);
}

function drainOwnerFileCleanup(db: DrizzleDB, kind: "session" | "task", ownerId?: string): void {
  const table = sql.raw(kind === "session" ? "session_deletions" : "task_deletions");
  const column = sql.raw(kind === "session" ? "session_id" : "task_id");
  const rows = db.all<{ owner_id: string; pending_paths: string }>(sql`SELECT ${column} AS owner_id, pending_paths FROM ${table} WHERE pending_paths <> '[]'`);
  for (const row of rows) {
    if (ownerId !== undefined && row.owner_id !== ownerId) continue;
    const pending = JSON.parse(row.pending_paths) as string[];
    for (const path of pending) {
      assertCleanupPath(path);
      rmSync(path, { recursive: true, force: true });
    }
    db.run(sql`UPDATE ${table} SET pending_paths = '[]' WHERE ${column} = ${row.owner_id}`);
  }
}

export function assertCleanupPath(path: string): void {
  const contained = (base: string, target: string) => {
    const rel = relative(resolve(base), resolve(target));
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
  };
  const roots = [config.paths.runnerRootBase, config.paths.artifacts];
  const root = roots.find(base => contained(base, path));
  if (!root) throw new Error("Session cleanup path is outside managed storage");
  // Do not traverse a symlinked parent into another workspace.
  let parent = dirname(path);
  while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
  if (existsSync(root) && parent !== resolve(root) && !contained(realpathSync(root), realpathSync(parent))) {
    throw new Error("Session cleanup path has an unsafe parent");
  }
}
