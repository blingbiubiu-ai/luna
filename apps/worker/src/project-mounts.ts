import { mkdirSync, realpathSync, statSync } from "node:fs";
import { sep, join } from "node:path";
import { ExecutionError, type SqlDatabase } from "@luna/execution-store";
import type { WorkerConfig } from "./config";

/** Projects are local bind mounts selected by deployment configuration. */
export class ProjectMounts {
  constructor(private readonly db: SqlDatabase, private readonly config: WorkerConfig) {
    db.exec("CREATE TABLE IF NOT EXISTS worker_context_projects (context_id TEXT PRIMARY KEY,project_id TEXT NOT NULL)");
  }

  prepare(): void {
    if (this.config.projects.length > 1) throw new ExecutionError(409, "shared_project_directory_conflict");
    for (const project of this.config.projects) {
      mkdirSync(project.hostPath, { recursive: true });
      const source = realpathSync(project.hostPath);
      if (!statSync(source).isDirectory()) throw new ExecutionError(409, "project_directory_required");
      const control = realpathSync(this.config.dataRoot);
      const projectsRoot = join(control, "projects");
      const nestedControl = source.startsWith(control + sep) && source !== projectsRoot && !source.startsWith(projectsRoot + sep);
      if (nestedControl || source === control || control.startsWith(source + sep)) throw new ExecutionError(409, "project_storage_overlap");
    }
  }

  bind(contextId: string, projectId?: string): void {
    for (const project of this.config.projects) this.source(project.projectId);
    if (!projectId) return;
    const prior = this.forContext(contextId);
    if (prior && prior.projectId !== projectId) throw new ExecutionError(409, "context_project_conflict");
    this.source(projectId);
    this.db.prepare("INSERT OR IGNORE INTO worker_context_projects VALUES (?,?)").run(contextId, projectId);
  }

  forContext(contextId: string): { projectId: string; hostPath: string } | null {
    const row = this.db.prepare("SELECT project_id FROM worker_context_projects WHERE context_id=?").get(contextId) as { project_id: string } | undefined;
    return row ? { projectId: row.project_id, hostPath: this.source(row.project_id) } : null;
  }

  source(projectId: string): string {
    const project = this.config.projects.find(project => project.projectId === projectId);
    if (!project) throw new ExecutionError(409, "project_not_configured");
    try {
      const path = realpathSync(project.hostPath);
      if (!statSync(path).isDirectory()) throw new ExecutionError(409, "project_directory_required");
      return path;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new ExecutionError(409, "project_directory_missing");
      if (code === "EACCES" || code === "EPERM") throw new ExecutionError(403, "project_access_denied");
      throw error;
    }
  }
}
