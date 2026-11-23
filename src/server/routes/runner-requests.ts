import { Hono } from "hono";
import { z } from "zod";
import { AgentError } from "@/agents/agent-store";
import type { ReplyChannel } from "@/channels/outbound";
import type { DrizzleDB } from "@/data";
import { CORRELATED_REQUEST_STATUSES } from "@/data/schema";
import { CorrelatedRequestService } from "@/messaging/correlated-request-service";
import { RunnerMessageService } from "@/messaging/runner-message-service";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";

const createAskSchema = z
  .object({
    to: z.string().min(1).max(512),
    question: z.string().trim().min(1).max(20_000),
    context: z.string().trim().max(5_000).optional(),
    options: z.array(z.string().trim().min(1).max(64)).min(2).max(8).optional(),
    expiresInMs: z.number().int().min(60_000).max(30 * 86_400_000).optional(),
  })
  .strict();

const answerAskSchema = z
  .object({
    answer: z.string().trim().min(1).max(20_000),
    selectedOption: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const resolveHandoffSchema = z
  .object({
    declined: z.boolean().default(false),
    reason: z.string().trim().max(5_000).optional(),
    summary: z.string().trim().max(5_000).optional(),
  })
  .strict()
  .refine(
    b => Boolean((b.declined ? b.reason : b.summary ?? b.reason)?.trim()),
    "Provide summary (when done) or reason (when declined)",
  );

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
    .post("/asks", async c => {
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w.-]{1,128}$/.test(key)) {
        return c.json({ error: "invalid_idempotency_key" }, 400);
      }
      const body = createAskSchema.parse(await c.req.json().catch(() => null));
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const created = requestsSvc().createAsk({
        actor,
        key,
        toAddress: body.to,
        question: body.question,
        contextSummary: body.context,
        options: body.options,
        expiresInMs: body.expiresInMs,
      });
      return c.json(
        {
          commandId: created.id,
          outboundCommandId: created.outboundCommandId,
          requestId: created.id,
          kind: "ask",
          status: created.status,
          targetSessionId: created.targetSessionId,
          expiresAt: created.expiresAt,
          result: {
            requestId: created.id,
            outboundCommandId: created.outboundCommandId,
            targetSessionId: created.targetSessionId,
            expiresAt: created.expiresAt,
          },
          error: null,
        },
        201,
      );
    })
    .get("/asks", c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const query = z
        .object({
          status: z.enum(CORRELATED_REQUEST_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(c.req.query());
      const rows = requestsSvc().listRequests(actor.shadowId, {
        kind: "ask",
        status: query.status,
        limit: query.limit,
      });
      return c.json({ asks: rows });
    })
    .post("/asks/:id/answer", async c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const body = answerAskSchema.parse(await c.req.json().catch(() => null));
      const { request, alreadyResolved } = requestsSvc().answerAsk({
        requestId: c.req.param("id"),
        answer: body.answer,
        selectedOption: body.selectedOption,
        resolvedByUserId: actor.userId,
        source: "runner",
        expectedShadowId: actor.shadowId,
        expectedTargetSessionId: actor.currentSessionId,
      });
      return c.json({ request, alreadyResolved });
    })
    .post("/asks/:id/cancel", c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const request = requestsSvc().cancelAsk({
        requestId: c.req.param("id"),
        shadowId: actor.shadowId,
      });
      return c.json({ request });
    })
    .post("/handoffs/:id/resolve", async c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const body = resolveHandoffSchema.parse(
        await c.req.json().catch(() => null),
      );
      const request = requestsSvc().resolveHandoff({
        requestId: c.req.param("id"),
        shadowId: actor.shadowId,
        targetSessionId: actor.currentSessionId,
        declined: body.declined,
        summaryOrReason: (body.declined
          ? body.reason
          : body.summary ?? body.reason)!,
        resolvedByUserId: actor.userId,
      });
      return c.json({ request });
    })
    .get("/requests", c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const query = z
        .object({
          status: z.enum(CORRELATED_REQUEST_STATUSES).optional(),
          kind: z.enum(["ask", "handoff"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(c.req.query());
      const rows = requestsSvc().listRequests(actor.shadowId, {
        status: query.status,
        kind: query.kind,
        limit: query.limit,
      });
      return c.json({ requests: rows });
    });
}
