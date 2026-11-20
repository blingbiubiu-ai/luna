import { Hono } from "hono";
import type { Server } from "bun";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { runnerContexts, sessions, tasks } from "@/data/schema";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { AgentWorkerAccessStore } from "@/agents/agent-worker-access-store";
import { ShadowRootAccessStore } from "@/agents/shadow-root-access-store";
import type { AgentResourceBuilder } from "@/runners/agent-resource-builder";
import { CONTAINER_STREAMS_CAPABILITY, HOME_UPLOAD_CAPABILITY, type WorkerGateway } from "@/runtime/worker-gateway";
import { ContainerConsoleSession, type ContainerConsoleSocketData } from "../container-console";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import { getKernel } from "./kernel";
import { ExecutionError } from "@luna/execution-store";
import { createLogger } from "@/shared";

const logger = createLogger("container-console");

const workerGateway = () => getKernel().executionRuntime?.gateway;
const defaultResourceBuilder = () => getKernel().agentResourceBuilder;
const Id = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const Summary = z.object({
  environmentId: Id, shadowId: Id, mode: z.string(), state: z.string(), running: z.boolean(), activeJobs: z.number().int(),
  activeStreams: z.number().int().optional(),
  idleSince: z.number().nullable(), resources: z.object({ memory: z.string(), cpus: z.number(), pidsLimit: z.number() }),
  imageDigest: z.string().optional(),
  root: z.object({ requested: z.boolean(), effective: z.boolean(), hostAllowed: z.boolean().optional(), reason: z.string().optional() }).optional(),
});
const PtySummary = z.object({
  environmentId: Id,
  shadowId: Id,
  contextId: Id,
  runnerType: z.enum(["claude", "codex"]),
  model: z.string().optional(),
  sessionId: z.string().optional(),
  busy: z.boolean(),
  privileged: z.boolean(),
  pid: z.number().int(),
  startedAt: z.number(),
  lastActiveAt: z.number(),
});
const StreamQuery = z.object({
  kind: z.enum(["terminal", "vnc", "pty"]), user: z.enum(["runner", "root"]).default("runner"),
  cols: z.coerce.number().int().min(1).max(1000).default(80), rows: z.coerce.number().int().min(1).max(1000).default(24),
  contextId: Id.optional(), writable: z.enum(["0", "1"]).optional(),
});
const ProvisionBody = z.object({ shadowId: Id, workerId: Id.optional() }).strict();
/** One piece of an upload; the bytes are the request body. The Worker checks name and directory. */
const UploadQuery = z.object({
  shadowId: Id, uploadId: z.string().uuid(), dir: z.string().max(1024), name: z.string().min(1).max(255),
  offset: z.coerce.number().int().min(0), final: z.enum(["0", "1"]),
});
const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** Dashboard container management: list an Agent's Shadow containers, provision cold ones, and open terminal/VNC streams. */
export function createAgentContainerRoutes(
  db: DrizzleDB,
  getGateway: () => WorkerGateway | undefined = workerGateway,
  getResourceBuilder: () => Pick<AgentResourceBuilder, "capture"> = defaultResourceBuilder,
) {
  const agents = new AgentStore(db);
  const access = new AgentWorkerAccessStore(db);
  const assignedWorkers = (userId: string, agentId: string) =>
    new Set(access.list(userId, agentId).filter(row => row.status === "active").map(row => row.workerId));

  return new Hono().onError((error, c) => {
    if (error instanceof AgentError) return c.json({ status: "error", code: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ status: "error", code: "invalid_request" }, 400);
    throw error;
  }).get("/:agentId/containers", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.account.id, c.req.param("agentId"));
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);
    const assigned = assignedWorkers(auth.account.id, agent.id);
    const allShadows = agents.listShadows(auth.account.id, agent.id);
    const names = new Map(allShadows.map(shadow => [shadow.id, shadow.name]));
    const shadows = allShadows.filter(shadow => shadow.status === "active").map(shadow => ({ shadowId: shadow.id, shadowName: shadow.name }));
    const workers = gateway.list().filter(worker => assigned.has(worker.workerId) && worker.connected && !worker.revoked);
    const results = await Promise.all(workers.map(async worker => {
      const supported = worker.health?.capabilities?.includes(CONTAINER_STREAMS_CAPABILITY) === true;
      const uploadSupported = worker.health?.capabilities?.includes(HOME_UPLOAD_CAPABILITY) === true;
      let imageDigest: string | undefined;
      try { imageDigest = gateway.scheduler.workers.imageDigest(worker.workerId); } catch { /* not ready: image unknown */ }
      try {
        const body = await gateway.scheduler.workers.client(worker.workerId)
          .call<{ containers: unknown[] }>("GET", `/v1/containers?agentId=${encodeURIComponent(agent.id)}`, undefined, AbortSignal.timeout(10000));
        return { worker: { workerId: worker.workerId, supported, ...(imageDigest ? { imageDigest } : {}) }, containers: z.array(Summary).parse(body.containers).map(item => ({ ...item, workerId: worker.workerId, shadowName: names.get(item.shadowId) ?? null, supported, uploadSupported })) };
      } catch {
        return { worker: { workerId: worker.workerId, supported, error: "worker_unreachable" }, containers: [] };
      }
    }));
    return c.json({ containers: results.flatMap(result => result.containers), workers: results.map(result => result.worker), shadows });
  }).post("/:agentId/containers", async c => {
    // Pre-create and start a Shadow's container before its first Job so the owner can log in or install packages.
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.account.id, c.req.param("agentId"));
    const { shadowId, workerId: requestedWorkerId } = ProvisionBody.parse(await c.req.json());
    const ownerUserId = agents.ownerUserId(agent.id);
    const shadow = agents.requireScope(ownerUserId, { agentId: agent.id, shadowId });
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);
    const allowed = access.allowed(agent.id);
    if (requestedWorkerId && !allowed.includes(requestedWorkerId)) throw new AgentError("worker_assignment_not_found", 404);
    try {
      const placement = gateway.scheduler.placements.route(
        { agentId: agent.id, shadowId },
        requestedWorkerId ? [requestedWorkerId] : allowed,
        gateway.scheduler.config.sharedProject?.projectId,
      );
      const workerInfo = gateway.list().find(item => item.workerId === placement.workerId && item.connected && !item.revoked);
      const supported = workerInfo?.health?.capabilities?.includes(CONTAINER_STREAMS_CAPABILITY) === true;
      if (!supported) return c.json({ status: "error", code: "worker_streams_unsupported", message: resetMessages.worker_streams_unsupported }, 409);
      const bundle = getResourceBuilder().capture(ownerUserId, { agentId: agent.id, shadowId });
      const rootAccess = new ShadowRootAccessStore(db).enabled(shadowId);
      const spec = {
        protocolVersion: 2 as const,
        scope: { agentId: agent.id, shadowId, placementGeneration: placement.generation },
        resourceSelection: bundle.selection,
        environmentId: gateway.scheduler.config.environmentId,
        scopeKey: `shadow:${shadowId}`,
        mode: gateway.scheduler.config.mode,
        imageDigest: gateway.scheduler.workers.imageDigest(placement.workerId),
        callbackRuntimeId: gateway.scheduler.config.runtimeId,
        resources: gateway.scheduler.config.resources,
        ...(rootAccess ? { rootAccess: true } : {}),
      };
      const reply = await gateway.scheduler.workers.client(placement.workerId)
        .call<{ container: unknown }>("POST", "/v1/containers/provision", { bundle, spec }, AbortSignal.timeout(60000));
      const container = Summary.parse(reply.container);
      logger.info({ event: "provision", accountId: auth.account.id, agentId: agent.id, shadowId, workerId: placement.workerId, environmentId: container.environmentId }, "container_provisioned");
      return c.json({ container: { ...container, workerId: placement.workerId, shadowName: shadow.name, supported: true } });
    } catch (error) {
      const code = error instanceof ExecutionError ? error.code : "worker_unreachable";
      const status = error instanceof ExecutionError && [403, 404, 409].includes(error.status) ? error.status as 403 | 404 | 409 : 503;
      return c.json({ status: "error", code, message: resetMessages[code] ?? code }, status);
    }
  }).post("/:agentId/containers/:workerId/:environmentId/reset", async c => {
    // Resetting removes the container's writable system layer (apt packages etc.); HOME stays.
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.account.id, c.req.param("agentId"));
    const workerId = Id.parse(c.req.param("workerId"));
    const environmentId = Id.parse(c.req.param("environmentId"));
    if (!assignedWorkers(auth.account.id, agent.id).has(workerId)) throw new AgentError("worker_assignment_not_found", 404);
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
    logger.info({ event: "reset", accountId: auth.account.id, agentId: agent.id, workerId, environmentId }, "container_system_disk_reset");
    return c.json({ ok: true });
  }).post("/:agentId/containers/:workerId/:environmentId/upload", async c => {
    // A piece of a file the owner uploads into the Shadow's HOME; the container need not run.
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.account.id, c.req.param("agentId"));
    const workerId = Id.parse(c.req.param("workerId"));
    const environmentId = Id.parse(c.req.param("environmentId"));
    const query = UploadQuery.parse(c.req.query());
    if (!assignedWorkers(auth.account.id, agent.id).has(workerId)) throw new AgentError("worker_assignment_not_found", 404);
    // Deleted Shadows take no new files.
    agents.requireScope(agents.ownerUserId(agent.id), { agentId: agent.id, shadowId: query.shadowId });
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_UPLOAD_CHUNK_BYTES) return c.json({ status: "error", code: "upload_chunk_too_large" }, 413);
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);
    const worker = gateway.list().find(item => item.workerId === workerId && item.connected && !item.revoked);
    if (!worker?.health?.capabilities?.includes(HOME_UPLOAD_CAPABILITY)) {
      return c.json({ status: "error", code: "worker_upload_unsupported", message: uploadMessages.worker_upload_unsupported }, 409);
    }
    try {
      const result = await gateway.scheduler.workers.client(workerId).call<{ done: boolean; path?: string; size?: number; received?: number }>(
        "POST", `/v1/environments/${encodeURIComponent(environmentId)}/upload`, {
          agentId: agent.id, shadowId: query.shadowId, uploadId: query.uploadId, dir: query.dir, name: query.name,
          offset: query.offset, content: Buffer.from(bytes).toString("base64"), final: query.final === "1",
        }, AbortSignal.timeout(60000));
      if (result.done) logger.info({ event: "upload", accountId: auth.account.id, agentId: agent.id, workerId, environmentId, size: result.size }, "container_file_uploaded");
      return c.json(result);
    } catch (error) {
      const code = error instanceof ExecutionError ? error.code : "worker_unreachable";
      const status = error instanceof ExecutionError && [400, 403, 404, 409, 413].includes(error.status) ? error.status as 400 | 403 | 404 | 409 | 413 : 503;
      return c.json({ status: "error", code, message: uploadMessages[code] ?? resetMessages[code] ?? code }, status);
    }
  }).post("/:agentId/containers/:workerId/:environmentId/desktop/stop", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.account.id, c.req.param("agentId"));
    const workerId = Id.parse(c.req.param("workerId"));
    const environmentId = Id.parse(c.req.param("environmentId"));
    if (!assignedWorkers(auth.account.id, agent.id).has(workerId)) throw new AgentError("worker_assignment_not_found", 404);
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);
    try {
      await gateway.scheduler.workers.client(workerId).call("POST", `/v1/environments/${encodeURIComponent(environmentId)}/desktop-stop`, { agentId: agent.id }, AbortSignal.timeout(30000));
    } catch (error) {
      const code = error instanceof ExecutionError ? error.code : "worker_unreachable";
      const status = error instanceof ExecutionError && [403, 404, 409].includes(error.status) ? error.status as 403 | 404 | 409 : 503;
      return c.json({ status: "error", code, message: resetMessages[code] ?? code }, status);
    }
    logger.info({ event: "desktop_stop", accountId: auth.account.id, agentId: agent.id, workerId, environmentId }, "container_desktop_stopped");
    return c.json({ ok: true });
  }).get("/:agentId/containers/:workerId/:environmentId/stream", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.account.id, c.req.param("agentId"));
    const workerId = Id.parse(c.req.param("workerId"));
    const environmentId = Id.parse(c.req.param("environmentId"));
    const query = StreamQuery.parse(c.req.query());
    // Cookie-authenticated WebSockets must come from the Dashboard's own origin.
    const origin = c.req.header("origin");
    if (!origin || new URL(origin).host !== c.req.header("host")) return c.json({ status: "error", code: "origin_denied" }, 403);
    if (!assignedWorkers(auth.account.id, agent.id).has(workerId)) throw new AgentError("worker_assignment_not_found", 404);
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);
    // The Worker re-checks agent ownership of the environment before opening the stream.
    const listed = await gateway.scheduler.workers.client(workerId)
      .call<{ containers: unknown[] }>("GET", `/v1/containers?agentId=${encodeURIComponent(agent.id)}`, undefined, AbortSignal.timeout(10000))
      .catch(() => undefined);
    if (!listed) return c.json({ status: "error", code: "worker_unreachable" }, 503);
    const container = z.array(Summary).parse(listed.containers).find(item => item.environmentId === environmentId);
    if (!container) throw new AgentError("container_not_found", 404);
    if (query.kind === "pty" && !query.contextId) {
      return c.json({ status: "error", code: "invalid_request" }, 400);
    }
    if (query.kind === "terminal" && query.user === "root" && container.root?.hostAllowed === false) {
      const code = container.root.reason ?? "root_not_allowed";
      return c.json({ status: "error", code, message: resetMessages[code] ?? code }, 403);
    }
    const server = c.env as Server<ContainerConsoleSocketData> | undefined;
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket" || typeof server?.upgrade !== "function") {
      return c.json({ status: "error", code: "websocket_required" }, 426);
    }
    const session = new ContainerConsoleSession(gateway, {
      accountId: auth.account.id, agentId: agent.id, shadowId: container.shadowId, workerId, environmentId,
      kind: query.kind, user: query.kind === "terminal" ? query.user : "runner", cols: query.cols, rows: query.rows,
      ...(query.contextId ? { contextId: query.contextId } : {}),
      ...(query.writable === "1" ? { writable: true } : {}),
    });
    if (!server.upgrade(c.req.raw, { data: { kind: "container-console", session } })) return c.json({ status: "error", code: "websocket_required" }, 426);
    return new Response(null);
  }).get("/:agentId/pty-sessions", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const agent = agents.requireOwner(auth.account.id, c.req.param("agentId"));
    const gateway = getGateway();
    if (!gateway) return c.json({ status: "error", code: "runtime_not_ready" }, 503);

    const assigned = assignedWorkers(auth.account.id, agent.id);
    const allShadows = agents.listShadows(auth.account.id, agent.id);
    const shadowNames = new Map(allShadows.map(shadow => [shadow.id, shadow.name]));

    const contextRows = db.select().from(runnerContexts)
      .where(eq(runnerContexts.agent_id, agent.id))
      .orderBy(desc(runnerContexts.updated_at))
      .all();
    const contextById = new Map(contextRows.map(row => [row.id, row]));

    const sessionRows = db.select().from(sessions)
      .where(eq(sessions.agent_id, agent.id))
      .all();
    const sessionById = new Map(sessionRows.map(row => [row.id, row]));

    const taskRows = db.select().from(tasks)
      .where(eq(tasks.agent_id, agent.id))
      .all();
    const taskById = new Map(taskRows.map(row => [row.id, row]));

    const describeContextOwner = (ctx: (typeof contextRows)[number] | undefined) => {
      if (!ctx) {
        return {
          ownerType: "unknown" as const,
          ownerId: null,
          runnerKind: "main" as const,
          title: null,
          channelType: null,
        };
      }
      if (ctx.owner_type === "task") {
        const task = taskById.get(ctx.owner_id);
        return {
          ownerType: "task" as const,
          ownerId: ctx.owner_id,
          runnerKind: "task" as const,
          title: task?.title?.trim() || `任务 ${ctx.owner_id.slice(0, 8)}`,
          channelType: null,
        };
      }
      const sess = sessionById.get(ctx.owner_id);
      const runnerKind = sess?.kind === "work" ? "work" as const : "main" as const;
      const fallbackTitle = sess?.channel_type === "dashboard"
        ? `网页会话 ${ctx.owner_id.slice(0, 8)}`
        : `会话 ${ctx.owner_id.slice(0, 8)}`;
      return {
        ownerType: "session" as const,
        ownerId: ctx.owner_id,
        runnerKind,
        title: sess?.title?.trim() || fallbackTitle,
        channelType: sess?.channel_type ?? null,
      };
    };

    const workers = gateway.list().filter(worker => assigned.has(worker.workerId) && worker.connected && !worker.revoked);
    const workerResults = await Promise.all(workers.map(async worker => {
      const supported = worker.health?.capabilities?.includes(CONTAINER_STREAMS_CAPABILITY) === true;
      if (!supported) return [];
      try {
        const body = await gateway.scheduler.workers.client(worker.workerId)
          .call<{ sessions?: unknown[] }>("GET", `/v1/pty-sessions?agentId=${encodeURIComponent(agent.id)}`, undefined, AbortSignal.timeout(8000));
        return z.array(PtySummary).parse(body.sessions ?? []).map(item => {
          const ctx = contextById.get(item.contextId);
          const meta = describeContextOwner(ctx);
          return {
            ...item,
            workerId: worker.workerId,
            shadowName: shadowNames.get(item.shadowId) ?? null,
            ...meta,
          };
        });
      } catch {
        return [];
      }
    }));

    const liveSessions = workerResults.flat().toSorted((a, b) => {
      if (a.busy !== b.busy) return a.busy ? -1 : 1;
      return b.lastActiveAt - a.lastActiveAt;
    });
    const liveContextIds = new Set(liveSessions.map(item => item.contextId));

    const dormantContexts = contextRows
      .filter(row => row.runner_session_id && !liveContextIds.has(row.id))
      .filter(row => {
        if (row.owner_type === "task") {
          const task = taskById.get(row.owner_id);
          return Boolean(task && task.status !== "deleted");
        }
        const sess = sessionById.get(row.owner_id);
        return Boolean(sess && sess.status === "active");
      })
      .slice(0, 25)
      .map(row => {
        const meta = describeContextOwner(row);
        return {
          contextId: row.id,
          shadowId: row.shadow_id,
          shadowName: shadowNames.get(row.shadow_id) ?? null,
          runnerType: row.runner_type,
          sessionId: row.runner_session_id,
          updatedAt: row.updated_at,
          ...meta,
        };
      });

    return c.json({
      sessions: liveSessions,
      dormantContexts,
    });
  });
}

const uploadMessages: Record<string, string> = {
  worker_upload_unsupported: "该 Worker 版本不支持上传文件，请升级 Worker",
  upload_too_large: "单个文件不能超过 100 MB",
  upload_chunk_too_large: "上传分片过大",
  upload_name_invalid: "文件名不合法",
  upload_directory_outside_home: "目标目录必须在分身的 HOME 内",
  upload_directory_invalid: "目标目录不合法",
  upload_directory_unsafe: "目标目录包含符号链接或同名文件，已拒绝",
  upload_offset_mismatch: "上传中断，请重新上传",
};

const resetMessages: Record<string, string> = {
  environment_occupied: "容器里还有任务在运行，请等任务结束后再重置",
  environment_not_settled: "容器里还有任务在运行，请等任务结束后再重置",
  environment_draining: "容器正在重建或回收，请稍后再试",
  environment_not_found: "容器不存在",
  environment_agent_mismatch: "容器不属于当前 Agent",
  agent_workers_not_configured: "当前 Agent 还没有绑定可用的 Worker",
  no_scoped_worker_available: "当前没有在线且未暂停的 Worker 可用",
  worker_streams_unsupported: "该 Worker 版本不支持容器控制台，请升级 Worker",
  home_requires_nosuid: "Worker 主机上分身 HOME 所在的文件系统没有以 nosuid 挂载，为防止提权到主机，禁止使用 Root",
  unsupported_host: "当前 Worker 主机平台不支持容器 Root",
  worker_unreachable: "Worker 暂时无法访问",
};
