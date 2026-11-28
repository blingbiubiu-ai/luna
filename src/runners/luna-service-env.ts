import {config} from "@/shared";
import {InvocationResources} from "./invocation-resources";
import type {AgentResourceBuilder} from "./agent-resource-builder";
import {executionReference} from "@/agent-config/execution-reference";
import type {AgentExecutionSnapshot} from "@/agent-config";
import { InvocationStore } from "./invocation-store";
import { encodeInvocation } from "./invocation-codec";
import { mainInvocations, mainMessageOrigin } from "./main-invocation-registry";
import { taskInvocations } from "@/tasks/task-report-store";
import type { DrizzleDB } from "@/data";
import {
  canonicalUserIdForRequestedIdentity,
} from "@/identity/requested-identity";
import type { RequestedIdentityContext } from "@/identity/requested-identity";
import { AccessTokenService } from "@/server/auth/access-token-service";
import { getKernel } from "@/server/routes/kernel";
import { DEFAULT_LUNA_SERVICE_HOST, DEFAULT_LUNA_SERVICE_PORT } from "@luna/host-runtime/defaults";

export type LunaRunnerKind = "main" | "task";

const RUNNER_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunnerAccessTokenIssuer {
  issueRunnerToken(input: {
    readonly userId: string;
    readonly runnerKind: LunaRunnerKind;
    readonly runnerContextId: string;
    readonly sessionId?: string;
    readonly taskId?: string;
    readonly taskRunId?: string;
    readonly artifactIds?: readonly string[];
    readonly ttlMs: number;
  }): string;
}

export interface BuildLunaServiceRunnerEnvInput {
  readonly agentConfig?: AgentExecutionSnapshot;
  /** The Agent the Runner acts in; requester identities are resolved among its users. Defaults to `agentConfig.agentId`. */
  readonly agentId?: string;
  readonly resourceBuilder?: AgentResourceBuilder;
  readonly invocationId?: string;
  readonly runnerKind: LunaRunnerKind;
  readonly runnerContextId: string;
  readonly sessionId?: string | null | undefined;
  readonly taskId?: string | null | undefined;
  readonly taskRunId?: string | null | undefined;
  readonly artifactIds?: readonly string[];
  readonly requestedByIdentity?: RequestedIdentityContext | null | undefined;
  readonly requestedByUserId?: string | null | undefined;
  readonly db?: DrizzleDB;
  readonly accessTokenSigningSecret?: string;
  readonly tokenIssuer?: RunnerAccessTokenIssuer;
  readonly now?: number;
}

export function buildLunaServiceRunnerEnv(
  input: BuildLunaServiceRunnerEnvInput,
): Record<string, string> {
  return {
    LUNA_SERVICE_URL: resolveLunaServiceUrl(),
    LUNA_ACCESS_TOKEN: issueLunaRunnerAccessToken(input),
    ...optionalEnv("LUNA_INVOCATION_ID", input.invocationId),
    ...optionalEnv("LUNA_AGENT_ID", input.agentConfig?.agentId),
    LUNA_ACTOR_KIND: "runner",
    LUNA_ACTOR_ID: input.runnerContextId,
    LUNA_RUNNER_KIND: input.runnerKind,
    LUNA_RUNNER_CONTEXT_ID: input.runnerContextId,
    ...optionalEnv("LUNA_SESSION_ID", input.sessionId),
    ...optionalEnv("LUNA_TASK_ID", input.taskId),
    ...optionalEnv("LUNA_TASK_RUN_ID", input.taskRunId),
  };
}

export function resolveLunaServiceUrl(): string {
  const configured = trimEnv("LUNA_SERVICE_URL");
  if (configured !== undefined) {
    return configured.replace(/\/+$/, "");
  }
  const host = trimEnv("LUNA_SERVICE_HOST") ?? DEFAULT_LUNA_SERVICE_HOST;
  const port = trimEnv("LUNA_SERVICE_PORT") ??
    String(DEFAULT_LUNA_SERVICE_PORT);
  const clientHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${clientHost}:${port}`;
}

function issueLunaRunnerAccessToken(
  input: BuildLunaServiceRunnerEnvInput,
): string {
  const explicitRequestedByUserId = input.requestedByUserId?.trim();
  const requestedByUserId =
    explicitRequestedByUserId !== undefined &&
      explicitRequestedByUserId.length > 0
      ? explicitRequestedByUserId
      : resolveRequestedByUserId(input.db ?? serviceAuthDb(), input);
  if (requestedByUserId === undefined) {
    throw new Error(
      "Luna runner access token requires requestedByUserId.",
    );
  }
  if (input.tokenIssuer !== undefined) {
    return input.tokenIssuer.issueRunnerToken({
      userId: requestedByUserId,
      runnerKind: input.runnerKind,
      runnerContextId: input.runnerContextId,
      ...(input.sessionId === undefined || input.sessionId === null
        ? {}
        : { sessionId: input.sessionId }),
      ...(input.taskId === undefined || input.taskId === null
        ? {}
        : { taskId: input.taskId }),
      ...(input.taskRunId === undefined || input.taskRunId === null
        ? {}
        : { taskRunId: input.taskRunId }),
      ...(input.artifactIds === undefined ? {} : { artifactIds: input.artifactIds }),
      ttlMs: RUNNER_ACCESS_TOKEN_TTL_MS,
    });
  }
  const db = input.db ?? serviceAuthDb();
  if (db === undefined) {
    throw new Error("Luna runner access token requires a service database.");
  }
  const signingSecret = input.accessTokenSigningSecret ??
    resolveLunaAccessTokenSigningSecret();
  if (signingSecret === undefined) {
    throw new Error(
      "Luna runner access token requires LUNA_ACCESS_TOKEN_SECRET.",
    );
  }
  const now = input.now ?? Date.now();
  const store = new InvocationStore(db);
  if (!input.invocationId) throw new Error("Runtime Runner requires invocation identity");
  const active = input.runnerKind === "main" ? mainInvocations(db).get(input.invocationId)
    : taskInvocations(db).get(input.invocationId);
  if (!active) throw new Error("Runtime Runner requires a registered business invocation");
  const snapshot = encodeInvocation(input.runnerKind, active);
  const originId = snapshot.kind === "main" ? mainMessageOrigin(snapshot.input) : snapshot.input.taskRunId;
  store.register({ id: input.invocationId, runnerKind: input.runnerKind, actorUserId: requestedByUserId, runnerContextId: input.runnerContextId,
    sessionId: input.sessionId ?? null, taskId: input.taskId ?? null, taskRunId: input.taskRunId ?? null, originId,
    inputSnapshot: snapshot, contextPackIds: [], agentConfig:input.agentConfig ? executionReference(input.agentConfig) : null });
  if(input.agentConfig) {
    new InvocationResources(db,config.paths.home).pin(input.invocationId,input.resourceBuilder ?? getKernel().agentResourceBuilder);
  }
  const issued = new AccessTokenService({ db, signingSecret }).issueToken({
    userId: requestedByUserId,
    name: `${input.runnerKind} runner ${input.runnerContextId}`,
    source: "runner",
    role: "runner",
    ttlMs: RUNNER_ACCESS_TOKEN_TTL_MS,
    now,
    runnerKind: input.runnerKind,
    sourceRunnerJobId: input.runnerContextId,
    ...(input.sessionId === undefined || input.sessionId === null
      ? {}
      : { sourceSessionId: input.sessionId }),
    ...(input.taskId === undefined || input.taskId === null
      ? {}
      : { sourceTaskId: input.taskId }),
    ...(input.taskRunId === undefined || input.taskRunId === null
      ? {}
      : { sourceTaskRunId: input.taskRunId }),
    metadata: {
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      artifactIds: [...new Set(input.artifactIds ?? [])],
    },
  });
  store.bindToken(input.invocationId, issued.record.id);
  return issued.token;
}

function serviceAuthDb(): DrizzleDB | undefined {
  try {
    return getKernel().database.db;
  } catch {
    return undefined;
  }
}

function resolveRequestedByUserId(
  db: DrizzleDB | undefined,
  input: BuildLunaServiceRunnerEnvInput,
): string | undefined {
  const explicit = input.requestedByUserId?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const agentId = input.agentId ?? input.agentConfig?.agentId;
  if (db === undefined || agentId === undefined) {
    return undefined;
  }
  return canonicalUserIdForRequestedIdentity(
    db,
    agentId,
    input.requestedByIdentity ?? undefined,
  );
}

export function resolveLunaAccessTokenSigningSecret(): string | undefined {
  // LUNA_DASHBOARD_TOKEN is a local-development fallback only. Production
  // service deployments should configure LUNA_ACCESS_TOKEN_SECRET.
  return trimEnv("LUNA_ACCESS_TOKEN_SECRET") ??
    trimEnv("LUNA_DASHBOARD_TOKEN");
}

function trimEnv(key: string): string | undefined {
  const value = Bun.env[key]?.trim() ?? process.env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function optionalEnv(
  key: string,
  value: string | null | undefined,
): Record<string, string> {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? {}
    : { [key]: normalized };
}
