import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { selfRoutineKindOfTrigger } from "@/agents/self-routines";
import type { ReplyChannel } from "@/channels/outbound";
import type { DrizzleDB } from "@/data";
import {
  correlatedRequests,
  runnerOperations,
  sessionCommands,
  taskReportCommands,
} from "@/data/schema";
import {
  buildMainCapabilities,
  buildTaskCapabilities,
  buildWorkCapabilities,
  RUNNER_PROTOCOL_VERSION,
} from "@/runners/capabilities";
import { InvocationService } from "@/runners/invocation-service";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";

export function createRunnerProtocolV2Routes(
  options: {
    db?: DrizzleDB;
    channelFor?: (id: string) => ReplyChannel | undefined;
  } = {},
) {
  const db = () => options.db ?? getKernel().database.db;

  return new Hono<{
    Variables: {
      lunaAccessTokenClaims: LunaAccessTokenClaims | undefined;
    };
  }>()
    .use("*", async (c, next) => {
      const versionHeader = c.req.header("x-luna-protocol-version");
      if (versionHeader !== undefined) {
        const parsed = Number(versionHeader);
        if (!Number.isFinite(parsed) || parsed < RUNNER_PROTOCOL_VERSION) {
          return c.json(
            {
              error: "protocol_version_unsupported",
              message: `Runner Protocol v${RUNNER_PROTOCOL_VERSION} is required`,
            },
            426,
          );
        }
      }
      await next();
    })
    .onError((error, c) =>
      error instanceof GatewayError
        ? c.json(
            { error: error.code, message: error.message },
            error.status as 400,
          )
        : c.json({ error: "internal_error", message: String(error) }, 500),
    )
    .get("/whoami", c => {
      const claims = c.get("lunaAccessTokenClaims");
      if (
        claims?.source !== "runner" ||
        claims.role !== "runner" ||
        !claims.runnerKind
      ) {
        throw new GatewayError(
          "runner_required",
          "A Runner token is required",
          403,
        );
      }
      const { invocation, snapshot } = new InvocationService(
        db(),
      ).requireActive(claims, claims.runnerKind);

      if (snapshot.kind === "main") {
        const capabilities = buildMainCapabilities(db(), snapshot.input.input, {
          agentId: invocation.agentId,
          shadowId: invocation.shadowId,
          actorUserId: invocation.actorUserId,
        });
        return c.json({ capabilities });
      }

      if (snapshot.kind === "work") {
        const routineKind = selfRoutineKindOfTrigger(
          db(),
          snapshot.input.turnId,
        );
        const capabilities = buildWorkCapabilities(db(), {
          agentId: invocation.agentId,
          shadowId: invocation.shadowId,
          sessionId: invocation.sessionId!,
          actorUserId: invocation.actorUserId,
          routineKind,
          allowSilent: Boolean(routineKind),
        });
        return c.json({ capabilities });
      }

      const capabilities = buildTaskCapabilities({
        agentId: invocation.agentId,
        shadowId: invocation.shadowId,
        taskId: invocation.taskId!,
        taskRunId: invocation.taskRunId ?? undefined,
        actorUserId: invocation.actorUserId,
      });
      return c.json({ capabilities });
    })
    .get("/commands/:id", c => {
      const claims = c.get("lunaAccessTokenClaims");
      if (
        claims?.source !== "runner" ||
        claims.role !== "runner" ||
        !claims.runnerKind
      ) {
        throw new GatewayError(
          "runner_required",
          "A Runner token is required",
          403,
        );
      }
      const { invocation } = new InvocationService(db()).requireActive(
        claims,
        claims.runnerKind,
      );
      const id = c.req.param("id");

      // 1. Task report ledger (`taskReportCommands`)
      const reportRow = db()
        .select()
        .from(taskReportCommands)
        .where(eq(taskReportCommands.id, id))
        .get();
      if (reportRow) {
        if (
          invocation.runnerKind !== "task" ||
          reportRow.taskId !== invocation.taskId ||
          reportRow.actorUserId !== invocation.actorUserId
        ) {
          throw new GatewayError("command_not_found", "Command not found", 404);
        }
        return c.json({
          commandId: reportRow.id,
          kind: "task.report",
          status: "accepted",
          result: {
            taskId: reportRow.taskId,
            taskRunId: reportRow.taskRunId,
            reportArtifactId: reportRow.reportArtifactId,
          },
          taskId: reportRow.taskId,
          taskRunId: reportRow.taskRunId,
          reportArtifactId: reportRow.reportArtifactId,
          error: null,
        });
      }

      // 2. Domain operation ledger (`runnerOperations`: task.* / session.*)
      const opRow = db()
        .select()
        .from(runnerOperations)
        .where(eq(runnerOperations.id, id))
        .get();
      if (opRow) {
        if (
          opRow.sessionId !== invocation.sessionId ||
          opRow.context.actorUserId !== invocation.actorUserId
        ) {
          throw new GatewayError("command_not_found", "Command not found", 404);
        }
        const cleanResult = opRow.result
          ? (({ cardDelivery: _cd, ...rest }) => rest)(opRow.result)
          : null;
        return c.json({
          commandId: opRow.id,
          kind: opRow.request.kind,
          operation: opRow.request.kind,
          sessionId: opRow.sessionId,
          status: opRow.status,
          result: cleanResult,
          ...(opRow.result?.targetSessionId
            ? { targetSessionId: opRow.result.targetSessionId }
            : {}),
          ...(opRow.result?.taskId ? { taskIds: [opRow.result.taskId] } : {}),
          ...(opRow.result?.runId ? { runId: opRow.result.runId } : {}),
          error: opRow.error,
        });
      }

      // 3. Correlated requests (`correlatedRequests`: ask / handoff)
      const reqRow = db()
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, id))
        .get();
      if (reqRow) {
        if (reqRow.shadowId !== invocation.shadowId) {
          throw new GatewayError("command_not_found", "Command not found", 404);
        }
        return c.json({
          commandId: reqRow.id,
          kind: reqRow.kind,
          status: reqRow.status,
          result: {
            requestId: reqRow.id,
            targetAddress: reqRow.targetAddress,
            targetSessionId: reqRow.targetSessionId,
            resolvedByUserId: reqRow.resolvedByUserId,
            outcome: reqRow.resultJson,
          },
          error: null,
        });
      }

      // 4. Session command ledger (`sessionCommands`: message.send / session.invoke / task.run / group.*)
      const cmdRow = db()
        .select()
        .from(sessionCommands)
        .where(eq(sessionCommands.id, id))
        .get();
      if (
        !cmdRow ||
        cmdRow.actorUserId !== invocation.actorUserId ||
        cmdRow.sourceSessionId !== invocation.sessionId ||
        (cmdRow.sessionId !== invocation.sessionId &&
          cmdRow.originId !== invocation.originId)
      ) {
        throw new GatewayError("command_not_found", "Command not found", 404);
      }
      return c.json({
        commandId: cmdRow.id,
        kind: cmdRow.kind,
        status: cmdRow.status,
        deliveryStatus: cmdRow.status,
        sessionId: cmdRow.sessionId,
        messageId: cmdRow.messageId,
        providerMessageId: cmdRow.providerMessageId,
        result:
          cmdRow.payload.result ?? {
            sessionId: cmdRow.sessionId,
            messageId: cmdRow.messageId,
            providerMessageId: cmdRow.providerMessageId,
          },
        error: cmdRow.error,
      });
    });
}
