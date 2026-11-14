import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { runnerContexts, runnerContextOrigins } from "@/data/schema";
import type { ExecutionRuntime } from "@/runtime/execution-runtime";
import { ExecutionError } from "@luna/execution-store";

/** Resolution resets unbound CLI sessions; scheduling requires the resulting Runtime origin. */
export async function verifyRuntimeContexts(db: DrizzleDB, client: ExecutionRuntime, contextId?: string): Promise<void> {
  const rows = db.select({ context: runnerContexts, origin: runnerContextOrigins }).from(runnerContexts)
    .leftJoin(runnerContextOrigins, eq(runnerContexts.id, runnerContextOrigins.contextId))
    .where(contextId ? eq(runnerContexts.id, contextId) : undefined).all();
  if (contextId && !rows.length) throw new ExecutionError(409, "context_not_found");
  for (const { context, origin } of rows) {
    if (origin) {
      if (origin.runtimeId !== client.runtimeId) throw new ExecutionError(409, "context_runtime_mismatch", { contextId: context.id });
      continue;
    }
    if (contextId) {
      throw new ExecutionError(409, "context_runtime_unbound", { contextId });
    }
  }
}
