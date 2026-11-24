import { Hono } from "hono";
import { z, ZodError } from "zod";
import type { TaskReportService } from "@/tasks/task-report-service";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";

const submitSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(100000)
      .refine(s => s.trim().length > 0),
  })
  .strict();

const pauseSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    wakeInMs: z
      .number()
      .int()
      .min(5_000)
      .max(7 * 86_400_000)
      .optional(),
  })
  .strict();

const hookCheckSchema = z
  .object({
    phase: z.enum(["post_tool", "stop"]),
  })
  .strict();

export function createTaskReportRoutes(service?: TaskReportService) {
  const reports = () => service ?? getKernel().taskReports();
  return new Hono<{
    Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims | undefined };
  }>()
    .onError((error, c) =>
      error instanceof GatewayError
        ? c.json(
            { error: error.code, message: error.message },
            error.status as 400,
          )
        : error instanceof ZodError
          ? c.json({ error: "invalid_report", details: error.issues }, 400)
          : c.json({ error: "report_failed", message: String(error) }, 500),
    )
    .post("/", async c => {
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w.-]{1,128}$/.test(key)) {
        return c.json({ error: "invalid_idempotency_key" }, 400);
      }
      const body = submitSchema.parse(await c.req.json().catch(() => null));
      return c.json(
        reports().submit(c.get("lunaAccessTokenClaims"), key, body.content),
      );
    })
    .post("/pause", async c => {
      const body = pauseSchema.parse(await c.req.json().catch(() => null));
      return c.json(
        reports().pause(c.get("lunaAccessTokenClaims"), {
          reason: body.reason,
          wakeInMs: body.wakeInMs,
        }),
      );
    })
    .post("/hook-check", async c => {
      const body = hookCheckSchema.parse(await c.req.json().catch(() => null));
      return c.json(
        reports().hookCheck(c.get("lunaAccessTokenClaims"), body.phase),
      );
    });
}
