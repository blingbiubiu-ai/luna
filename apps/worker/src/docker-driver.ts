import {WorkerShadowLayouts} from "./shadow-layout";
import {WorkerShadowMounts,type ShadowMountPlan} from "./shadow-mounts";
import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { ExecutionError, contentHash, writePrivateJson, type SqlDatabase } from "@luna/execution-store";
import type { WorkerConfig } from "./config";
import type { EnvironmentRecord } from "./environment-store";
import { WorkerContextStore, type WorkerContext } from "./context-store";
import { ProjectMounts } from "./project-mounts";
import { rootHostCheck, type RootHostCheck } from "./root-host";

const execute = promisify(execFile);
interface Deployment { port: number; controlToken: string; maintenanceToken: string; }
interface DockerInspection { Id: string; State: { Running: boolean }; Config: { Labels: Record<string, string> }; Mounts: { Source: string; Destination: string; Type: string; Name?: string; RW?: boolean }[]; }

/** Docker access is exclusively on Worker. Commands and mounts come from deployment config. */
export class DockerEnvironmentDriver {
  readonly contexts: WorkerContextStore;
  private readonly layouts: WorkerShadowLayouts;
  private hostCpus?: number;
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
  mountPlan(environment:EnvironmentRecord,requiredContextId?:string):ShadowMountPlan {
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
    const plan=this.mountPlan(environment,requiredContextId),{layout,mounts}=plan;
    const deployment = this.deployment(environment.id);
    const configFile = join(this.executorDirectory(environment), "executor.json");
    // The snapshot version is not launch configuration: it switches through the HOME link.
    const executorConfig = { protocolVersion:2,scope:environment.spec.scope,instanceId: environment.instanceId, runtimeId: this.config.runtimeId, workerId: this.config.workerId,
      runtimeEndpoint: this.config.runtimeEndpoint, capacity: this.config.capacity,
      runnerLayout: { home: layout.home, runners: layout.runners },
      runnerUid: this.config.runnerUid, runnerGid: this.config.runnerGid, runnerSudo: this.rootAllowed(environment), controlToken: deployment.controlToken, maintenanceToken: deployment.maintenanceToken };
    const volume = `luna-${contentHash(this.config.workerId).slice(0, 12)}-${environment.id}`;
    const args = ["run", "--detach", "--init", "--name", this.name(environment), "--label", `luna.worker=${this.config.workerId}`, "--label", `luna.instance=${environment.instanceId}`,
      "--label", `luna.agent=${environment.spec.scope.agentId}`, "--label", `luna.shadow=${environment.spec.scope.shadowId}`, "--label", `luna.placement=${environment.spec.scope.placementGeneration}`,
      "--user", "0:0", "--cap-drop", "ALL", ...["CHOWN", "DAC_OVERRIDE", "KILL", "SETUID", "SETGID", "SETPCAP"].flatMap((cap) => ["--cap-add", cap]),
      ...(this.rootAllowed(environment) ? [] : ["--security-opt", "no-new-privileges"]), "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--network", this.config.network,
      "--add-host", "host.docker.internal:host-gateway", "--publish", `${this.config.publishHost}:${deployment.port}:8080`,
      "--mount", `type=volume,src=${volume},dst=/data`, "--mount", `type=bind,src=${configFile},dst=/run/luna/executor.json,readonly`,
    ];
    for (const { source, destination, readonly } of mounts.sort((a, b) => a.destination.localeCompare(b.destination))) {
      args.push("--mount", `type=bind,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`);
    }
    // Hash the actual launch arguments and Executor configuration, not mutable
    // HOME/project contents. Containers must already carry the scoped identity labels.
    // Resource limits are excluded: updateLimits applies them to the running container,
    // so the writable system layer survives limit changes.
    const command = ["--entrypoint", "bun", this.config.imageDigest, "/app/agent-runner/dist/executor.js"];
    const configuration = contentHash({ args, command, executorConfig });
    const mountsMatch = prior && mounts.every(({ source, destination, readonly }) =>
      prior.Mounts.some(mount => mount.Type === "bind" && mount.Destination === destination &&
        mount.RW === !readonly && hostSourceNames(source).includes(mount.Source)));
    if (prior && mountsMatch && prior.Config.Labels["luna.configuration"] === configuration) {
      new WorkerShadowMounts(this.db, this.config.dataRoot).activate(plan);
      if (!prior.State.Running) await this.docker(["container", "start", prior.Id]);
      return prior.Id;
    }
    // EnvironmentManager fences replacement of running containers until idle.
    // The link is left alone: the old container's Jobs may still read their snapshot.
    if (prior?.State.Running) throw new ExecutionError(409, "container_configuration_update_required");
    if (prior) await this.docker(["container", "rm", prior.Id]);
    new WorkerShadowMounts(this.db, this.config.dataRoot).activate(plan);
    writePrivateJson(configFile, executorConfig);
    await this.docker(["volume", "create", "--label", `luna.worker=${this.config.workerId}`, volume]);
    args.push(...await this.limitArgs(environment.spec.resources), "--label", `luna.configuration=${configuration}`, ...command);
    return (await this.docker(args)).trim();
  }
  /** Apply changed limits in place; a missing container takes them at creation. */
  async updateLimits(environment: EnvironmentRecord, resources: EnvironmentRecord["spec"]["resources"]): Promise<void> {
    const prior = await this.inspect(environment);
    if (!prior) return;
    // Docker run defaults swap to twice the memory limit; keep that when updating.
    const swap = 2 * memoryBytes(resources.memory);
    await this.docker(["container", "update", ...await this.limitArgs(resources), "--memory-swap", String(swap), prior.Id]);
  }
  private async limitArgs(resources: EnvironmentRecord["spec"]["resources"]): Promise<string[]> {
    return ["--memory", resources.memory, "--cpus", String(effectiveCpus(resources.cpus, await this.dockerHostCpus())), "--pids-limit", String(resources.pidsLimit)];
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
  name(environment: EnvironmentRecord): string { return `luna-exec-${environment.spec.mode}-${contentHash([this.config.workerId, environment.id]).slice(0, 16)}`; }
  /** Whether this host's Shadow HOME mount permits container root (nosuid on Linux, Docker Desktop on macOS). */
  hostRootStatus(environment: EnvironmentRecord): RootHostCheck {
    return rootHostCheck(this.layouts.ensure(environment.spec.scope).homeSource);
  }
  /** Root takes effect only when the Shadow switch is on and this host's HOME passes the nosuid check. */
  rootStatus(environment: EnvironmentRecord): RootHostCheck | undefined {
    return environment.spec.rootAccess ? this.hostRootStatus(environment) : undefined;
  }
  rootAllowed(environment: EnvironmentRecord): boolean { return this.rootStatus(environment)?.allowed === true; }
  /** Stop the on-demand Xvfb/openbox/Chrome desktop session inside a running container. */
  async stopDesktop(environment: EnvironmentRecord): Promise<void> {
    const inspection = await this.inspect(environment);
    if (!inspection?.State.Running) return;
    await this.docker(["exec", "-u", `${this.config.runnerUid}:${this.config.runnerGid}`,
      "-e", `HOME=${this.home(environment)}`, inspection.Id, "luna-desktop", "stop"]);
  }
  /** The Shadow HOME as mounted inside its container. */
  home(environment: EnvironmentRecord): string { return this.layouts.ensure(environment.spec.scope).home; }
  /** One Docker call for all of this Worker's containers: name -> running. */
  async containerStates(): Promise<Map<string, boolean>> {
    const output = await this.docker(["container", "ls", "--all", "--filter", `label=luna.worker=${this.config.workerId}`, "--format", "{{.Names}}\t{{.State}}"]);
    return new Map(output.split("\n").filter(Boolean).map(line => { const [name = "", state] = line.split("\t"); return [name, state === "running"]; }));
  }
  /** Docker rejects --cpus above the daemon's CPU count, so Service-wide defaults are capped per Worker host. */
  private async dockerHostCpus(): Promise<number> {
    if (this.hostCpus === undefined) {
      const reported = Number((await this.docker(["info", "--format", "{{.NCPU}}"]).catch(() => "")).trim());
      this.hostCpus = Number.isFinite(reported) && reported > 0 ? reported : availableParallelism();
    }
    return this.hostCpus;
  }
  private async docker(args: string[]): Promise<string> {
    try { const result = await execute("docker", args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); return result.stdout; }
    catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      if (/No such (object|container)/.test(stderr)) throw new ExecutionError(503, "docker_object_missing");
      const failure = new ExecutionError(503, "docker_operation_failed", { operation: args.slice(0, 2).join(" "), stderr: stderr.slice(0, 2000) });
      console.error(JSON.stringify({ level: "error", msg: "Docker operation failed", ...failure.details }));
      throw failure;
    }
  }
}

/** Cap the requested CPU quota at what the Docker host can grant. */
export function effectiveCpus(requested: number, hostCpus: number): number {
  return hostCpus > 0 ? Math.min(requested, hostCpus) : requested;
}

/** Bytes for a Docker memory value such as "512m" or "32g". */
export function memoryBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(value.trim());
  if (!match) throw new ExecutionError(422, "invalid_memory_limit");
  const unit = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]!.toLowerCase() as "" | "b" | "k" | "m" | "g"];
  return Math.round(Number(match[1]) * unit);
}

/** Docker Desktop may report its VM-side /host_mnt path after starting a bind mount. */
function hostSourceNames(path: string): string[] { return process.platform === "darwin" ? [path, `/host_mnt${path}`] : [path]; }
