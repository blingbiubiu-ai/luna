import {validateScopedResources} from "@luna/host-runtime/scoped-runner-resources";
import type {ResourceScope,ScopedResourceBundle} from "@luna/host-runtime/scoped-runner-resources";
import {ExecutionScope} from "@luna/runner-protocol";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";
import { ReverseChannel } from "@luna/execution-transport";
import { z } from "zod";
import { Id } from "@luna/runner-protocol";
import type { RuntimeScheduler } from "./scheduler";
export type WorkerResourceSource=(scope:ResourceScope,digest:string)=>ScopedResourceBundle|undefined;
export interface WorkerBindingTarget { ownerUserId: string; agentId: string }
export type AssignBoundWorker = (target: WorkerBindingTarget, workerId: string) => void;
export interface WorkerSocketData { workerId: string; gateway: WorkerGateway; channel?: ReverseChannel; }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const healthSchema = z.object({ capabilities:z.array(z.string().max(128)).max(32).optional(), workerId: Id, imageDigest: z.string(), capacity: z.number().int().positive().max(256), occupied: z.number().int().nonnegative(), ready: z.boolean(), revision: z.string().optional(), desiredRevision: z.string().optional(), error: z.string().max(512).optional(), projects: z.array(Id).max(256) });
/** The public Service listener authenticates Worker traffic independently of dashboard sessions. */
export class WorkerGateway {
  private sockets = new Map<string, ServerWebSocket<WorkerSocketData>>();
  constructor(private db: SqlDatabase, readonly scheduler: RuntimeScheduler, private readonly resourceSource?:WorkerResourceSource, private readonly assignBoundWorker?: AssignBoundWorker) {
    db.exec("CREATE TABLE IF NOT EXISTS worker_bind_codes(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS worker_bindings(worker_id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)");
    db.exec(`CREATE TABLE IF NOT EXISTS worker_bind_targets (
      hash TEXT PRIMARY KEY REFERENCES worker_bind_codes(hash) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL, agent_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_owners (
        worker_id TEXT PRIMARY KEY REFERENCES worker_bindings(worker_id), owner_user_id TEXT NOT NULL)`);
  }
  createCode(target: WorkerBindingTarget): { code: string; expiresAt: number } {
    const code = randomBytes(32).toString("base64url"); const expiresAt = Date.now() + 10 * 60000;
    const hash = digest(code);
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM worker_bind_codes WHERE expires<=?").run(Date.now());
      this.db.prepare("INSERT INTO worker_bind_codes VALUES (?,?)").run(hash, expiresAt);
      this.db.prepare("INSERT INTO worker_bind_targets VALUES (?,?,?)").run(hash, target.ownerUserId, target.agentId);
    });
    return { code, expiresAt };
  }
  isLocal(workerId: string): boolean {
    return workerId === this.scheduler.config.homeWorkerId;
  }
  owner(workerId: string): string | undefined {
    return (this.db.prepare("SELECT owner_user_id FROM worker_owners WHERE worker_id=?").get(workerId) as
      { owner_user_id: string } | undefined)?.owner_user_id;
  }
  registerLocal(input: { workerId: string; controlToken: string; port: number; executorPortStart: number; executorPortEnd: number }): void {
    const prior = this.db.prepare("SELECT revoked FROM worker_bindings WHERE worker_id=?").get(input.workerId) as { revoked: number } | undefined;
    if (prior) return;
    this.register(input.workerId, input.controlToken, input);
  }
  private register(workerId: string, token: string, ports: { executorPortStart?: number; executorPortEnd?: number } = {}) {
    this.scheduler.workers.register({ reverse: true, workerId, controlToken: token, endpoint: "http://127.0.0.1:1", executorHost: "127.0.0.1", executorPortStart: ports.executorPortStart ?? 41000, executorPortEnd: ports.executorPortEnd ?? 41100 });
    this.db.prepare("INSERT INTO worker_bindings VALUES (?,?,0)").run(workerId, digest(token));
  }
  authenticate(request: Request): string {
    const value = request.headers.get("authorization") ?? "";
    const token = value.startsWith("Bearer ") ? value.slice(7) : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ExecutionError(401, "invalid_worker_credentials");
    const row = this.db.prepare("SELECT worker_id FROM worker_bindings WHERE token_hash=? AND revoked=0").get(digest(token)) as { worker_id: string } | undefined;
    if (!row) throw new ExecutionError(401, "invalid_worker_credentials");
    return row.worker_id;
  }
  async http(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/api/worker/bind" && request.method === "POST") {
        const text = await request.text(); if (text.length > 4096) throw new ExecutionError(413, "request_too_large");
        const input = z.object({ code: z.string().length(43) }).strict().parse(JSON.parse(text));
        const existingWorkerId = request.headers.has("authorization") ? this.authenticate(request) : undefined;
        const result = transaction(this.db, () => {
          const hash = digest(input.code);
          const target = this.db.prepare("SELECT owner_user_id AS ownerUserId, agent_id AS agentId FROM worker_bind_targets WHERE hash=?")
            .get(hash) as WorkerBindingTarget | undefined;
          const row = this.db.prepare("DELETE FROM worker_bind_codes WHERE hash=? AND expires>? RETURNING hash").get(hash, Date.now());
          if (!row || !target) throw new ExecutionError(401, "binding_code_invalid_or_expired");
          if (!this.assignBoundWorker) throw new ExecutionError(503, "worker_assignment_unavailable");
          if (existingWorkerId) {
            const owner = this.owner(existingWorkerId);
            if (owner !== target.ownerUserId && !(owner === undefined && this.isLocal(existingWorkerId)))
              throw new ExecutionError(403, "worker_access_denied");
            if (owner === undefined) {
              this.db.prepare("INSERT INTO worker_owners VALUES (?,?)").run(existingWorkerId, target.ownerUserId);
            }
            this.assignBoundWorker(target, existingWorkerId);
            return { workerId: existingWorkerId, agentId: target.agentId };
          }
          const workerId = randomUUID(); const token = randomBytes(32).toString("base64url"); this.register(workerId, token);
          this.db.prepare("INSERT INTO worker_owners VALUES (?,?)").run(workerId, target.ownerUserId);
          this.assignBoundWorker(target, workerId);
          return { workerId, token, runtimeId: this.scheduler.config.runtimeId, projectId: this.scheduler.config.sharedProject?.projectId ?? "shared" };
        });
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      }
      const workerId=this.authenticate(request);
      const revision=/^\/api\/worker\/resources\/([a-f0-9]{64})$/.exec(path)?.[1];
      if(revision && request.method==="GET"){
        const params=new URL(request.url).searchParams;
        if([...params.keys()].length!==new Set(params.keys()).size)throw new ExecutionError(422,"invalid_resource_request");
        const scope=ExecutionScope.parse({...Object.fromEntries(params),placementGeneration:Number(params.get("placementGeneration"))});
        if(!this.resourceSource || !this.scheduler.allowedWorkers)throw new ExecutionError(409,"resource_source_unconfigured");
        this.scheduler.placements.require(scope,workerId,scope.placementGeneration);
        if(!this.scheduler.allowedWorkers(scope, {includePaused: true}).includes(workerId))throw new ExecutionError(403,"agent_worker_access_denied");
        const bundle=this.resourceSource(scope,revision);
        if(!bundle)throw new ExecutionError(404,"resource_snapshot_not_found");
        if(bundle.selection.digest!==revision)throw new ExecutionError(409,"resource_revision_mismatch");
        const verified=validateScopedResources(bundle,scope,bundle.selection);
        return Response.json(verified,{headers:{"cache-control":"no-store"}});
      }
      return Response.json({ code: "route_not_found" }, { status: 404 });
    } catch (error) { return Response.json({ code: error instanceof ExecutionError ? error.code : "invalid_worker_request" }, { status: error instanceof ExecutionError ? error.status : 422 }); }
  }
  open(ws: ServerWebSocket<WorkerSocketData>): void {
    const id = ws.data.workerId;
    this.sockets.get(id)?.close(4001, "replaced");
    const channel = new ReverseChannel(value => { if (ws.send(value) === 0) throw new Error("Worker disconnected"); });
    ws.data.channel = channel; this.sockets.set(id, ws); this.scheduler.workers.attach(id, channel);
    ws.send(JSON.stringify({ type: "desired", protocolVersion: 2 }));
  }
  message(ws: ServerWebSocket<WorkerSocketData>, raw: string | Buffer): void {
    if (this.sockets.get(ws.data.workerId) !== ws) return;
    try {
      const value = JSON.parse(String(raw));
      if (value.type === "response") { const response = z.object({ id: z.string(), status: z.number().int().min(100).max(599), body: z.unknown().optional() }).parse(value); ws.data.channel?.receive(response); return; }
      if (value.type === "heartbeat") {
        const health = healthSchema.parse(value.health); if (health.workerId !== ws.data.workerId) throw new Error("Identity mismatch");
        this.scheduler.workers.heartbeat(ws.data.workerId, health);
        ws.send(JSON.stringify({ type: "desired", protocolVersion: 2 })); return;
      }
      if (value.type === "events") {
        const binding = this.scheduler.binding(Id.parse(value.jobId));
        if (!binding || binding.handle.workerId !== ws.data.workerId || binding.handle.instanceId !== value.instanceId) throw new Error("Event binding denied");
        this.scheduler.events.ingest(value.jobId, value.instanceId, value.body); return;
      }
      throw new Error("Unknown worker message");
    } catch { ws.close(4002, "invalid worker message"); }
  }
  closed(ws: ServerWebSocket<WorkerSocketData>): void {
    ws.data.channel?.close();
    if (this.sockets.get(ws.data.workerId) !== ws) return;
    this.sockets.delete(ws.data.workerId); if (ws.data.channel) this.scheduler.workers.detach(ws.data.workerId, ws.data.channel);
  }
  list() {
    return this.scheduler.workers.list().map(w => ({ ...w, connected: this.sockets.has(w.workerId) && w.lastSeen > Date.now() - 30000,
      revoked: Boolean((this.db.prepare("SELECT revoked FROM worker_bindings WHERE worker_id=?").get(w.workerId) as { revoked: number } | undefined)?.revoked) }));
  }
  action(id: string, action: "drain" | "resume" | "revoke") {
    this.scheduler.workers.require(id);
    if (action === "revoke" && this.isLocal(id)) throw new ExecutionError(409, "local_worker_cannot_unbind");
    if (action === "drain") this.scheduler.workers.drain(id);
    else if (action === "resume") this.scheduler.workers.resume(id);
    else { this.db.prepare("UPDATE worker_bindings SET revoked=1 WHERE worker_id=?").run(id); this.scheduler.workers.drain(id); this.sockets.get(id)?.close(4003, "revoked"); }
  }
  close() { for (const ws of this.sockets.values()) { ws.data.channel?.close(); ws.terminate(); } this.sockets.clear(); }
}
