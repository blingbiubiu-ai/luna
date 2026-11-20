import { z } from "zod";
import { Assignment, Credentials, ExecutionScope,Id, JobSubmission, isTerminal } from "@luna/runner-protocol";
import { ExecutionError,contentHash,canonicalJson,type SqlDatabase } from "@luna/execution-store";
import { TokenAuthority, executionServer, json, readJson, requirePeer } from "@luna/execution-transport";
import { ExecutorStore } from "./store";
import { ExecutorContexts } from "./contexts";
import { ExecutorProcesses } from "./processes";
import { executeFileOperation } from "./file-operation";
import { ExecutorEventReporter } from "./event-reporter";

import { absoluteRunnerPath, runnerResourcesPath, type RunnerLayout } from "@luna/runner-protocol/runner-assets";
import { readlinkSync } from "node:fs";
import { basename } from "node:path";

const BoundRequest = z.object({ assignment: Assignment }).strict();
const CredentialRequest = z.object({ assignment: Assignment, credentials: Credentials }).strict();
const IngestCredential = z.object({ credentialId: Id, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), runtimeId: Id }).strict();
export interface ExecutorConfig {
  /** The snapshot version is not fixed per Executor: Worker switches $HOME/.luna-resources between Jobs. */
  scope:ExecutionScope;
  instanceId: string; runtimeId: string; workerId: string; dataRoot: string; runnerEntry: string;
  ptyRunnerEntry?: string;
  runtimeEndpoint: string; capacity: number; runnerLayout?: RunnerLayout; runnerUid?: number; runnerGid?: number;
  /** The container allows sudo (Shadow root switch on a host that permits it); Jobs still need `privileged`. */
  runnerSudo?: boolean;
}

/** Only Runtime controls Jobs; Worker has initialization and non-secret inspection rights. */
export function createExecutor(db: SqlDatabase, authority: TokenAuthority, config: ExecutorConfig) {
  const scope=ExecutionScope.parse(config.scope);
  const requireScope=(value:ExecutionScope)=>{if(contentHash(value)!==contentHash(scope))throw new ExecutionError(403,"executor_scope_mismatch");};
  db.exec("CREATE TABLE IF NOT EXISTS executor_scope (id INTEGER PRIMARY KEY CHECK(id=1),scope_json TEXT NOT NULL)");
  const prior=db.prepare("SELECT scope_json FROM executor_scope WHERE id=1").get() as {scope_json:string}|undefined;
  if(prior && prior.scope_json!==canonicalJson(scope))throw new ExecutionError(409,"executor_volume_scope_mismatch");
  const store = new ExecutorStore(db, config.instanceId);
  for(const job of store.list())requireScope(store.binding(job.jobId).scope);
  db.prepare("INSERT OR IGNORE INTO executor_scope VALUES (1,?)").run(canonicalJson(scope));
  const contexts = new ExecutorContexts(config.dataRoot, config.runnerUid, config.runnerGid, config.runnerLayout);
  const processes = new ExecutorProcesses(store, contexts, config.runnerEntry, config.capacity, config.runnerSudo === true, config.ptyRunnerEntry);
  store.onTerminal = id => contexts.forgetCredentials(id);
  const reporter = new ExecutorEventReporter(store, config.runtimeEndpoint);
  const fileLeases = new Map<string, string>();
  const server = executionServer(authority, async ({ request, response, peer, url }) => {
    const method = request.method;
    if (peer.role === "worker") requirePeer(peer, "worker", config.workerId);
    else requirePeer(peer, "runtime", config.runtimeId);
    if (method === "GET" && url.pathname === "/v1/health") {
      json(response, 200, { instanceId: store.instanceId, bootId: store.bootId, activeJobs: processes.activeCount(), scope,capabilities: ["job-retry-v1","shadow-scope-v2"], upload: reporter.status() }); return;
    }
    const contextRegistration = /^\/v1\/contexts\/([^/]+)$/.exec(url.pathname);
    if (method === "PUT" && contextRegistration) {
      requirePeer(peer, "worker", config.workerId);
      const body = z.object({ scope:ExecutionScope,cwd: absoluteRunnerPath.optional(), project: z.object({ projectId: Id }).strict().optional() }).strict().parse(await readJson(request));
      requireScope(body.scope);
      json(response, 200, contexts.provision(Id.parse(contextRegistration[1]), { requireMount: true, ...(body.cwd ? { cwd: body.cwd } : {}), ...(body.project ? { project: body.project } : {}) })); return;
    }
    const reservation = /^\/v1\/reservations\/([^/]+)$/.exec(url.pathname);
    if (method === "PUT" && reservation) {
      requirePeer(peer, "worker", config.workerId);
      const binding = Assignment.parse(await readJson(request));
      requireScope(binding.scope);
      if (binding.reservationId !== reservation[1] || binding.workerId !== config.workerId) throw new ExecutionError(403, "reservation_denied");
      json(response, 200, store.register(binding)); return;
    }
    if (method === "POST" && url.pathname === "/v1/inspect") {
      requirePeer(peer, "worker", config.workerId);
      const { assignment } = BoundRequest.parse(await readJson(request)); store.authorize(assignment.jobId, assignment);
      json(response, 200, { execution: store.snapshot(assignment.jobId) }); return;
    }
    const fileLease = /^\/v1\/file-leases\/([^/]+)$/.exec(url.pathname);
    if (fileLease) {
      requirePeer(peer, "worker", config.workerId);
      const id = Id.parse(fileLease[1]);
      if (method === "PUT") {
        const { contextId } = z.object({ contextId: Id }).strict().parse(await readJson(request));
        contexts.get(contextId); fileLeases.set(id, contextId);
      } else if (method === "DELETE") {
        // Revocation is also a barrier: file operations are synchronous after
        // checking this lease; delayed request bodies cannot execute after release.
        fileLeases.delete(id);
      } else throw new ExecutionError(405, "method_not_allowed");
      json(response, 204); return;
    }
    if (method === "POST" && url.pathname === "/v1/files") {
      requirePeer(peer, "worker", config.workerId);
      const body = z.object({ leaseId: Id, contextId: Id, operation: z.unknown() }).strict().parse(await readJson(request, 8 * 1024 * 1024));
      if (fileLeases.get(body.leaseId) !== body.contextId) throw new ExecutionError(409, "file_lease_released");
      if ((body.operation as { kind?: string })?.kind === "delete" && store.list(true).some(job => store.binding(job.jobId).contextId === body.contextId)) throw new ExecutionError(409, "context_active");
      json(response, 200, executeFileOperation(contexts.get(body.contextId), body.operation)); return;
    }
    if (method === "GET" && url.pathname === "/v1/pty-sessions") {
      requirePeer(peer, "worker", config.workerId);
      json(response, 200, { sessions: processes.listPtySessions() }); return;
    }
    if (method === "POST" && url.pathname === "/v1/pty-sessions/idle-timeout") {
      requirePeer(peer, "worker", config.workerId);
      const { idleTimeoutMs } = z.object({ idleTimeoutMs: z.number().int().min(0).max(7 * 86400_000) }).strict().parse(await readJson(request));
      processes.setPtyIdleTimeout(idleTimeoutMs);
      json(response, 204); return;
    }
    const ptyStream = /^\/v1\/pty-sessions\/([^/]+)\/(stream|control)$/.exec(url.pathname);
    if (ptyStream) {
      requirePeer(peer, "worker", config.workerId);
      const contextId = Id.parse(ptyStream[1]);
      if (method === "GET" && ptyStream[2] === "stream") {
        request.socket?.setTimeout(0);
        let ended = false;
        const sendHeaders = () => {
          if (response.headersSent || response.destroyed) return;
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          });
          response.flushHeaders();
        };
        const finishStream = () => {
          if (ended) return;
          ended = true;
          detach?.();
          if (!response.writableEnded && !response.destroyed) response.end();
        };
        const detach = processes.attachPtyViewer(contextId, {
          onData: (bytes) => {
            if (ended || response.destroyed || response.writableEnded) return;
            sendHeaders();
            response.write(bytes);
          },
          onClose: () => finishStream(),
        });
        if (!detach) throw new ExecutionError(404, "pty_session_not_found");
        sendHeaders();
        await new Promise<void>((resolve) => {
          request.once("close", () => { finishStream(); resolve(); });
          response.once("close", () => { finishStream(); resolve(); });
          response.once("finish", () => { finishStream(); resolve(); });
        });
        return;
      }
      if (method === "POST" && ptyStream[2] === "control") {
        const body = z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("write"), data: z.string().max(1024 * 1024) }).strict(),
          z.object({ kind: z.literal("resize"), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }).strict(),
        ]).parse(await readJson(request, 2 * 1024 * 1024));
        const ok = body.kind === "write"
          ? processes.writePtyInput(contextId, Buffer.from(body.data, "base64"))
          : processes.resizePtySession(contextId, body.cols, body.rows);
        if (!ok) throw new ExecutionError(404, "pty_session_not_found");
        json(response, 204); return;
      }
      throw new ExecutionError(405, "method_not_allowed");
    }
    const deletion = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
    if (method === "DELETE" && deletion) { store.delete(Id.parse(deletion[1])); json(response, 204); return; }
    requirePeer(peer, "runtime", config.runtimeId);
    if (method === "PUT" && url.pathname === "/v1/ingest-credentials") {
      const credential = IngestCredential.parse(await readJson(request));
      if (credential.runtimeId !== config.runtimeId) throw new ExecutionError(403, "runtime_mismatch");
      reporter.configure(credential.token); json(response, 204); return;
    }
    if (method === "POST" && url.pathname === "/v1/contexts") {
      const body = z.object({ scope:ExecutionScope,contextId: Id }).strict().parse(await readJson(request));
      requireScope(body.scope);
      json(response, 200, contexts.get(body.contextId)); return;
    }
    if (method === "POST" && url.pathname === "/v1/jobs") {
      const submission = JobSubmission.parse(await readJson(request));
      requireScope(submission.job.scope);requireScope(submission.assignment.scope);
      // Worker points $HOME/.luna-resources at the Shadow's newest snapshot before binding the Job,
      // which may be newer than the one the Job was prepared with; it must exist.
      if(config.runnerLayout && activeSnapshot(config.runnerLayout.home)===undefined)throw new ExecutionError(409,"executor_resources_mismatch");
      contexts.get(submission.job.runnerContextId);
      const snapshot = store.submit(submission);
      if (reporter.ready()) processes.tick();
      json(response, 202, snapshot); return;
    }
    const match = /^\/v1\/jobs\/([^/]+)\/(query|cancel|credentials)$/.exec(url.pathname);
    if (!match) throw new ExecutionError(404, "route_not_found");
    const id = Id.parse(match[1]);
    const input = await readJson(request);
    if (method === "PUT" && match[2] === "credentials") {
      const body = CredentialRequest.parse(input); store.authorize(id, body.assignment);
      const job = store.request(id); if (!job) throw new ExecutionError(409, "job_not_submitted");
      if (isTerminal(store.snapshot(id).state)) throw new ExecutionError(409, "job_already_terminal");
      contexts.putCredentials(job, body.credentials);
      processes.notifyCredentials(job.jobId, body.credentials.env);
      if (reporter.ready()) processes.tick();
      json(response, 204); return;
    }
    if (method !== "POST") throw new ExecutionError(405, "method_not_allowed");
    store.authorize(id, BoundRequest.parse(input).assignment);
    if (match[2] === "cancel") await processes.cancel(id);
    else if (match[2] !== "query") throw new ExecutionError(405, "method_not_allowed");
    json(response, 200, store.snapshot(id));
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  return { server, store, contexts, processes, reporter,
    async start() {
      await processes.recover();
      timer = setInterval(() => { if (reporter.ready()) processes.tick(); void reporter.tick(); }, 100);
    },
    async stop() { clearInterval(timer); await processes.stop(); reporter.stop(); },
  };
}

/** Digest of the snapshot the Shadow HOME currently exposes, or undefined when unlinked. */
function activeSnapshot(home: string): string | undefined {
  try { return basename(readlinkSync(runnerResourcesPath(home))); } catch { return undefined; }
}
