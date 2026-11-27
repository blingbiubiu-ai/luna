import { Hono } from "hono";
import { z } from "zod";
import { AgentError } from "@/agents/agent-store";
import type { ReplyChannel } from "@/channels/outbound";
import type { DrizzleDB } from "@/data";
import {
  CORRELATED_REQUEST_MODES,
  CORRELATED_REQUEST_STATUSES,
} from "@/data/schema";
import { CorrelatedRequestService } from "@/messaging/correlated-request-service";
import { RunnerMessageService } from "@/messaging/runner-message-service";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";

const createRequestSchema = z
  .object({
    to: z.string().min(1).max(512),
    actor: z.string().trim().min(1).max(256).optional(),
    goal: z.string().trim().min(1).max(20_000),
    context: z.string().trim().max(10_000).optional(),
    options: z
      .array(z.string().trim().min(1).max(64))
      .min(2)
      .max(8)
      .optional(),
    expiresInMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 86_400_000)
      .optional(),
    waitMs: z.number().int().min(0).max(5 * 60_000).optional(),
  })
  .strict();

const updateRequestSchema = z
  .object({
    action: z.enum(["progress", "done", "declined"]),
    summary: z.string().trim().min(1).max(20_000),
    selectedOption: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const sendRequestMessageSchema = z
  .object({
    message: z.string().trim().min(1).max(20_000),
  })
  .strict();

const waitRequestSchema = z
  .object({
    timeoutMs: z.number().int().min(0).max(5 * 60_000).default(60_000),
  })
  .strict();

export function createRunnerRequestRoutes(
  options: {
    db?: DrizzleDB;
    channelFor?: (id: string) => ReplyChannel | undefined;
  } = {},
) {
  const db = () => options.db ?? getKernel().database.db;
  const channelFor =
    options.channelFor ?? ((id: string) => getKernel().replyChannel(id));
  const runnerSvc = () => new RunnerMessageService(db(), channelFor);
  const requestsSvc = () => new CorrelatedRequestService(db(), channelFor);

  return new Hono<{
    Variables: {
      lunaAccessTokenClaims: LunaAccessTokenClaims | undefined;
    };
  }>()
    .onError((error, c) => {
      if (error instanceof GatewayError) {
        return c.json(
          { error: error.code, message: error.message },
          error.status as 400,
        );
      }
      if (error instanceof AgentError) {
        return c.json({ error: error.code }, error.status);
      }
      if (error instanceof z.ZodError) {
        return c.json(
          { error: "invalid_request", details: error.issues },
          400,
        );
      }
      return c.json({ error: "internal_error", message: String(error) }, 500);
    })
    .post("/requests", async c => {
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w.-]{1,128}$/.test(key)) {
        return c.json({ error: "invalid_idempotency_key" }, 400);
      }
      const body = createRequestSchema.parse(
        await c.req.json().catch(() => null),
      );
      const actor = runnerSvc().anyActor(c.get("lunaAccessTokenClaims"));
      const created = requestsSvc().createRequest({
        actor,
        key,
        toAddress: body.to,
        targetActor: body.actor,
        goal: body.goal,
        contextSummary: body.context,
        options: body.options,
        expiresInMs: body.expiresInMs,
      });

      if (body.waitMs && body.waitMs > 0) {
        const claims = c.get("lunaAccessTokenClaims");
        const waited = await requestsSvc().waitForRequest({
          shadowId: actor.shadowId,
          requestId: created.id,
          timeoutMs: body.waitMs,
          signal: c.req.raw.signal,
          ...(actor.taskId && actor.taskRunId
            ? {
                consumerTask: {
                  taskId: actor.taskId,
                  runnerContextId: claims?.runnerJobId ?? actor.taskRunId,
                  runId: actor.taskRunId,
                },
              }
            : {}),
        });
        const req = waited.request;
        return c.json(
          {
            commandId: req.id,
            outboundCommandId: req.outboundCommandId,
            requestId: req.id,
            kind: "request",
            mode: req.mode,
            status: req.status,
            settled: waited.settled,
            targetSessionId: req.targetSessionId,
            targetUserId: req.targetUserId,
            expiresAt: req.expiresAt,
            result: {
              requestId: req.id,
              mode: req.mode,
              status: req.status,
              settled: waited.settled,
              outboundCommandId: req.outboundCommandId,
              targetSessionId: req.targetSessionId,
              targetUserId: req.targetUserId,
              expiresAt: req.expiresAt,
              outcome: req.resultJson,
            },
            events: waited.events,
            error: null,
          },
          waited.settled ? 200 : 202,
        );
      }

      return c.json(
        {
          commandId: created.id,
          outboundCommandId: created.outboundCommandId,
          requestId: created.id,
          kind: "request",
          mode: created.mode,
          status: created.status,
          targetSessionId: created.targetSessionId,
          targetUserId: created.targetUserId,
          expiresAt: created.expiresAt,
          result: {
            requestId: created.id,
            mode: created.mode,
            status: created.status,
            outboundCommandId: created.outboundCommandId,
            targetSessionId: created.targetSessionId,
            targetUserId: created.targetUserId,
            expiresAt: created.expiresAt,
          },
          error: null,
        },
        201,
      );
    })
    .get("/requests", c => {
      const actor = runnerSvc().anyActor(c.get("lunaAccessTokenClaims"));
      const query = z
        .object({
          status: z.enum(CORRELATED_REQUEST_STATUSES).optional(),
          mode: z.enum(CORRELATED_REQUEST_MODES).optional(),
          role: z.enum(["origin", "target"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(c.req.query());

      const rows = requestsSvc().listRequests(actor.shadowId, {
        status: query.status,
        mode: query.mode,
        ...(query.role === "origin"
          ? actor.taskId
            ? { originTaskId: actor.taskId }
            : { originSessionId: actor.currentSessionId }
          : query.role === "target"
            ? { targetSessionId: actor.currentSessionId }
            : {}),
        limit: query.limit,
      });
      return c.json({ requests: rows });
    })
    .get("/requests/:id", c => {
      const actor = runnerSvc().anyActor(c.get("lunaAccessTokenClaims"));
      const detail = requestsSvc().getRequest(actor.shadowId, c.req.param("id"));
      return c.json(detail);
    })
    .post("/requests/:id/wait", async c => {
      const claims = c.get("lunaAccessTokenClaims");
      const actor = runnerSvc().anyActor(claims);
      const body = waitRequestSchema.parse(
        await c.req.json().catch(() => ({})),
      );
      const waited = await requestsSvc().waitForRequest({
        shadowId: actor.shadowId,
        requestId: c.req.param("id"),
        timeoutMs: body.timeoutMs,
        signal: c.req.raw.signal,
        ...(actor.taskId && actor.taskRunId
          ? {
              consumerTask: {
                taskId: actor.taskId,
                runnerContextId: claims?.runnerJobId ?? actor.taskRunId,
                runId: actor.taskRunId,
              },
            }
          : {}),
      });
      return c.json({
        requestId: waited.request.id,
        status: waited.request.status,
        settled: waited.settled,
        request: waited.request,
        events: waited.events,
      });
    })
    .post("/requests/:id/update", async c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const body = updateRequestSchema.parse(
        await c.req.json().catch(() => null),
      );
      const { request, alreadyResolved } = requestsSvc().updateRequest({
        requestId: c.req.param("id"),
        action: body.action,
        summary: body.summary,
        selectedOption: body.selectedOption,
        resolvedByUserId: actor.userId,
        source: "runner",
        expectedShadowId: actor.shadowId,
        expectedTargetSessionId: actor.currentSessionId,
      });
      return c.json({
        commandId: request.id,
        kind: "request.update",
        status: request.status,
        request,
        alreadyResolved,
        result: {
          requestId: request.id,
          status: request.status,
          alreadyResolved,
        },
        error: null,
      });
    })
    .post("/requests/:id/messages", async c => {
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w.-]{1,128}$/.test(key)) {
        return c.json({ error: "invalid_idempotency_key" }, 400);
      }
      const actor = runnerSvc().anyActor(c.get("lunaAccessTokenClaims"));
      const body = sendRequestMessageSchema.parse(
        await c.req.json().catch(() => null),
      );
      const { request, command } = requestsSvc().sendMessage({
        actor,
        key,
        requestId: c.req.param("id"),
        message: body.message,
      });
      return c.json(
        {
          commandId: command.id,
          kind: "request.message",
          status: command.status,
          requestId: request.id,
          request,
          result: {
            requestId: request.id,
            triggerId: command.id,
            targetSessionId: request.targetSessionId,
          },
          error: null,
        },
        202,
      );
    })
    .post("/requests/:id/cancel", c => {
      const actor = runnerSvc().anyActor(c.get("lunaAccessTokenClaims"));
      const request = requestsSvc().cancelRequest({
        requestId: c.req.param("id"),
        shadowId: actor.shadowId,
        actorUserId: actor.userId,
        ...(actor.taskId
          ? { expectedOriginTaskId: actor.taskId }
          : { expectedOriginSessionId: actor.currentSessionId, expectedOriginTaskId: null }),
      });
      return c.json({
        commandId: request.id,
        kind: "request.cancel",
        status: request.status,
        request,
        result: {
          requestId: request.id,
          status: request.status,
        },
        error: null,
      });
    });
}
