import { Hono } from "hono";
import { ZodError } from "zod";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { OperationExecutionError, type RunnerOperationService } from "@/runners/operation-service";
import type { OperationKind } from "@/runners/operation-contract";
import { getKernel } from "./kernel";

export function createRunnerOperationRoutes(service?: RunnerOperationService) {
  const commands = () => service ?? getKernel().runnerOperations();
  const app = new Hono<{Variables: {lunaAccessTokenClaims: LunaAccessTokenClaims | undefined}}>()
    .onError((error, c) => error instanceof OperationExecutionError
      ? c.json(error.receipt, error.httpStatus as 400)
      : error instanceof GatewayError
      ? c.json({error: error.code, message: error.message}, error.status as 400)
      : error instanceof ZodError ? c.json({error: "invalid_operation", details: error.issues}, 400)
      : c.json({error: "operation_failed", message: String(error)}, 500));
  const routes: [string, OperationKind][] = [["/tasks/cancel", "task.cancel"], ["/tasks/status-card", "task.status_card"], ["/tasks/create", "task.create"], ["/tasks/update", "task.update"], ["/tasks/restart", "task.restart"], ["/session/create-thread", "session.create_thread"], ["/session/clarify", "session.clarify"], ["/session/release", "session.release"]];
  for (const [path, kind] of routes) app.post(path, async c => {
    const key = c.req.header("Idempotency-Key");
    if (!key || !/^[\w.-]{1,128}$/.test(key)) return c.json({error: "invalid_idempotency_key"}, 400);
    return c.json(await commands().execute(c.get("lunaAccessTokenClaims"), kind, key, await c.req.json().catch(() => null)));
  });
  return app.get("/operations/:id", c => c.json(commands().get(c.get("lunaAccessTokenClaims"), c.req.param("id"))));
}
