import { chmodSync, chownSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Credentials, Id, type JobRequest } from "@luna/runner-protocol";
import { canonicalJson, ExecutionError } from "@luna/execution-store";
import type { RunnerLayout } from "@luna/runner-protocol/runner-assets";

export interface ProjectLayout { projectId: string; }
export interface ExecutionContext { id: string; uid: number; gid: number; home: string; cwd: string; project?: ProjectLayout; }


/** One persistent HOME serves every Runner; context IDs select working directories. */
export class ExecutorContexts {
  private readonly paths = new Map<string, { cwd: string; project_id: string | null }>();
  private readonly secrets = new Map<string, Credentials>();
  readonly root: string;
  readonly layout: RunnerLayout;
  constructor(root: string, private readonly uid = 1000, private readonly gid = 1000, layout?: RunnerLayout) {
    this.root = resolve(root);
    this.layout = layout ?? { home: join(this.root, "home"), runners: join(this.root, "runners") };
    mkdirSync(this.root, { recursive: true, mode: 0o711 });
    chmodSync(this.root, 0o711);
    for (const path of [this.layout.home, this.layout.runners]) {
      const created = mkdirSync(path, { recursive: true, mode: 0o700 });
      if (created) chownSync(path, this.uid, this.gid);
    }

  }

  provision(id: string, options: { requireMount?: boolean; cwd?: string; project?: ProjectLayout } = {}): ExecutionContext {
    Id.parse(id);
    const cwd = resolve(options.cwd ?? join(this.layout.runners, id));
    if (dirname(cwd) !== resolve(this.layout.runners)) throw new ExecutionError(409, "context_directory_conflict");
    const prior = this.find(id);
    if (prior && (prior.cwd !== cwd || prior.project_id !== (options.project?.projectId ?? null))) {
      throw new ExecutionError(409, "context_directory_conflict");
    }
    if (!options.requireMount) {
      const created = mkdirSync(cwd, { recursive: true, mode: 0o700 });
      if (created) chownSync(cwd, this.uid, this.gid);
    }
    if (!lstatSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new ExecutionError(409, "context_storage_missing");
    if (options.project) Id.parse(options.project.projectId);
    this.paths.set(id, { cwd, project_id: options.project?.projectId ?? null });
    return this.get(id);
  }

  get(id: string): ExecutionContext {
    const row = this.find(id);
    if (!row) throw new ExecutionError(404, "context_not_found");
    return { id, uid: this.uid, gid: this.gid, home: this.layout.home, cwd: row.cwd,
      ...(row.project_id ? { project: { projectId: row.project_id } } : {}) };
  }

  private find(id: string) {
    return this.paths.get(id);
  }

  putCredentials(job: JobRequest, input: unknown): void {
    const credentials = Credentials.parse(input);
    const current = this.secrets.get(job.jobId);
    const body = canonicalJson(credentials);
    if (credentials.revision < job.credentialsRevision || (current && (credentials.revision < current.revision || (credentials.revision === current.revision && canonicalJson(current) !== body)))) throw new ExecutionError(409, "credentials_revision_conflict");
    this.secrets.set(job.jobId, credentials);
  }

  forgetCredentials(id: string): void { this.secrets.delete(id); }

  credentials(job: JobRequest): Credentials | null {
    const credentials = this.secrets.get(job.jobId);
    if (!credentials) return null;
    return credentials.expiresAt > Date.now() && credentials.revision >= job.credentialsRevision ? credentials : null;
  }
}
