import {CONTAINER_HOME,WorkerShadowLayouts,containerPath} from "./shadow-layout";
import {WorkerShadowMounts,type ShadowMountPlan} from "./shadow-mounts";
import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { ExecutionError, contentHash, writePrivateJson, type SqlDatabase } from "@luna/execution-store";
import type { WorkerConfig } from "./config";
import type { EnvironmentRecord } from "./environment-store";
import { WorkerContextStore, type WorkerContext } from "./context-store";
import { ProjectMounts } from "./project-mounts";
import { rootHostCheck, type RootHostCheck } from "./root-host";
import { currentRunnerRuntime, RUNNER_RUNTIME_MOUNT, type RunnerRuntime } from "./runner-runtime";

const execute = promisify(execFile);
interface Deployment { port: number; controlToken: string; maintenanceToken: string; }
interface DockerInspection { Id: string; State: { Running: boolean }; Config: { Labels: Record<string, string> }; Mounts: { Source: string; Destination: string; Type: string; Name?: string; RW?: boolean }[]; }

/** Docker access is exclusively on Worker. Commands and mounts come from deployment config. */
export class DockerEnvironmentDriver {
  readonly contexts: WorkerContextStore;
  private readonly layouts: WorkerShadowLayouts;
  private hostCpus?: number;
  /**
   * The Executor and `luna` CLI shipped with this Worker. Without it (a Worker run from source,
   * or tests) containers run the copies baked into the image.
   */
  private readonly runtime: RunnerRuntime | undefined;
  constructor(private readonly db: SqlDatabase, readonly config: WorkerConfig, runtime?: RunnerRuntime) {
    this.runtime = runtime;
    this.contexts = new WorkerContextStore(db);
    mkdirSync(config.dataRoot,{recursive:true});
    this.layouts = new WorkerShadowLayouts(db,config.dataRoot);
    db.exec("CREATE TABLE IF NOT EXISTS worker_deployments (environment_id TEXT PRIMARY KEY,port INTEGER UNIQUE NOT NULL,body TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS worker_executor_versions (environment_id TEXT PRIMARY KEY,version TEXT NOT NULL)");
  }
  /** Worker resolves a context inside its immutable Shadow layout; caller paths only assert equality. */
  async prepareContext(scope:ResourceScope,contextId:string,scopeKey:string,projectId?:string,requestedCwd?:string):Promise<WorkerContext> {
    this.layouts.ensure(scope);
    // Preparation already chose the context's directory; this only checks the caller agrees.
    const {containerCwd}=this.layouts.context(scope,contextId);
    if(requestedCwd!==undefined && requestedCwd!==containerCwd)throw new ExecutionError(409,"context_directory_conflict");
    const context=this.contexts.ensure(contextId,scopeKey);
    new ProjectMounts(this.db,this.config).bind(contextId,projectId);
    return context;
  }
  /** A context's working directory as its container sees it. */
  contextPath(contextId:string):string|undefined {
    const row=this.db.prepare("SELECT p.cwd, l.home FROM worker_shadow_context_paths p JOIN worker_shadow_layouts l ON l.shadow_id=p.shadow_id WHERE p.context_id=?").get(contextId) as {cwd:string;home:string}|undefined;
    return row && containerPath({home:CONTAINER_HOME,homeSource:row.home},row.cwd);
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
    const inspected = await this.docker(["image", "inspect", this.config.imageDigest]);
    if (!this.config.imageRef) {
      const detected = extractImageRefFromInspect(inspected);
      if (detected) this.config.imageRef = detected;
    }
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
  /** The container this Worker would launch now: its arguments, Executor configuration and their hash. */
  private launchSpec(environment: EnvironmentRecord, requiredContextId?: string) {
    const plan=this.mountPlan(environment,requiredContextId),{layout,mounts}=plan;
    const deployment = this.deployment(environment.id);
    const configFile = join(this.executorDirectory(environment), "executor.json");
    // The snapshot version is not launch configuration: it switches through the HOME link.
    const executorConfig = { protocolVersion:2,scope:environment.spec.scope,instanceId: environment.instanceId, runtimeId: this.config.runtimeId, workerId: this.config.workerId,
      runtimeEndpoint: this.config.runtimeEndpoint, capacity: this.config.capacity,
      runnerLayout: { home: layout.home, runners: layout.runners },
      runnerUid: this.config.runnerUid, runnerGid: this.config.runnerGid, runnerSudo: this.rootAllowed(environment), controlToken: deployment.controlToken, maintenanceToken: deployment.maintenanceToken };
    const volume = this.volume(environment);
    const args = ["run", "--detach", "--init", "--name", this.name(environment), "--label", `luna.worker=${this.config.workerId}`, "--label", `luna.instance=${environment.instanceId}`,
      "--label", `luna.agent=${environment.spec.scope.agentId}`, "--label", `luna.shadow=${environment.spec.scope.shadowId}`, "--label", `luna.placement=${environment.spec.scope.placementGeneration}`,
      "--user", "0:0", "--cap-drop", "ALL", ...["CHOWN", "DAC_OVERRIDE", "KILL", "SETUID", "SETGID", "SETPCAP"].flatMap((cap) => ["--cap-add", cap]),
      ...(this.rootAllowed(environment) ? [] : ["--security-opt", "no-new-privileges"]), "--tmpfs", "/tmp:rw,exec,nosuid,nodev,mode=1777", "--network", this.config.network,
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
    // The mounted runtime root is stable, so a new Worker version changes no launch argument:
    // the container restarts onto it instead of being replaced.
    if (this.runtime) args.push("--mount", `type=bind,src=${this.runtime.root},dst=${RUNNER_RUNTIME_MOUNT},readonly`);
    const command = ["--entrypoint", "bun", this.config.imageDigest,
      this.runtime ? `${RUNNER_RUNTIME_MOUNT}/current/executor.js` : "/app/agent-runner/dist/executor.js"];
    const configuration = contentHash({ args, command, executorConfig });
    return { plan, mounts, configFile, executorConfig, volume, args, command, configuration };
  }
  /** Whether a container was launched with the mounts and configuration this Worker uses now. */
  current(environment: EnvironmentRecord, prior: DockerInspection): boolean {
    const { mounts, configuration } = this.launchSpec(environment);
    return launchedWith(prior, mounts, configuration);
  }
  /** Where a container mounts the Shadow HOME, which an older container may have at another path. */
  mountedHome(environment: EnvironmentRecord, prior: DockerInspection): string {
    const source = this.layouts.ensure(environment.spec.scope).homeSource;
    return prior.Mounts.find(mount => mount.Type === "bind" && hostSourceNames(source).includes(mount.Source))?.Destination ?? this.home(environment);
  }
  async ensure(environment: EnvironmentRecord, requiredContextId?: string): Promise<string> {
    if (environment.spec.imageDigest !== this.config.imageDigest || environment.spec.callbackRuntimeId !== this.config.runtimeId) throw new ExecutionError(409, "worker_configuration_conflict");
    const prior = await this.inspect(environment);
    const { plan, mounts, configFile, executorConfig, volume, args, command, configuration } = this.launchSpec(environment, requiredContextId);
    if (prior && launchedWith(prior, mounts, configuration)) {
      const resourceMounts = new WorkerShadowMounts(this.db, this.config.dataRoot);
      if (prior.State.Running) await this.switchResourcesInside(prior.Id, resourceMounts.pendingSwitch(plan));
      else { resourceMounts.activate(plan); await this.docker(["container", "start", prior.Id]); this.startedExecutor(environment); }
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
    const id = (await this.docker(args)).trim();
    this.startedExecutor(environment);
    return id;
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
  /** Record which runtime version the container's Executor started from. */
  private startedExecutor(environment: EnvironmentRecord): void {
    const version = this.runtime && currentRunnerRuntime(this.runtime.root);
    if (version) this.db.prepare("INSERT INTO worker_executor_versions VALUES (?,?) ON CONFLICT(environment_id) DO UPDATE SET version=excluded.version").run(environment.id, version);
  }
  /** A running container whose Executor is older than the one this Worker ships: a restart updates it. */
  async executorOutdated(environment: EnvironmentRecord): Promise<boolean> {
    if (!this.runtime) return false;
    const row = this.db.prepare("SELECT version FROM worker_executor_versions WHERE environment_id=?").get(environment.id) as { version: string } | undefined;
    if (row?.version === this.runtime.version) return false;
    return (await this.inspect(environment))?.State.Running === true;
  }
  /** Stop the container and keep it, with its writable system layer, for the next start. */
  async stop(environment: EnvironmentRecord): Promise<void> {
    const inspection = await this.inspect(environment);
    if (inspection?.State.Running) await this.docker(["container", "stop", "--time", "20", inspection.Id]);
  }
  async remove(environment: EnvironmentRecord): Promise<void> {
    const inspection = await this.inspect(environment);
    if (inspection) await this.docker(["container", "rm", "--force", inspection.Id]);
    this.db.prepare("DELETE FROM worker_deployments WHERE environment_id=?").run(environment.id);
    this.db.prepare("DELETE FROM worker_executor_versions WHERE environment_id=?").run(environment.id);
    rmSync(this.executorDirectory(environment), { recursive: true, force: true });
  }
  /** Atomically repoint $HOME/.luna-resources from inside a running container (see pendingSwitch). */
  private async switchResourcesInside(containerId: string, change: { link: string; target: string } | undefined): Promise<void> {
    if (!change) return;
    const user = `${this.config.runnerUid}:${this.config.runnerGid}`, temporary = `${change.link}.${randomBytes(8).toString("hex")}`;
    await this.docker(["exec", "-u", user, containerId, "ln", "-s", change.target, temporary]);
    await this.docker(["exec", "-u", user, containerId, "mv", "-T", temporary, change.link]);
  }
  volume(environment: EnvironmentRecord): string { return `luna-${contentHash(this.config.workerId).slice(0, 12)}-${environment.id}`; }
  /** Shadows with a HOME layout on this Worker. */
  layoutScopes(): ResourceScope[] { return this.layouts.scopes(); }
  /** A Shadow's HOME and resource directories, as purgeShadowFiles would delete them. */
  shadowDirectories(scope: ResourceScope): string[] { return this.layouts.directories(scope); }
  /**
   * This Worker's containers and /data volumes that no environment record names, e.g. left
   * behind when the Worker database was replaced. Only objects labelled for this Worker count.
   */
  async strays(environments: readonly EnvironmentRecord[]): Promise<{ containers: string[]; volumes: string[] }> {
    const label = `label=luna.worker=${this.config.workerId}`;
    const names = new Set(environments.map(environment => this.name(environment)));
    const volumes = new Set(environments.map(environment => this.volume(environment)));
    const prefix = `luna-${contentHash(this.config.workerId).slice(0, 12)}-`;
    const lines = (output: string) => output.split("\n").map(line => line.trim()).filter(Boolean);
    return {
      containers: lines(await this.docker(["container", "ls", "--all", "--filter", label, "--format", "{{.Names}}"]))
        .filter(name => name.startsWith("luna-exec-") && !names.has(name)),
      volumes: lines(await this.docker(["volume", "ls", "--filter", label, "--format", "{{.Name}}"]))
        .filter(name => name.startsWith(prefix) && !volumes.has(name)),
    };
  }
  async removeStrays(strays: { containers: readonly string[]; volumes: readonly string[] }): Promise<void> {
    for (const name of strays.containers) await this.docker(["container", "rm", "--force", name]);
    for (const name of strays.volumes) await this.docker(["volume", "rm", "--force", name]);
  }
  /** The environment's /data volume; only a deleted Shadow's environments are removed with it. */
  async removeVolume(environment: EnvironmentRecord): Promise<void> {
    await this.docker(["volume", "rm", "--force", this.volume(environment)]);
  }
  /**
   * Delete a deleted Shadow's HOME and resource directories and their records. Files that
   * container root created can be unremovable for the Worker user; a root helper removes them.
   */
  async purgeShadowFiles(scope: ResourceScope): Promise<void> {
    for (const directory of this.layouts.remove(scope)) {
      try { rmSync(directory, { recursive: true, force: true }); continue; }
      catch (error) { if (!["EACCES", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      await this.docker(["run", "--rm", "--user", "0:0", "--network", "none", "--entrypoint", "rm",
        "--mount", `type=bind,src=${dirname(directory)},dst=/purge`, this.config.imageDigest, "-rf", `/purge/${basename(directory)}`]);
    }
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
  /** The Shadow HOME on this host, which the container mounts at `home`. */
  homeSource(environment: EnvironmentRecord): string { return this.layouts.ensure(environment.spec.scope).homeSource; }
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

function launchedWith(prior: DockerInspection, mounts: ShadowMountPlan["mounts"], configuration: string): boolean {
  return mounts.every(({ source, destination, readonly }) =>
    prior.Mounts.some(mount => mount.Type === "bind" && mount.Destination === destination &&
      mount.RW === !readonly && hostSourceNames(source).includes(mount.Source)))
    && prior.Config.Labels["luna.configuration"] === configuration;
}

/** Docker Desktop may report its VM-side /host_mnt path after starting a bind mount. */
function hostSourceNames(path: string): string[] { return process.platform === "darwin" ? [path, `/host_mnt${path}`] : [path]; }

/** Derive a display/pull image reference from `docker image inspect` JSON when worker.json has no imageRef. */
export function extractImageRefFromInspect(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!item || typeof item !== "object") return undefined;
    const record = item as { RepoTags?: unknown; RepoDigests?: unknown };
    const tags = Array.isArray(record.RepoTags)
      ? record.RepoTags.filter((t): t is string => typeof t === "string" && t.length > 0 && t !== "<none>:<none>")
      : [];
    if (tags.length > 0) {
      return tags.find(tag => tag.includes("/")) ?? tags[0];
    }
    const digests = Array.isArray(record.RepoDigests)
      ? record.RepoDigests.filter((d): d is string => typeof d === "string" && d.length > 0)
      : [];
    return digests[0];
  } catch {
    return undefined;
  }
}
