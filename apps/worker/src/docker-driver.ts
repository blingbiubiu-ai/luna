import {WorkerShadowLayouts,type ShadowLayout} from "./shadow-layout";
import {WorkerShadowMounts,type ShadowBindMount} from "./shadow-mounts";
import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ExecutionError, contentHash, writePrivateJson, type SqlDatabase } from "@luna/execution-store";
import type { WorkerConfig } from "./config";
import type { EnvironmentRecord } from "./environment-store";
import { WorkerContextStore, type WorkerContext } from "./context-store";
import { ProjectMounts } from "./project-mounts";

const execute = promisify(execFile);
interface Deployment { port: number; controlToken: string; maintenanceToken: string; }
interface DockerInspection { Id: string; State: { Running: boolean }; Config: { Labels: Record<string, string> }; Mounts: { Source: string; Destination: string; Type: string; Name?: string; RW?: boolean }[]; }

/** Docker access is exclusively on Worker. Commands and mounts come from deployment config. */
export class DockerEnvironmentDriver {
  readonly contexts: WorkerContextStore;
  private readonly layouts: WorkerShadowLayouts;
  constructor(private readonly db: SqlDatabase, readonly config: WorkerConfig) {
    this.contexts = new WorkerContextStore(db);
    mkdirSync(config.dataRoot,{recursive:true});
    this.layouts = new WorkerShadowLayouts(db,config.dataRoot);
    db.exec("CREATE TABLE IF NOT EXISTS worker_deployments (environment_id TEXT PRIMARY KEY,port INTEGER UNIQUE NOT NULL,body TEXT NOT NULL)");
  }
  /** Worker resolves a context inside its immutable Shadow layout; caller paths only assert equality. */
  async prepareContext(scope:ResourceScope,contextId:string,scopeKey:string,projectId?:string,requestedCwd?:string):Promise<WorkerContext> {
    const layout=this.layouts.ensure(scope);
    const expected=join(layout.runners,contextId);
    if(requestedCwd!==undefined && requestedCwd!==expected)throw new ExecutionError(409,"context_directory_conflict");
    const {cwd}=this.layouts.context(scope,contextId);
    const context=this.contexts.ensure(contextId,scopeKey);
    new ProjectMounts(this.db,this.config).bind(contextId,projectId);
    if(cwd!==expected)throw new ExecutionError(409,"context_directory_conflict");
    return context;
  }
  contextPath(contextId:string):string|undefined {
    return (this.db.prepare("SELECT cwd FROM worker_shadow_context_paths WHERE context_id=?").get(contextId) as {cwd:string}|undefined)?.cwd;
  }
  /** Build the scoped bind set used by ensure. */
  mountPlan(environment:EnvironmentRecord,requiredContextId?:string):{layout:ShadowLayout;mounts:ShadowBindMount[]} {
    const plan=new WorkerShadowMounts(this.db,this.config.dataRoot).prepare(environment.spec.scope,environment.spec.resourceSelection);
    if(requiredContextId){
      const row=this.db.prepare("SELECT shadow_id FROM worker_shadow_context_paths WHERE context_id=?").get(requiredContextId) as {shadow_id:string}|undefined;
      if(!row || row.shadow_id!==environment.spec.scope.shadowId)throw new ExecutionError(409,"context_shadow_conflict");
    }
    return plan;
  }
  async health(): Promise<void> { await this.docker(["image", "inspect", this.config.imageDigest]); }
  async preflight(): Promise<void> {
    new ProjectMounts(this.db, this.config).prepare();
    await this.docker(["image", "inspect", this.config.imageDigest]);
    try { await this.docker(["network", "inspect", this.config.network]); }
    catch { await this.docker(["network", "create", this.config.network]); }
  }
  deployment(environmentId: string): Deployment {
    this.db.prepare("DELETE FROM worker_deployments WHERE environment_id<>? AND environment_id IN (SELECT id FROM worker_environments WHERE json_extract(record_json,'$.state')='stopped' AND json_extract(record_json,'$.containerId') IS NULL)").run(environmentId);
    const row = this.db.prepare("SELECT body FROM worker_deployments WHERE environment_id=?").get(environmentId) as { body: string } | undefined;
    if (row) return JSON.parse(row.body) as Deployment;
    const occupied = new Set((this.db.prepare("SELECT port FROM worker_deployments").all() as { port: number }[]).map((item) => item.port));
    let port = this.config.executorPortStart;
    while (occupied.has(port) && port <= this.config.executorPortEnd) port++;
    if (port > this.config.executorPortEnd) throw new ExecutionError(503, "executor_ports_exhausted");
    const deployment = { port, controlToken: randomBytes(32).toString("base64url"), maintenanceToken: randomBytes(32).toString("base64url") };
    this.db.prepare("INSERT INTO worker_deployments VALUES (?,?,?)").run(environmentId, port, JSON.stringify(deployment));
    return deployment;
  }
  endpoint(environmentId: string): string {
    const host = this.config.executorHost.includes(":") ? `[${this.config.executorHost}]` : this.config.executorHost;
    return `http://${host}:${this.deployment(environmentId).port}`;
  }
  async inspect(environment: EnvironmentRecord): Promise<DockerInspection | null> {
    let output: string;
    try { output = await this.docker(["container", "inspect", this.name(environment)]); }
    catch (error) {
      if (error instanceof ExecutionError && error.code === "docker_object_missing") return null;
      throw error;
    }
    const inspection = (JSON.parse(output) as DockerInspection[])[0];
    if (!inspection || inspection.Config.Labels["luna.worker"] !== this.config.workerId || inspection.Config.Labels["luna.instance"] !== environment.instanceId
      || inspection.Config.Labels["luna.agent"]!==environment.spec.scope.agentId || inspection.Config.Labels["luna.shadow"]!==environment.spec.scope.shadowId
      || inspection.Config.Labels["luna.placement"]!==String(environment.spec.scope.placementGeneration)) throw new ExecutionError(409, "container_identity_conflict");
    return inspection;
  }
  async ensure(environment: EnvironmentRecord, requiredContextId?: string): Promise<string> {
    if (environment.spec.imageDigest !== this.config.imageDigest || environment.spec.callbackRuntimeId !== this.config.runtimeId) throw new ExecutionError(409, "worker_configuration_conflict");
    const prior = await this.inspect(environment);
    const {layout,mounts}=this.mountPlan(environment,requiredContextId);
    const deployment = this.deployment(environment.id);
    const configFile = join(this.executorDirectory(environment), "executor.json");
    const executorConfig = { protocolVersion:2,scope:environment.spec.scope,resourceSelection:environment.spec.resourceSelection,instanceId: environment.instanceId, runtimeId: this.config.runtimeId, workerId: this.config.workerId,
      runtimeEndpoint: this.config.runtimeEndpoint, capacity: this.config.capacity,
      runnerLayout: { home: layout.home, runners: layout.runners },
      runnerUid: this.config.runnerUid, runnerGid: this.config.runnerGid, controlToken: deployment.controlToken, maintenanceToken: deployment.maintenanceToken };
    const volume = `luna-${contentHash(this.config.workerId).slice(0, 12)}-${environment.id}`;
    const args = ["run", "--detach", "--init", "--name", this.name(environment), "--label", `luna.worker=${this.config.workerId}`, "--label", `luna.instance=${environment.instanceId}`,
      "--label", `luna.agent=${environment.spec.scope.agentId}`, "--label", `luna.shadow=${environment.spec.scope.shadowId}`, "--label", `luna.placement=${environment.spec.scope.placementGeneration}`,
      "--user", "0:0", "--cap-drop", "ALL", ...["CHOWN", "DAC_OVERRIDE", "KILL", "SETUID", "SETGID", "SETPCAP"].flatMap((cap) => ["--cap-add", cap]),
      "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--network", this.config.network,
      "--add-host", "host.docker.internal:host-gateway", "--publish", `${this.config.publishHost}:${deployment.port}:8080`,
      "--memory", environment.spec.resources.memory, "--cpus", String(environment.spec.resources.cpus), "--pids-limit", String(environment.spec.resources.pidsLimit),
      "--mount", `type=volume,src=${volume},dst=/data`, "--mount", `type=bind,src=${configFile},dst=/run/luna/executor.json,readonly`,
    ];
    for (const { source, destination, readonly } of mounts.sort((a, b) => a.destination.localeCompare(b.destination))) {
      args.push("--mount", `type=bind,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`);
    }
    // Hash the actual launch arguments and Executor configuration, not mutable
    // HOME/project contents. Containers must already carry the scoped identity labels.
    const command = ["--entrypoint", "bun", this.config.imageDigest, "/app/agent-runner/dist/executor.js"];
    const configuration = contentHash({ args, command, executorConfig });
    const mountsMatch = prior && mounts.every(({ source, destination, readonly }) =>
      prior.Mounts.some(mount => mount.Type === "bind" && mount.Destination === destination &&
        mount.RW === !readonly && hostSourceNames(source).includes(mount.Source)));
    if (prior && mountsMatch && prior.Config.Labels["luna.configuration"] === configuration) {
      if (!prior.State.Running) await this.docker(["container", "start", prior.Id]);
      return prior.Id;
    }
    // EnvironmentManager fences replacement of running containers until idle.
    if (prior?.State.Running) throw new ExecutionError(409, "container_configuration_update_required");
    if (prior) await this.docker(["container", "rm", prior.Id]);
    writePrivateJson(configFile, executorConfig);
    await this.docker(["volume", "create", "--label", `luna.worker=${this.config.workerId}`, volume]);
    args.push("--label", `luna.configuration=${configuration}`, ...command);
    return (await this.docker(args)).trim();
  }
  async remove(environment: EnvironmentRecord): Promise<void> {
    const inspection = await this.inspect(environment);
    if (inspection) await this.docker(["container", "rm", "--force", inspection.Id]);
    this.db.prepare("DELETE FROM worker_deployments WHERE environment_id=?").run(environment.id);
    rmSync(this.executorDirectory(environment), { recursive: true, force: true });
  }
  private executorDirectory(environment: EnvironmentRecord): string {
    return this.layouts.executorDirectory(environment.spec.scope, environment.id);
  }
  private name(environment: EnvironmentRecord): string { return `luna-exec-${environment.spec.mode}-${contentHash([this.config.workerId, environment.id]).slice(0, 16)}`; }
  private async docker(args: string[]): Promise<string> {
    try { const result = await execute("docker", args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); return result.stdout; }
    catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      throw new ExecutionError(503, /No such (object|container)/.test(stderr) ? "docker_object_missing" : "docker_operation_failed");
    }
  }
}

/** Docker Desktop may report its VM-side /host_mnt path after starting a bind mount. */
function hostSourceNames(path: string): string[] { return process.platform === "darwin" ? [path, `/host_mnt${path}`] : [path]; }
