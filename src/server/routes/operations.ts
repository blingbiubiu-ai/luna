import {GatewayError} from "../gateway-error";
import {pluginRequestScope} from "../policy/plugin-scope";
import {AgentError} from "@/agents/agent-store";
import { operationDispatchStatus } from "@/plugins/dispatch-status";
import { Hono } from "hono";

import {
  resolveOperationPolicy,
  listOperationSuggestions,
} from "@/operations/operation-registry";
import type { DrizzleDB } from "@/data";
import {
  OperationDispatcher,
  OperationInvocationAuditStore,
  PluginRegistry,
  type OperationInvocationSource,
} from "@/plugins";
import type { operationInvocationAudits } from "@/data/schema";
import {
  dashboardAuthSessionFromContext,
  lunaAccessTokenClaimsFromContext,
} from "../auth";
import { isGuardResponse, requireAdmin } from "../auth/guards";

import { getKernel } from "./kernel";

export interface OperationsRouteOptions {
  readonly db?: DrizzleDB;
  readonly pluginRegistry?: PluginRegistry;
}

export function createOperationsRoutes(options: OperationsRouteOptions = {}) {
  const getDb = () => options.db ?? getKernel().database.db;
  const getPluginRegistry = () => options.pluginRegistry ?? defaultPluginRegistry();
  return new Hono().onError((error,c)=>{if(error instanceof GatewayError)return c.json({status:"error",code:error.code},error.status as 400|401|403|404|409|500);if(error instanceof AgentError)return c.json({status:"error",code:error.code},error.status);throw error;})
    .get("/", (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      const namespace = stringQuery(c.req.query("namespace"));
      const db = getDb();
      return c.json({
        status: "ok",
        operations: listOperationSuggestions(db, namespace).map(
          (operation) => withRecentAudits(db, operation),
        ),
      });
    })
    .get("/:id", (c) => {
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) {
        return admin;
      }
      const operationId = c.req.param("id");
      const db = getDb();
      const operation = resolveOperationPolicy(db, operationId);
      if (operation === undefined) {
        return c.json(
          {
            status: "error",
            code: "not_found",
            message: `Operation not found: ${operationId}`,
          },
          404,
        );
      }
      return c.json({ status: "ok", operation: withRecentAudits(db, operation) });
    })
    .post("/:id/invoke", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const requestBody = isRecord(body) ? body : {};
      const result = await new OperationDispatcher({
        db: getDb(),
        registry: getPluginRegistry(),
      }).invoke({
        ...pluginRequestScope(c,getDb()),
        operationId: c.req.param("id"),
        input: requestBody.input ?? {},
        subject: {
          source: invocationSource(c),
          ...optionalField(
            "userId",
            dashboardAuthSessionFromContext(c)?.user?.id,
          ),
        },


        ...optionalField("messageId", requestHeader(c, "x-luna-message-id")),
      });
      const status = result.status === "success" ? 200 : operationDispatchStatus(result.errorCode);
      return c.json(result, status);
    });
}

type OperationInvocationAuditRow =
  typeof operationInvocationAudits.$inferSelect;

function withRecentAudits<T extends { readonly id: string; readonly metadata?: Record<string, unknown> }>(
  db: DrizzleDB,
  operation: T,
): T {
  const recentAudits = new OperationInvocationAuditStore(db)
    .listRecent({ operationId: operation.id, limit: 3 })
    .map(serializeAudit);
  if (recentAudits.length === 0) {
    return operation;
  }
  return {
    ...operation,
    metadata: {
      ...(operation.metadata ?? {}),
      recentAudits,
    },
  };
}

function serializeAudit(row: OperationInvocationAuditRow) {
  return {
    id: row.id,
    invocationId: row.invocation_id,
    operationId: row.operation_id,
    providerType: row.provider_type,
    pluginId: row.plugin_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    source: row.source,
    sessionId: row.session_id,
    taskId: row.task_id,
    messageId: row.message_id,
    status: row.status,
    errorCode: row.error_code,
    artifactCount: row.artifact_count,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    expiresAt: row.expires_at,
  };
}

export const operationsRoutes = createOperationsRoutes();

function stringQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? undefined : trimmed;
}

function defaultPluginRegistry(): PluginRegistry {
  return new PluginRegistry();
}

function invocationSource(c: Parameters<typeof dashboardAuthSessionFromContext>[0]): OperationInvocationSource {
  const claims = lunaAccessTokenClaimsFromContext(c);
  if (claims?.source === "cli") {
    return "cli";
  }
  if (claims?.source === "runner" && claims.runnerKind === "main") {
    return "main_runner";
  }
  if (claims?.source === "runner" && claims.runnerKind === "work") {
    return "work_runner";
  }
  if (claims?.source === "runner" && claims.runnerKind === "task") {
    return "task_runner";
  }
  if (dashboardAuthSessionFromContext(c)?.authenticated === true) {
    return "dashboard";
  }
  return "service_api";
}

function requestHeader(
  c: Parameters<typeof dashboardAuthSessionFromContext>[0],
  name: string,
): string | undefined {
  const value = c.req.header(name)?.trim() ?? "";
  return value.length === 0 ? undefined : value;
}



function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]: V } | {} {
  return value === undefined ? {} : { [key]: value } as { [P in K]: V };
}
