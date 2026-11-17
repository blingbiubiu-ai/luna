import { Hono } from "hono";
import type { Server } from "bun";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { AgentWorkerAccessStore } from "@/agents/agent-worker-access-store";
import { CONTAINER_STREAMS_CAPABILITY, type WorkerGateway } from "@/runtime/worker-gateway";
import { ContainerConsoleSession, type ContainerConsoleSocketData } from "../container-console";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import { getKernel } from "./kernel";
import { ExecutionError } from "@luna/execution-store";
import { createLogger } from "@/shared";

const logger = createLogger("container-console");

const workerGateway = () => getKernel().executionRuntime?.gateway;
const Id = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const Summary = z.object({
  environmentId: Id, shadowId: Id, mode: z.string(), state: z.string(), running: z.boolean(), activeJobs: z.number().int(),
  idleSince: z.number().nullable(), resources: z.object({ memory: z.string(), cpus: z.number(), pidsLimit: z.number() }),
  imageDigest: z.string().optional(),
  root: z.object({ requested: z.boolean(), effective: z.boolean(), reason: z.string().optional() }).optional(),
});
const StreamQuery = z.object({
  kind: z.enum(["terminal", "vnc"]), user: z.enum(["runner", "root"]).default("runner"),
  cols: z.coerce.number().int().min(1).max(1000).default(80), rows: z.coerce.number().int().min(1).max(1000).default(24),
});

/** Dashboard container management: list an Agent's Shadow containers and open terminal/VNC streams into them. */
export function createAgentContainerRoutes(db: DrizzleDB, getGateway: () => WorkerGateway | undefined = workerGateway) {
  const agents = new AgentStore(db);
  const access = new AgentWorkerAccessStore(db);
  const assignedWorkers = (userId: string, agentId: string) =>
    new Set(access.list(userId, agentId).filter(row => row.status === "active").map(row => row.workerId));

  return new Hono().onError((error, c) => {
    if (error instanceof AgentError) return c.json({ status: "error", code: error.code }, error.status);
    if (error instanceof z.ZodError) return c.json({ status: "error", code: "invalid_request" }, 400);
    throw error;
  }).get("/:agentId/containers", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.user.id, c.req.param("agentId"));
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);
    const assigned = assignedWorkers(auth.user.id, agent.id);
    const names = new Map(agents.listShadows(auth.user.id, agent.id).map(shadow => [shadow.id, shadow.name]));
    const workers = gateway.list().filter(worker => assigned.has(worker.workerId) && worker.connected && !worker.revoked);
    const results = await Promise.all(workers.map(async worker => {
      const supported = worker.health?.capabilities?.includes(CONTAINER_STREAMS_CAPABILITY) === true;
      try {
        const body = await gateway.scheduler.workers.client(worker.workerId)
          .call<{ containers: unknown[] }>("GET", `/v1/containers?agentId=${encodeURIComponent(agent.id)}`, undefined, AbortSignal.timeout(10000));
        return { worker: { workerId: worker.workerId, supported }, containers: z.array(Summary).parse(body.containers).map(item => ({ ...item, workerId: worker.workerId, shadowName: names.get(item.shadowId) ?? null, supported })) };
      } catch {
        return { worker: { workerId: worker.workerId, supported, error: "worker_unreachable" }, containers: [] };
      }
    }));
    return c.json({ containers: results.flatMap(result => result.containers), workers: results.map(result => result.worker) });
  }).post("/:agentId/containers/:workerId/:environmentId/reset", async c => {
    // Resetting removes the container's writable system layer (apt packages etc.); HOME stays.
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.user.id, c.req.param("agentId"));
    const workerId = Id.parse(c.req.param("workerId"));
    const environmentId = Id.parse(c.req.param("environmentId"));
    if (!assignedWorkers(auth.user.id, agent.id).has(workerId)) throw new AgentError("worker_assignment_not_found", 404);
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);
    try {
      // The Worker re-checks that the environment belongs to this Agent.
      await gateway.scheduler.workers.client(workerId).call("POST", `/v1/environments/${encodeURIComponent(environmentId)}/reset`, { agentId: agent.id }, AbortSignal.timeout(60000));
    } catch (error) {
      const code = error instanceof ExecutionError ? error.code : "worker_unreachable";
      const status = error instanceof ExecutionError && [403, 404, 409].includes(error.status) ? error.status as 403 | 404 | 409 : 503;
      return c.json({ status: "error", code, message: resetMessages[code] ?? code }, status);
    }
    logger.info({ event: "reset", userId: auth.user.id, agentId: agent.id, workerId, environmentId }, "container_system_disk_reset");
    return c.json({ ok: true });
  }).get("/:agentId/containers/:workerId/:environmentId/stream", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.user.id, c.req.param("agentId"));
    const workerId = Id.parse(c.req.param("workerId"));
    const environmentId = Id.parse(c.req.param("environmentId"));
    const query = StreamQuery.parse(c.req.query());
    // Cookie-authenticated WebSockets must come from the Dashboard's own origin.
    const origin = c.req.header("origin");
    if (!origin || new URL(origin).host !== c.req.header("host")) return c.json({ status: "error", code: "origin_denied" }, 403);
    if (!assignedWorkers(auth.user.id, agent.id).has(workerId)) throw new AgentError("worker_assignment_not_found", 404);
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);
    // The Worker re-checks agent ownership of the environment before opening the stream.
    const listed = await gateway.scheduler.workers.client(workerId)
      .call<{ containers: unknown[] }>("GET", `/v1/containers?agentId=${encodeURIComponent(agent.id)}`, undefined, AbortSignal.timeout(10000))
      .catch(() => undefined);
    if (!listed) return c.json({ status: "error", code: "worker_unreachable" }, 503);
    const container = z.array(Summary).parse(listed.containers).find(item => item.environmentId === environmentId);
    if (!container) throw new AgentError("container_not_found", 404);
    const server = c.env as Server<ContainerConsoleSocketData> | undefined;
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket" || typeof server?.upgrade !== "function") {
      return c.json({ status: "error", code: "websocket_required" }, 426);
    }
    const session = new ContainerConsoleSession(gateway, {
      userId: auth.user.id, agentId: agent.id, shadowId: container.shadowId, workerId, environmentId,
      kind: query.kind, user: query.kind === "vnc" ? "runner" : query.user, cols: query.cols, rows: query.rows,
    });
    if (!server.upgrade(c.req.raw, { data: { kind: "container-console", session } })) return c.json({ status: "error", code: "websocket_required" }, 426);
    return new Response(null);
  });
}

const resetMessages: Record<string, string> = {
  environment_occupied: "容器里还有任务在运行，请等任务结束后再重置",
  environment_not_settled: "容器里还有任务在运行，请等任务结束后再重置",
  environment_not_found: "容器不存在",
  environment_agent_mismatch: "容器不属于当前 Agent",
  worker_unreachable: "Worker 暂时无法访问",
};
