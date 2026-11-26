import {proxyExecutor} from "./model-providers/executor-proxy";
import {ShadowPreparation} from "./shadow-preparation";
import { statSync } from "node:fs";
import { z } from "zod";
import { ExecutionClient, type TokenAuthority } from "@luna/execution-transport";
import { ExecutionError } from "@luna/execution-store";
import { CONTAINER_STREAM_PATH, CONTAINER_STREAM_TOKEN_HEADER, Id } from "@luna/runner-protocol";
import { ContainerStreams } from "./container-streams";
import type { EnvironmentManager } from "./environment-manager";
import type { WorkerUpgradeManager } from "./upgrade";
import type { WorkerModelProviderManager } from "./model-providers/manager";
import { WORKER_MODEL_PROVIDER_CAPABILITY } from "@luna/runner-protocol";

export class ServiceLink {
  private readonly shadowPreparation:ShadowPreparation;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private localChecked = false;
  private error: string | undefined;
  private protocolReady = false;
  private localError: string | undefined;
  private healthCheck: Promise<void> | undefined;
  private requests = new Set<string>();
  readonly streams: ContainerStreams;
  constructor(private manager: EnvironmentManager, private grants: TokenAuthority, readonly origin: string, private token: string, private upgrade?: WorkerUpgradeManager, private models?: WorkerModelProviderManager) {
    this.streams = new ContainerStreams(manager, manager.driver.config, (streamId, token) => {
      const url = new URL(CONTAINER_STREAM_PATH + streamId, this.origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url, { headers: { authorization: `Bearer ${this.token}`, [CONTAINER_STREAM_TOKEN_HEADER]: token } });
    });
    this.shadowPreparation=new ShadowPreparation(manager.store.db,manager.driver.config.dataRoot,manager.driver.config.workerId,origin,token);
  }
  get ready(): boolean { return this.localChecked && !this.localError && this.socket?.readyState === WebSocket.OPEN && this.protocolReady; }
  start(): void {
    this.connect();
    this.healthCheck = this.checkLocalHealth().finally(() => { this.healthCheck = undefined; });
    this.timer = setInterval(() => { if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.connect(); this.heartbeat(); this.healthCheck ??= this.checkLocalHealth().finally(() => { this.healthCheck = undefined; }); }, 10000);
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); this.streams.closeAll(); this.socket?.close(); }
  private connect(): void {
    if (this.stopped) return;
    const url = new URL("/api/worker/connect", this.origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } }); this.socket = ws; this.protocolReady = false;
    ws.onopen = () => { if (this.error === "service_connection_failed") this.error = undefined; this.heartbeat(); };
    ws.onerror = () => { this.error = "service_connection_failed"; };
    ws.onmessage = event => {
      if (this.socket !== ws) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "desired") {
          z.object({type:z.literal("desired"),protocolVersion:z.literal(2)}).strict().parse(message);
          const changed = !this.protocolReady;
          this.protocolReady = true;
          if (changed) this.heartbeat();
        } else if (message.type === "request") void this.request(ws, message);
        else if (message.type === "stream.open") this.streams.open(message);
        else ws.close();
      } catch { ws.close(); }
    };
  }
  private send(value: unknown): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
  heartbeat(): void {
    const config = this.manager.driver.config;
    const upgradeStatus = this.upgrade?.status;
    this.send({ type: "heartbeat", health: { workerId: config.workerId, imageDigest: config.imageDigest,
      ...(this.manager.driver.imageRepoDigest ? { imageRepoDigest: this.manager.driver.imageRepoDigest } : {}),
      ...(config.imageRef ? { imageRef: config.imageRef } : {}),
      ...(config.imageVariant ? { imageVariant: config.imageVariant } : {}),
      ...(this.upgrade?.workerVersion ? { workerVersion: this.upgrade.workerVersion } : {}),
      ...(this.upgrade ? { managedBinary: this.upgrade.managedBinary } : {}),
      ...(upgradeStatus && upgradeStatus.state !== "idle" ? { upgrade: upgradeStatus } : {}),
      capacity: config.capacity,
      occupied: this.manager.store.list().reduce((n, e) => n + this.manager.store.active(e.id).length, 0), ready: this.ready,
      capabilities:["shadow-scope-v2","container-streams-v1","scope-reconcile-v1","home-upload-v1","owner-workspace-v1",...(this.models ? [WORKER_MODEL_PROVIDER_CAPABILITY] : []),...(this.upgrade ? ["worker-upgrade-v1"] : [])],
      error: this.localError ?? this.error, projects: config.projects.map(p => p.projectId) } });
  }
  events(jobId: string, instanceId: string, body: unknown): void {
    this.models?.observeEvents(jobId,instanceId,body);
    if (this.socket?.readyState !== WebSocket.OPEN) throw new ExecutionError(503, "service_disconnected");
    this.send({ type: "events", jobId, instanceId, body });
  }
  private async checkLocalHealth(): Promise<void> {
    try {
      for (const project of this.manager.driver.config.projects) if (!statSync(project.hostPath).isDirectory()) throw new Error("project");
    } catch { this.localError = "project_unavailable"; this.heartbeat(); return; }
    try { await this.manager.driver.health(); this.localError = undefined; }
    catch { this.localError = "docker_unavailable"; }
    this.localChecked = true;
    this.heartbeat();
  }
  private async request(ws: WebSocket, input: unknown): Promise<void> {
    const parsed = z.object({ id: z.string().uuid(), method: z.enum(["GET", "POST", "PUT", "DELETE"]), path: z.string().max(512), body: z.unknown().optional() }).safeParse(input);
    if (!parsed.success) { ws.close(); return; }
    const request = parsed.data;
    if (this.requests.size >= 256) { ws.send(JSON.stringify({ type: "response", id: request.id, status: 503, body: { code: "worker_busy" } })); return; }
    this.requests.add(request.id);
    try {
      let result: unknown;
      if (request.path === "/v2/context-prepare") result = await this.shadowPreparation.prepare(request.body);
      else if(request.path==="/v2/context-preparations/release")result=this.shadowPreparation.store.release(request.body);
      else if (request.path === "/v1/executor") {
        result = await proxyExecutor(this.manager,this.grants,this.models,request.body);
      } else {
        if (["/v1/environments/prepare", "/v1/files", "/v1/containers/provision"].includes(request.path) && !this.ready) throw new ExecutionError(503, "worker_not_ready");
        result = await new ExecutionClient(`http://127.0.0.1:${this.manager.driver.config.port}`, this.manager.driver.config.controlToken).call(request.method, request.path, request.body);
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", id: request.id, status: 200, body: result }));
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", id: request.id, status: error instanceof ExecutionError ? error.status : 422, body: { code: error instanceof ExecutionError ? error.code : "worker_operation_failed" } }));
    } finally { this.requests.delete(request.id); }
  }
}
