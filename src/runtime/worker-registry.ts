import { z } from "zod";
import { Id } from "@luna/runner-protocol";
import { canonicalJson, ExecutionError, type SqlDatabase } from "@luna/execution-store";
import { ExecutionClient, type RpcClient } from "@luna/execution-transport";

const Origin = z.url().refine((input) => { const url = new URL(input); return url.protocol === "http:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"; }, "HTTP origin required");
export const WorkerRegistration = z.object({ reverse: z.boolean().optional(), workerId: Id, endpoint: Origin, controlToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), executorHost: z.string().min(1), executorPortStart: z.number().int().min(1).max(65535), executorPortEnd: z.number().int().min(1).max(65535) }).strict().refine((config) => config.executorPortStart <= config.executorPortEnd);
export type WorkerRegistration = z.infer<typeof WorkerRegistration>;
export interface Health { capabilities?:string[]|undefined; workerId: string; imageDigest: string; capacity: number; occupied: number; ready?: boolean|undefined; revision?: string | undefined; desiredRevision?: string | undefined; error?: string | undefined; projects?: string[]|undefined; }
export interface WorkerRecord { reverse?: boolean | undefined; workerId: string; endpoint: string; executorHost: string; executorPortStart: number; executorPortEnd: number; draining: boolean; lastSeen: number; lastHeartbeatAt?: number; health: Health | null; }

/** Placement reads public state; control tokens stay in the private Runtime database. */
export class WorkerRegistry {
  /** The selected Worker's reported image, never a Service-wide requirement. */
  imageDigest(workerId: string): string {
    const worker = this.require(workerId);
    if (!worker.health || worker.health.ready === false || worker.draining || worker.lastSeen <= Date.now() - 30000) throw new ExecutionError(503, "no_worker_available");
    return worker.health.imageDigest;
  }

  private channels = new Map<string, RpcClient>();
  attach(id: string, channel: RpcClient): void { this.require(id); this.channels.set(id, channel); }
  detach(id: string, channel: RpcClient): void { if (this.channels.get(id) === channel) { this.channels.delete(id); const state = this.require(id); state.lastHeartbeatAt ??= state.lastSeen; state.lastSeen = 0; this.save(state); } }
  heartbeat(id: string, health: Health): void { const state = this.require(id); state.health = health; state.lastSeen = Date.now(); state.lastHeartbeatAt = state.lastSeen; this.save(state); }
  hasRecentHeartbeat(id: string): boolean { const worker = this.require(id); return (worker.lastHeartbeatAt ?? worker.lastSeen) > Date.now() - 30000; }
  resume(id: string): void { const state = this.require(id); state.draining = false; this.save(state); }
  constructor(private readonly db: SqlDatabase, private readonly homeWorkerId: string) {
    db.exec("CREATE TABLE IF NOT EXISTS runtime_workers (worker_id TEXT PRIMARY KEY,config TEXT NOT NULL,state TEXT NOT NULL)");
    for (const row of db.prepare("SELECT config FROM runtime_workers").all() as { config: string }[]) {
      const registration = WorkerRegistration.parse(JSON.parse(row.config));
      this.requireLocal(registration);
      if (registration.reverse) { const state = this.require(registration.workerId); state.lastHeartbeatAt ??= state.lastSeen; state.lastSeen = 0; this.save(state); }
    }
  }
  register(input: unknown): WorkerRecord {
    const config = WorkerRegistration.parse(input);
    this.requireLocal(config);
    const prior = this.db.prepare("SELECT config FROM runtime_workers WHERE worker_id=?").get(config.workerId) as { config: string } | undefined;
    if (prior && prior.config !== canonicalJson(config) && !(config.reverse && !JSON.parse(prior.config).reverse)) throw new ExecutionError(409, "worker_configuration_conflict");
    if (!prior || (config.reverse && !JSON.parse(prior.config).reverse)) {
      const { controlToken: _, ...publicConfig } = config;
      const state: WorkerRecord = { ...publicConfig, draining: false, lastSeen: 0, health: null };
      this.db.prepare("INSERT OR REPLACE INTO runtime_workers VALUES (?,?,?)").run(config.workerId, canonicalJson(config), JSON.stringify(state));
    }
    return this.require(config.workerId);
  }
  list(): WorkerRecord[] { return (this.db.prepare("SELECT state FROM runtime_workers").all() as { state: string }[]).map((row) => JSON.parse(row.state) as WorkerRecord); }
  require(id: string): WorkerRecord {
    const row = this.db.prepare("SELECT state FROM runtime_workers WHERE worker_id=?").get(id) as { state: string } | undefined;
    if (!row) throw new ExecutionError(404, "worker_not_found"); return JSON.parse(row.state) as WorkerRecord;
  }
  client(id: string): RpcClient {
    const channel = this.channels.get(id); if (channel) return channel;
    if (this.require(id).reverse) throw new ExecutionError(503, "worker_disconnected");
    const row = this.db.prepare("SELECT config FROM runtime_workers WHERE worker_id=?").get(id) as { config: string } | undefined;
    if (!row) throw new ExecutionError(404, "worker_not_found"); const config = JSON.parse(row.config) as WorkerRegistration;
    return new ExecutionClient(config.endpoint, config.controlToken);
  }
  async poll(): Promise<void> {
    await Promise.all(this.list().map(async (worker) => {
      try {
        if (worker.reverse) return;
        const health = z.object({ workerId: Id, imageDigest: z.string(), capacity: z.number().int().positive(), occupied: z.number().int().nonnegative(), ready:z.boolean().optional(), capabilities:z.array(z.string()).optional(), projects:z.array(Id).optional() }).strict().parse(await this.client(worker.workerId).call("GET", "/v1/health", undefined, AbortSignal.timeout(2000)));
        if (health.workerId !== worker.workerId) return;
        const current = this.require(worker.workerId); current.health = health; current.lastSeen = Date.now(); current.lastHeartbeatAt = current.lastSeen; this.save(current);
      } catch { /* Retain last observed identity; offline is derived from age. */ }
    }));
  }
  validateExecutor(id: string, endpoint: string): void {
    Origin.parse(endpoint); const worker = this.require(id); const url = new URL(endpoint);
    if (url.hostname !== worker.executorHost || Number(url.port || 80) < worker.executorPortStart || Number(url.port || 80) > worker.executorPortEnd) throw new ExecutionError(403, "executor_endpoint_denied");
  }
  drain(id: string): void { const state = this.require(id); state.draining = true; this.save(state); }
  remove(id: string): void {
    this.require(id);
    if (id === this.homeWorkerId) throw new ExecutionError(409, "local_worker_cannot_unbind");
    for (const [table, column] of [["scheduled_jobs", "json_extract(record_json, '$.workerId')"], ["runtime_contexts", "worker_id"], ["runtime_projects", "worker_id"], ["shadow_placements", "worker_id"], ["shadow_context_routes", "worker_id"], ["runtime_previous_preparations", "worker_id"]]) {
      const exists = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table!);
      if (exists && this.db.query(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`).get(id)) throw new ExecutionError(409, "worker_still_referenced");
    }
    this.db.prepare("DELETE FROM runtime_workers WHERE worker_id=?").run(id);
  }
  private requireLocal(config: WorkerRegistration): void {
    if (config.reverse) return;
    if (config.workerId !== this.homeWorkerId) throw new ExecutionError(409, "local_worker_required");
    if (new URL(config.endpoint).hostname !== "127.0.0.1" || config.executorHost !== "127.0.0.1") {
      throw new ExecutionError(422, "loopback_worker_required");
    }
  }
  private save(state: WorkerRecord): void { this.db.prepare("UPDATE runtime_workers SET state=? WHERE worker_id=?").run(JSON.stringify(state), state.workerId); }
}
