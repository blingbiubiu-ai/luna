import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../../../src/data";
import type { PersistedInvocationInput } from "../../../src/runners/invocation-codec";
import { InvocationStore } from "../../../src/runners/invocation-store";
import type { LunaAccessTokenClaims } from "../../../src/server/auth/access-token-service";
import { InvocationResources } from "../../../src/runners/invocation-resources";
import { AgentResourceBuilder } from "../../../src/runners/agent-resource-builder";
import { PluginRegistry } from "../../../src/plugins/registry";
import { home } from "../../../src/shared/config/paths";

export function startTestRunnerJob(db: DrizzleDB, invocationId: string, registry = new PluginRegistry()) {
  const store = new InvocationStore(db);
  const invocation = store.require(invocationId);
  const {selection} = new InvocationResources(db, home).pin(invocationId, new AgentResourceBuilder(db, home, registry));
  const job = store.createJob("test-runtime", {
    version: 2,
    jobId: randomUUID(),
    invocationId,
    environmentId: "luna",
    runnerContextId: invocation.runnerContextId,
    scopeKey: invocation.taskId && invocation.runnerKind === "task"
      ? `task:${invocation.taskId}:codex`
      : `session:${invocation.runnerContextId}`,
    runnerKind: invocation.runnerKind,
    ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
    ...(invocation.taskId ? { taskId: invocation.taskId } : {}),
    ...(invocation.taskRunId ? { taskRunId: invocation.taskRunId } : {}),
    scope: {agentId: invocation.agentId, shadowId: invocation.shadowId, placementGeneration: 1},
    resources: selection,
    resourceRevision: selection.digest,
    input: { runnerType: "codex", prompt: "Test" },
    credentialsRevision: 1,
    timeoutMs: 60_000,
  });
  return () => store.consume({ jobId: job.id, seq: 1, kind: "placement", data: { placementState: "terminal" } }, () => {});
}

export function registerTestRunnerJob(
  db: DrizzleDB,
  invocationId: string,
  claims: LunaAccessTokenClaims,
  inputSnapshot: PersistedInvocationInput,
  originId: string,
  registry?: PluginRegistry,
) {
  const store = new InvocationStore(db);
  store.register({
    id: invocationId,
    runnerKind: inputSnapshot.kind,
    actorUserId: claims.actorUserId,
    runnerContextId: claims.runnerJobId!,
    sessionId: claims.sessionId ?? null,
    taskId: claims.taskId ?? null,
    taskRunId: claims.taskRunId ?? null,
    originId,
    inputSnapshot,
    contextPackIds: [],
  });
  store.bindToken(invocationId, claims.tokenId);
  return startTestRunnerJob(db, invocationId, registry);
}
