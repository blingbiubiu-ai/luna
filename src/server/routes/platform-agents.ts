import {createAgentWorkerAccessRoutes} from "./agent-worker-access";
import {createAgentContainerRoutes} from "./agent-containers";
import {createShadowRootAccessRoutes} from "./shadow-root-access";
import {createAgentPluginRoutes} from "./agent-plugins";
import type {PluginRegistry} from "@/plugins/registry";
import {createAgentMemoryRoutes} from "./agent-memories";
import {createAccountLinkRoutes} from "./account-links";
import {config} from "@/shared";
import {AgentLifecycleStore, type AgentLifecycleJob} from "@/agents/agent-lifecycle-store";
import { HTTPException } from "hono/http-exception";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { loadDashboardUserRows } from "@/dashboard-api/user-display";
import { ShadowWorkerRoutingStore } from "@/agents/shadow-worker-routing-store";
import { ShadowModelSelectionStore } from "@/agents/shadow-model-selection-store";
import { AuthorizationRuleStore } from "../policy/authorization-rule-store";
import { AgentSettingsStore, messageDefaults } from "@/agents/agent-settings-store";
import { ChatListeningStore } from "@/sessions/chat-listening-store";
import { AgentWorkerAccessStore } from "@/agents/agent-worker-access-store";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import { getKernel } from "./kernel";

const statusInput = z.object({status: z.enum(["active", "disabled", "deleted"])}).strict();
const nameInput = z.object({name: z.string().trim().min(1).max(100)}).strict();
const routingInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }).strict(),
  z.object({ mode: z.literal("bound"), workerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
]);
const modelSelectionInput = z.discriminatedUnion("mode",[
  z.object({mode:z.literal("inherit")}).strict(),
  z.object({mode:z.literal("fixed"),revisionId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}).strict(),
]);
const cursorInput = z.object({createdAt: z.number().int().nonnegative(), id: z.string().min(1)}).strict();
const grantInput = z.object({subjectType: z.enum(["user", "group"]), subjectId: z.string().min(1),
  target: z.string().min(1).max(200), matchType: z.enum(["exact", "prefix"]),
  effect: z.enum(["allow", "deny"]), expiresAt: z.number().int().positive().optional()}).strict();

/** Agent self-service routes. Existing deployments must pass the offline-conversion startup gate. */
export function createPlatformAgentRoutes(db: DrizzleDB, registry?:PluginRegistry, resumeChannels?: (job: AgentLifecycleJob) => Promise<void>) {
  const store = new AgentStore(db);
  const actor = (c: Context) => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) throw new Error("authenticated middleware required");
    return auth.account.id;
  };
  /** The owner's user in the Agent: what acts and is recorded as the owner inside it. */
  const withOwnerUser = (agent: ReturnType<AgentStore["get"]>) => ({...agent, ownerUserId: store.ownerUserId(agent.id)});
  return new Hono()
    .route("/",createAgentMemoryRoutes(db))
    .route("/",createAccountLinkRoutes(db))
    .route("/",createAgentWorkerAccessRoutes(db))
    .route("/",createAgentContainerRoutes(db))
    .route("/",createShadowRootAccessRoutes(db))
    .route("/",registry ? createAgentPluginRoutes(db,registry) : new Hono())
    .use("*", async (c, next) => {
      const auth = requireDashboardOnly(c);
      if (isGuardResponse(auth)) return auth;
      await next();
    })
    .onError((error, c) => {
      if (error instanceof HTTPException) return c.json({status: "error", code: "authorization_request_rejected", message: error.message}, error.status);
      if (error instanceof AgentError) return c.json({status: "error", code: error.code}, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({status: "error", code: "invalid_request"}, 400);
      throw error;
    })
    .get("/", c => {
      const limit = z.coerce.number().int().min(1).max(100).parse(c.req.query("limit") ?? 50);
      const rawCursor = c.req.query("cursor");
      const cursor = rawCursor ? cursorInput.parse(JSON.parse(rawCursor)) : undefined;
      const agents = store.list(actor(c), limit, cursor);
      const last = agents.at(-1);
      return c.json({agents: agents.map(withOwnerUser), nextCursor: agents.length === limit && last ? JSON.stringify({createdAt: last.createdAt, id: last.id}) : null});
    })
    .post("/", async c => {
      const agent = store.create(actor(c), nameInput.parse(await c.req.json()), c.req.header("Idempotency-Key") ?? "");
      return c.json({agent: withOwnerUser(agent)}, 201);
    })
    .get("/:agentId", c => c.json({agent: withOwnerUser(store.requireOwner(actor(c), c.req.param("agentId")))}))
    .get("/:agentId/lifecycle/:jobId", c => {
      const job = new AgentLifecycleStore(db).getStatus(actor(c), c.req.param("agentId"), c.req.param("jobId"));
      return c.json({job});
    })
    .put("/:agentId/status", async c => {
      const input = statusInput.parse(await c.req.json());
      const job = new AgentLifecycleStore(db).request(actor(c), {agentId: c.req.param("agentId")}, input.status, c.req.header("Idempotency-Key") ?? "");
      if (job.targetStatus === "active") await resumeChannels?.(job);
      return c.json({job}, job.status === "pending" ? 202 : 200);
    })
    .put("/:agentId/shadows/:shadowId/status", async c => {
      const input = statusInput.parse(await c.req.json());
      const job = new AgentLifecycleStore(db).request(actor(c), {agentId: c.req.param("agentId"), shadowId: c.req.param("shadowId")}, input.status, c.req.header("Idempotency-Key") ?? "");
      if (job.targetStatus === "active") await resumeChannels?.(job);
      return c.json({job}, job.status === "pending" ? 202 : 200);
    })
    .patch("/:agentId/shadows/:shadowId", async c => {
      const {agentId, shadowId} = c.req.param();
      // An empty name makes a bot-bound Shadow follow its bot's name again.
      const shadow = store.renameShadow(actor(c), {agentId, shadowId}, z.object({name: z.string().trim().max(100)}).strict().parse(await c.req.json()));
      return c.json({shadow});
    })
    // `messageDefaults` is what a message setting the Agent leaves unset follows: the Service configuration.
    .get("/:agentId/settings", c => c.json({settings: new AgentSettingsStore(db).read(actor(c), c.req.param("agentId")), messageDefaults: messageDefaults(config.session)}))
    .put("/:agentId/settings", async c => {
      const accountId = actor(c);
      const agentId = c.req.param("agentId");
      const saved = new AgentSettingsStore(db).save(accountId, agentId, await c.req.json(), config.session);
      // Best-effort live push of updated PTY idle timeout to online assigned Workers.
      void (async () => {
        try {
          const gateway = getKernel().executionRuntime?.gateway;
          if (!gateway) return;
          const assigned = new Set(
            new AgentWorkerAccessStore(db).list(accountId, agentId)
              .filter(row => row.status === "active")
              .map(row => row.workerId),
          );
          const idleTimeoutMs = saved.pty.idleTimeoutMinutes * 60_000;
          const online = gateway.list().filter(w => assigned.has(w.workerId) && w.connected && !w.revoked);
          await Promise.all(online.map(w =>
            gateway.scheduler.workers.client(w.workerId)
              .call("POST", "/v1/pty-sessions/idle-timeout", { agentId, idleTimeoutMs }, AbortSignal.timeout(3000))
              .catch(() => {}),
          ));
        } catch { /* runtime detached or uninitialized in standalone unit tests */ }
      })();
      return c.json({settings: saved, messageDefaults: messageDefaults(config.session)});
    })
    // The group chats the Agent's bots are in, each with its listening switch; `enabled: null` follows the Agent default.
    .get("/:agentId/listening-chats", c => {
      const agentId = c.req.param("agentId");
      store.requireOwner(actor(c), agentId);
      return c.json({chats: new ChatListeningStore(db).chats(agentId)});
    })
    .put("/:agentId/listening-chats", async c => {
      const agentId = c.req.param("agentId");
      const accountId = actor(c);
      store.requireOwner(accountId, agentId);
      const input = z.object({shadowId: z.string().min(1), chatId: z.string().min(1).max(256), enabled: z.boolean().nullable()}).strict().parse(await c.req.json());
      const listening = new ChatListeningStore(db);
      if (!listening.chats(agentId).some(chat => chat.shadowId === input.shadowId && chat.chatId === input.chatId)) throw new AgentError("chat_not_found", 404);
      listening.set(input.shadowId, input.chatId, input.enabled, store.ownerUserId(agentId));
      return c.json({chats: listening.chats(agentId)});
    })
    .get("/:agentId/shadows/:shadowId/worker-routing", c => c.json({ routing: new ShadowWorkerRoutingStore(db).read(actor(c), c.req.param()) }))
    .get("/:agentId/shadows/:shadowId/model-selection",c=>c.json({selection:new ShadowModelSelectionStore(db).read(actor(c),c.req.param())}))
    .put("/:agentId/shadows/:shadowId/model-selection",async c=>{
      const selection=new ShadowModelSelectionStore(db).save(actor(c),c.req.param(),modelSelectionInput.parse(await c.req.json()));
      return c.json({selection});
    })
    .put("/:agentId/shadows/:shadowId/worker-routing", async c => {
      const input = routingInput.parse(await c.req.json());
      const routing = new ShadowWorkerRoutingStore(db).save(actor(c), c.req.param(),
        input.mode === "automatic" ? {mode: "automatic", workerId: null} : input);
      return c.json({routing});
    })
    .get("/:agentId/shadows", c => {
      const routing = new ShadowWorkerRoutingStore(db);
      const shadowUsers = new Map(loadDashboardUserRows(db, c.req.param("agentId")).map(user => [user.id, user]));
      return c.json({shadows: store.listShadows(actor(c), c.req.param("agentId")).map(shadow => ({
        ...shadow, avatarUrl: shadowUsers.get(shadow.replyUserId)?.avatarUrl ?? null, workerRouting: routing.get({agentId: shadow.agentId, shadowId: shadow.id}),
        modelSelection: new ShadowModelSelectionStore(db).view({agentId:shadow.agentId,shadowId:shadow.id}),
      }))});
    })
    .post("/:agentId/shadows", async c => {
      const shadow = store.createShadow(actor(c), c.req.param("agentId"), nameInput.parse(await c.req.json()), c.req.header("Idempotency-Key") ?? "");
      return c.json({shadow}, 201);
    })
    .get("/:agentId/authorization-rules", c => {
      const agentId = c.req.param("agentId");
      store.requireOwner(actor(c), agentId);
      return c.json({grants: new AuthorizationRuleStore(db, {kind: "agent", agentId}).listGrants()});
    })
    .post("/:agentId/authorization-rules", async c => {
      const agentId = c.req.param("agentId");
      store.requireOwner(actor(c), agentId);
      const input = grantInput.parse(await c.req.json());
      if (input.target === "system.admin" || input.target.startsWith("system.")) throw new AgentError("platform_operation_requires_platform_scope", 403);
      const {expiresAt, ...rule} = input;
      const grant = new AuthorizationRuleStore(db, {kind: "agent", agentId}).addGrant({...rule, ...(expiresAt === undefined ? {} : {expiresAt})});
      return c.json({grant}, 201);
    })
    .delete("/:agentId/authorization-rules/:ruleId", c => {
      const agentId = c.req.param("agentId");
      store.requireOwner(actor(c), agentId);
      const grant = new AuthorizationRuleStore(db, {kind: "agent", agentId}).deleteGrant(c.req.param("ruleId"));
      if (!grant) throw new AgentError("authorization_rule_not_found", 404);
      return c.json({grant});
    });
}
