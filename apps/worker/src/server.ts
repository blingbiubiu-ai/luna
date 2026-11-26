import { z } from "zod";
import { executionServer, json, readJson, requirePeer, type TokenAuthority } from "@luna/execution-transport";
import { Id, ReleaseProof } from "@luna/runner-protocol";
import { ExecutionError } from "@luna/execution-store";
import type { EnvironmentManager } from "./environment-manager";
import type { WorkerUpgradeManager } from "./upgrade";
import type { WorkerModelProviderManager } from "./model-providers/manager";
import { ModelProviderReference } from "@luna/runner-protocol";
import {proxyExecutor} from "./model-providers/executor-proxy";

/** Private local environment API; authenticated Executor callbacks are relayed to Service. */
export function workerServer(authority: TokenAuthority, manager: EnvironmentManager, events?: (jobId: string, instanceId: string, body: unknown) => void, upgrade?: WorkerUpgradeManager, models?: WorkerModelProviderManager) {
  return executionServer(authority, async ({ peer, request, response, url }) => {
    const ingest = /^\/v1\/ingest\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method === "POST" && ingest && events) { requirePeer(peer, "executor"); events(Id.parse(ingest[1]), peer.id, await readJson(request, 16 * 1024 * 1024)); json(response, 204); return; }
    requirePeer(peer, "runtime", manager.driver.config.runtimeId);
    if(request.method==="POST" && url.pathname==="/v1/executor"){
      json(response,200,await proxyExecutor(manager,authority,models,await readJson(request,16*1024*1024)));return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/v1/model-providers/")) {
      if (!models) throw new ExecutionError(409, "worker_model_provider_unsupported");
      const body = await readJson(request, 24 * 1024 * 1024);
      if (url.pathname === "/v1/model-providers/install") { json(response, 200, models.install(body)); return; }
      if (url.pathname === "/v1/model-providers/import") { json(response, 200, await models.importAccount(body)); return; }
      if(url.pathname==="/v1/model-providers/login/start"){json(response,200,await models.logins.start(body));return;}
      if(url.pathname.startsWith("/v1/model-providers/login/")){
        const input=z.object({agentId:Id,flowId:Id,params:z.record(z.string(),z.string()).optional()}).strict().parse(body);
        if(url.pathname.endsWith("/poll")){json(response,200,await models.logins.poll(input.flowId,input.agentId));return;}
        if(url.pathname.endsWith("/callback")){json(response,200,await models.logins.callback(input.flowId,input.agentId,input.params??{}));return;}
        if(url.pathname.endsWith("/cancel")){await models.logins.cancel(input.flowId,input.agentId);json(response,200,{cancelled:true});return;}
      }
      if(url.pathname==="/v1/model-providers/info"){
        const input=z.object({agentId:Id,reference:ModelProviderReference}).strict().parse(body);models.accounts.credential(input.agentId,input.reference);
        json(response,200,{protocol:"OpenAI Responses",baseUrl:`http://host.docker.internal:${models.port}/v1`,workerLocalBaseUrl:`http://127.0.0.1:${models.port}/v1`,responsesPath:"/responses",modelsPath:"/models",authentication:"execution-scoped"});return;
      }
      if (url.pathname === "/v1/model-providers/account") {
        const input = z.object({ agentId: Id, pluginId: Id, providerId: Id }).strict().parse(body);
        json(response, 200, models.accounts.current(input.agentId, input.pluginId, input.providerId)); return;
      }
      if (url.pathname === "/v1/model-providers/disable") {
        const input = z.object({ agentId: Id, pluginId: Id }).strict().parse(body);
        models.disable(input.agentId, input.pluginId); json(response, 200, { disabled: true }); return;
      }
      if (url.pathname === "/v1/model-providers/refresh") {
        const input = z.object({ agentId: Id, reference: ModelProviderReference }).strict().parse(body);
        json(response, 200, await models.refresh(input.agentId, input.reference)); return;
      }
      const input = z.object({ agentId: Id, reference: ModelProviderReference, model: z.string().min(1),
        env: z.record(z.string(), z.string()).default({}), executionDriver: z.enum(["stdio", "pty"]).default("stdio") }).strict().parse(body);
      if (url.pathname === "/v1/model-providers/check") { models.check(input.agentId, input.reference, input.model); json(response, 200, { valid: true }); return; }
      if (url.pathname === "/v1/model-providers/test") { json(response, 200, await models.test(input.agentId, input.reference, input.model, input.env, input.executionDriver)); return; }
      throw new ExecutionError(404, "route_not_found");
    }
    if (request.method === "POST" && url.pathname === "/v1/environments/retire") {
      for (const environment of manager.store.list()) await manager.destroy(environment.id);
      json(response, 204); return;
    }
    if (request.method === "GET" && url.pathname === "/v1/health") {
      const environments = manager.store.list();
      json(response, 200, { workerId: manager.driver.config.workerId, imageDigest: manager.driver.config.imageDigest, capacity: manager.driver.config.capacity,
        ...(models ? {ready:true,capabilities:["worker-model-provider-v1"]} : {}),
        occupied: environments.reduce((count, env) => count + manager.store.active(env.id).length, 0) }); return;
    }
    if (request.method === "GET" && url.pathname === "/v1/containers") {
      json(response, 200, { containers: await manager.containers(Id.parse(url.searchParams.get("agentId"))) }); return;
    }
    if (request.method === "GET" && url.pathname === "/v1/pty-sessions") {
      json(response, 200, { sessions: await manager.ptySessions(Id.parse(url.searchParams.get("agentId"))) }); return;
    }
    if (request.method === "POST" && url.pathname === "/v1/pty-sessions/idle-timeout") {
      const body = z.object({ agentId: Id, idleTimeoutMs: z.number().int().min(0).max(7 * 86400_000) }).strict().parse(await readJson(request));
      await manager.setPtyIdleTimeout(body.agentId, body.idleTimeoutMs);
      json(response, 204); return;
    }
    if (request.method === "POST" && url.pathname === "/v1/containers/provision") {
      json(response, 200, { container: await manager.provision(await readJson(request, 64 * 1024 * 1024)) }); return;
    }
    if (request.method === "POST" && url.pathname === "/v1/files") { json(response, 200, await manager.files(await readJson(request, 8 * 1024 * 1024))); return; }
    if (request.method === "POST" && url.pathname === "/v1/environments/prepare") {
      json(response, 200, await manager.prepare(await readJson(request))); return;
    }
    const preparation = /^\/v1\/preparations\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === "POST" && preparation) {
      json(response, 200, await manager.cancelPreparation(Id.parse(preparation[1]))); return;
    }
    if (request.method === "GET" && url.pathname === "/v1/scopes") { json(response, 200, { scopes: manager.heldScopes() }); return; }
    if (request.method === "POST" && url.pathname === "/v1/scopes/reconcile") {
      json(response, 200, await manager.reconcileScopes(await readJson(request, 8 * 1024 * 1024))); return;
    }
    if (request.method === "POST" && url.pathname === "/v1/prune") { json(response, 200, await manager.prune(await readJson(request))); return; }
    if (request.method === "POST" && url.pathname === "/v1/upgrade") {
      if (!upgrade) throw new ExecutionError(409, "worker_upgrade_unsupported");
      json(response, 200, upgrade.startUpgrade(await readJson(request))); return;
    }
    const shadow = /^\/v1\/shadows\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && shadow) {
      await manager.purgeShadow({ agentId: Id.parse(shadow[1]), shadowId: Id.parse(shadow[2]) }); json(response, 204); return;
    }
    const environment = /^\/v1\/environments\/([^/]+)(?:\/(release|drain|reset|desktop-stop|upload))?$/.exec(url.pathname);
    if (!environment)throw new ExecutionError(404, "route_not_found");
    const id = Id.parse(environment[1]);
    if (request.method === "GET" && !environment[2]) {
      json(response, 200, { environment: manager.store.require(id), reservations: manager.store.reservations(id) }); return;
    }
    if (request.method === "POST" && environment[2] === "release") {
      const body = z.object({ reservationId: Id, proof: ReleaseProof }).strict().parse(await readJson(request));
      await manager.release(id, body.reservationId, body.proof); json(response, 204); return;
    }
    if (request.method === "POST" && environment[2] === "reset") {
      const { agentId } = z.object({ agentId: Id }).strict().parse(await readJson(request));
      await manager.reset(id, agentId); json(response, 204); return;
    }
    if (request.method === "POST" && environment[2] === "desktop-stop") {
      const { agentId } = z.object({ agentId: Id }).strict().parse(await readJson(request));
      await manager.stopDesktop(id, agentId); json(response, 204); return;
    }
    if (request.method === "POST" && environment[2] === "upload") { json(response, 200, manager.upload(id, await readJson(request, 8 * 1024 * 1024))); return; }
    if (request.method === "POST" && environment[2] === "drain") { await manager.drain(id); json(response, 200, manager.store.require(id)); return; }
    if (request.method === "DELETE" && !environment[2]) { await manager.destroy(id); json(response, 204); return; }
    throw new ExecutionError(405, "method_not_allowed");
  });
}

/** Linux Docker callbacks need a host-interface listener; this listener has no control routes. */
export function executorCallbackServer(authority: TokenAuthority, events: (jobId: string, instanceId: string, body: unknown) => void) {
  return executionServer(authority, async ({ peer, request, response, url }) => {
    requirePeer(peer, "executor");
    const ingest = /^\/v1\/ingest\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method !== "POST" || !ingest) throw new ExecutionError(404, "route_not_found");
    events(Id.parse(ingest[1]), peer.id, await readJson(request, 16 * 1024 * 1024));
    json(response, 204);
  });
}
