import type { WorkerGateway } from "./worker-gateway";
import { z } from "zod";
import { ExecutionError } from "@luna/execution-store";
import { executionServer, json, readJson, requirePeer, type TokenAuthority } from "@luna/execution-transport";
import { Id } from "@luna/runner-protocol";
import { RuntimeScheduler } from "./scheduler";

/** Executor callbacks and deployment administration; business calls use ExecutionRuntime. */
export function runtimeServer(grants: TokenAuthority, scheduler: RuntimeScheduler, gateway?: WorkerGateway) {
  return executionServer(grants, async ({ peer, request, response, url, assertAuthorized }) => {
    const method = request.method;
    if (url.pathname.startsWith("/v1/mode")) {
      requirePeer(peer, "runtime", scheduler.config.runtimeId);
      if (method === "GET" && url.pathname === "/v1/mode") { json(response, 200, scheduler.mode.state()); return; }
      if (method === "POST" && url.pathname === "/v1/mode/drain") { json(response, 200, scheduler.mode.drain()); return; }
      if (method === "POST" && url.pathname === "/v1/mode/resume") { json(response, 200, scheduler.mode.resume()); return; }
      if (method === "PUT" && url.pathname === "/v1/mode") {
        const body = z.object({ mode: z.enum(["shared", "isolated"]) }).strict().parse(await readJson(request));
        json(response, 200, scheduler.mode.change(body.mode)); return;
      }
      throw new ExecutionError(405, "method_not_allowed");
    }
    const ingest = /^\/v1\/ingest\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (method === "POST" && ingest) {
      requirePeer(peer, "executor");
      scheduler.events.ingest(Id.parse(ingest[1]), peer.id, await readJson(request, 16 * 1024 * 1024));
      json(response, 204); return;
    }
    if (url.pathname.startsWith("/v1/workers")) {
      requirePeer(peer, "runtime", scheduler.config.runtimeId);
      if (url.pathname === "/v1/workers") {
        if (method === "POST") {
          const body = await readJson(request);
          const worker = scheduler.workers.register(body);
          if (worker.reverse && worker.workerId === scheduler.config.homeWorkerId) {
            gateway?.registerLocal(body as { workerId: string; controlToken: string; port: number; executorPortStart: number; executorPortEnd: number });
          }
          json(response, 200, worker); return;
        }
        if (method === "GET") { json(response, 200, scheduler.workers.list()); return; }
      }
      const worker = /^\/v1\/workers\/([^/]+)(?:\/(drain))?$/.exec(url.pathname);
      if (worker && method === "POST" && worker[2]) { scheduler.workers.drain(Id.parse(worker[1])); json(response, 204); return; }
      if (worker && method === "DELETE" && !worker[2]) { scheduler.workers.remove(Id.parse(worker[1])); json(response, 204); return; }
      throw new ExecutionError(404, "route_not_found");
    }
    if (method === "GET" && url.pathname === "/v1/health") {
      requirePeer(peer, "runtime", scheduler.config.runtimeId);
      json(response, 200, { runtimeId: scheduler.config.runtimeId, mode: scheduler.config.mode, workers: scheduler.workers.list().length }); return;
    }
    throw new ExecutionError(404, "route_not_found");
  });
}
