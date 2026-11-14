import {fixtureNamedSession,fixtureRunnerContext} from "../helpers/platform-fixtures";
import { taskInvocations } from "../../src/tasks/task-report-store";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { IdentityDirectory } from "../../src/identity/identity-directory";
import { MainRunner } from "../../src/main-runner/main-runner";
import type { MainRunnerInput } from "../../src/main-runner/types";
import { buildLunaServiceRunnerEnv } from "../../src/runners/luna-service-env";
import type { ResolvedRunnerContext } from "../../src/runners/runner-context-store";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { config, setLunaHome } from "../../src/shared";
import type {
  AgentRunOptions,
  AgentRunner,
  AssistantMessage,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from "../../src/shared";

const ENV_KEYS = [
  "LUNA_SERVICE_URL",
  "LUNA_SERVICE_HOST",
  "LUNA_SERVICE_PORT",
  "LUNA_RUNNER_TOKEN",
  "LUNA_SERVICE_TOKEN",
  "LUNA_ACCESS_TOKEN_SECRET",
  "LUNA_DASHBOARD_TOKEN",
] as const;

const previousEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete Bun.env[key];
      delete process.env[key];
    } else {
      Bun.env[key] = value;
      process.env[key] = value;
    }
  }
  previousEnv.clear();
});

test("Main Runner does not expose requester identity override env vars", async () => {
  setEnv("LUNA_SERVICE_URL", "http://luna.test:9000/");
  setEnv("LUNA_ACCESS_TOKEN_SECRET", "runner-access-secret");
  const runner = new CapturingRunner();

  await withFreshDbAsync(async ({ db, user }) => {
    await new MainRunner({
      runner,
      serviceAuthDb: db,
      accessTokenSigningSecret: "runner-access-secret",
      serviceAuthNow: 1000,
    }).run({
      runnerContext: fixtureRunnerContext(db, runnerContextRow({
        id: "runner_context_main",
        owner_type: "session",
        owner_id: "session_1",
      })),
      input: userMessagesInput(user.id),
    });
  });

  expect(runner.options?.env).not.toHaveProperty("LUNA_USER_ID");
  expect(runner.options?.env).not.toHaveProperty("LUNA_IDENTITY_PROVIDER");
  expect(runner.options?.env).not.toHaveProperty("LUNA_IDENTITY_ID");
  expect(runner.options?.env).not.toHaveProperty("LUNA_IDENTITY_TENANT_KEY");
  expect(runner.options?.env).not.toHaveProperty("LUNA_IDENTITY_NAMESPACE");
  expect(runner.options?.env).not.toHaveProperty("LUNA_IDENTITY_KIND");
  expect(runner.options?.env).not.toHaveProperty("LUNA_IDENTITY_SCOPE");
});

test("Runner env accepts an injected issuer and issues one access token per invocation", () => {
  const issued: Array<{
    userId: string;
    runnerKind: string;
    runnerContextId: string;
    ttlMs: number;
  }> = [];
  const tokenIssuer = {
    issueRunnerToken(input: {
      userId: string;
      runnerKind: "main" | "work" | "task";
      runnerContextId: string;
      ttlMs: number;
    }) {
      issued.push(input);
      return `runner-token-${issued.length}`;
    },
  };

  const first = buildLunaServiceRunnerEnv({
    runnerKind: "main",
    runnerContextId: "runner_job_1",
    sessionId: "session_1",
    requestedByUserId: "user_1",
    tokenIssuer,
  });
  const second = buildLunaServiceRunnerEnv({
    runnerKind: "main",
    runnerContextId: "runner_job_2",
    sessionId: "session_1",
    requestedByUserId: "user_1",
    tokenIssuer,
  });

  expect(first.LUNA_ACCESS_TOKEN).toBe("runner-token-1");
  expect(second.LUNA_ACCESS_TOKEN).toBe("runner-token-2");
  expect(first.LUNA_ACCESS_TOKEN).not.toBe(second.LUNA_ACCESS_TOKEN);
  expect(first).not.toHaveProperty("LUNA_RUNNER_TOKEN");
  expect(first).not.toHaveProperty("LUNA_SERVICE_TOKEN");
  expect(issued.map((item) => item.runnerContextId)).toEqual([
    "runner_job_1",
    "runner_job_2",
  ]);
  expect(issued[0]?.ttlMs).toBe(24 * 60 * 60 * 1000);
});

test("Work Runner receives a distinct service identity", () => {
  const issued: Array<{ runnerKind: string }> = [];
  const env = buildLunaServiceRunnerEnv({
    runnerKind: "work",
    runnerContextId: "runner_context_work",
    sessionId: "session_work",
    requestedByUserId: "user_work",
    tokenIssuer: {
      issueRunnerToken(input) {
        issued.push({ runnerKind: input.runnerKind });
        return "work-runner-token";
      },
    },
  });

  expect(env.LUNA_RUNNER_KIND).toBe("work");
  expect(issued).toEqual([{ runnerKind: "work" }]);
});

test("Task Runner service env does not expose channel identity override env vars", () => {
  setEnv("LUNA_SERVICE_URL", "http://luna.test:9000/");
  setEnv("LUNA_ACCESS_TOKEN_SECRET", "runner-access-secret");

  withFreshDb(({ db, user }) => {
    taskInvocations(db).set("test-invocation", {
      taskId: "task_1", taskRunId: "task_run_1", runnerContextId: "runner_context_task",
    });
    const env = buildLunaServiceRunnerEnv({
      invocationId: "test-invocation",
      runnerKind: "task",
      runnerContextId: "runner_context_task",
      sessionId: "session_1",
      taskId: "task_1",
      taskRunId: "task_run_1",
      requestedByIdentity: {
        provider: "lark",
        externalUserId: "ou_sender",
        tenantKey: "tenant-1",
        canonicalUserId: user.id,
        identityNamespace: "lark",
        identityKind: "open_id",
        identityScope: "tenant:tenant-1",
      },
      requestedByUserId: user.id,
      db,
      now: 1000,
    });

    expect(env).not.toHaveProperty("LUNA_USER_ID");
    expect(env).not.toHaveProperty("LUNA_IDENTITY_PROVIDER");
    expect(env).not.toHaveProperty("LUNA_IDENTITY_ID");
    expect(env).not.toHaveProperty("LUNA_IDENTITY_TENANT_KEY");
    expect(env).not.toHaveProperty("LUNA_IDENTITY_NAMESPACE");
    expect(env).not.toHaveProperty("LUNA_IDENTITY_KIND");
    expect(env).not.toHaveProperty("LUNA_IDENTITY_SCOPE");
  });
});

test("Runner service env rejects missing requester user instead of falling back to old tokens", () => {
  setEnv("LUNA_SERVICE_URL", "http://luna.test:9000/");
  setEnv("LUNA_ACCESS_TOKEN_SECRET", "runner-access-secret");

  withFreshDb(({ db }) => {
    expect(() =>
      buildLunaServiceRunnerEnv({
        runnerKind: "task",
        runnerContextId: "runner_context_task",
        sessionId: "session_1",
        taskId: "task_1",
        taskRunId: "task_run_1",
        db,
      })
    ).toThrow("requestedByUserId");
  });
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
  if (!previousEnv.has(key)) {
    previousEnv.set(key, Bun.env[key]);
  }
  Bun.env[key] = value;
  process.env[key] = value;
}

function withFreshDb<T>(
  fn: (input: {
    readonly db: DataConnection<typeof schema>["db"];
    readonly user: { readonly id: string; readonly displayName: string };
  }) => T,
): T {
  const home = mkdtempSync(join(tmpdir(), "luna-runner-service-env-"));
  mkdirSync(join(home, "data"), { recursive: true });
  setLunaHome(home);
  const connection = new DataConnection(schema);
  try {
    const user = new IdentityDirectory(connection.db).materializeIdentityClaims({
      kind: "human",
      displayName: "Runner User",
      claims: [
        {
          namespace: "local",
          kind: "local_id",
          value: "runner-user",
          scope: "",
          confidence: "manual",
        },
      ],
    });
    seedOwnedResources(connection.db,user.id);
    return fn({ db: connection.db, user });
  } finally {
    connection.close();
    rmSync(home, { recursive: true, force: true });
  }
}

async function withFreshDbAsync<T>(
  fn: (input: {
    readonly db: DataConnection<typeof schema>["db"];
    readonly user: { readonly id: string; readonly displayName: string };
  }) => Promise<T>,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "luna-runner-service-env-"));
  mkdirSync(join(home, "data"), { recursive: true });
  setLunaHome(home);
  const connection = new DataConnection(schema);
  try {
    const user = new IdentityDirectory(connection.db).materializeIdentityClaims({
      kind: "human",
      displayName: "Runner User",
      claims: [
        {
          namespace: "local",
          kind: "local_id",
          value: "runner-user-async",
          scope: "",
          confidence: "manual",
        },
      ],
    });
    seedOwnedResources(connection.db,user.id);
    return await fn({ db: connection.db, user });
  } finally {
    connection.close();
    rmSync(home, { recursive: true, force: true });
  }
}

function userMessagesInput(
  requesterUserId: string,
  context: Partial<Extract<MainRunnerInput, { type: "user_messages" }>["context"]> = {},
): MainRunnerInput {
  return {
    type: "user_messages",
    messages: [],
    latestMessage: {
      id: "om_1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "oc_1", kind: "group" },
      sender: {
        externalId: requesterUserId,
        kind: "user",
        displayName: "Sender",
        providerIds: {},
      },
      text: "@Luna diagnose",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
    },
    requesterUserId,
    context: {
      sessionId: "session_1",
      candidateOpenTasks: [],
      ...context,
    },
  };
}

function runnerContextRow(
  overrides: Partial<ResolvedRunnerContext> = {},
): ResolvedRunnerContext {
  return {
    agent_id: "fixture-agent", shadow_id: "fixture-shadow",
    id: "runner_context_main",
    owner_type: "session",
    owner_id: "session_1",
    runner_type: "codex",
    runner_session_id: null,
    instruction_fingerprint: null,
    runner_root_path: join(config.paths.home,"test-runner"),
    workspacePath: join(config.paths.home,"test-runner","workspace"),
    ipcPath: join(config.paths.home,"test-runner","ipc"),
    last_run_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

class CapturingRunner implements AgentRunner {
  readonly type = "capturing";
  options: AgentRunOptions | undefined;

  async *stream(
    _message: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    this.options = options;
    yield {
      id: "assistant_1",
      session_id: "runner_context_main",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "LUNA_NOTHING_TO_SEND",
        },
      ],
    };
  }
}

test("Main invocation capability expires after a silent turn", async () => {
  const { mainInvocations } = await import("../../src/runners/main-invocation-registry");
  setEnv("LUNA_ACCESS_TOKEN_SECRET", "runner-access-secret");
  await withFreshDbAsync(async ({ db, user }) => {
    let invocationId = "";
    const runner: AgentRunner = {
      type: "mock",
      async *stream() {
        invocationId = [...mainInvocations(db).keys()][0]!;
        expect(invocationId).toBeTruthy();
        yield { id: "result", session_id: "session_1", role: "assistant" as const, content: [{ type: "text" as const, text: "LUNA_NOTHING_TO_SEND" }] };
      },
    };
    const result = await new MainRunner({ runner, serviceAuthDb: db, accessTokenSigningSecret: "runner-access-secret" }).run({ runnerContext: fixtureRunnerContext(db,runnerContextRow()), input: userMessagesInput(user.id), turnId: "turn-1" });
    expect(result.status).toBe("completed");
    expect(mainInvocations(db).has(invocationId)).toBe(false);
  });
});

function seedOwnedResources(db:DataConnection<typeof schema>["db"],userId:string){
 const scope=fixtureNamedSession(db,"session_1",userId);
 db.insert(schema.tasks).values({id:"task_1",agent_id:scope.agentId,shadow_id:scope.shadowId,type:"test",title:"Test",status:"running",creator_user_id:userId,primary_session_id:"session_1",created_at:0,updated_at:0,last_activity_at:0}).run();
 for(const id of ["runner_context_main","runner_context_task"]){
  const owner_type=id==="runner_context_task" ? "task" : "session",owner_id=owner_type==="task" ? "task_1" : "session_1";
  db.insert(schema.runnerContexts).values(fixtureRunnerContext(db,runnerContextRow({id,owner_type,owner_id}))).run();
 }
 db.insert(schema.taskRuns).values({id:"task_run_1",task_id:"task_1",run_index:1,status:"running",reason:"test",input_snapshot:{},runner_type:"codex",runner_context_id:"runner_context_task",started_at:0}).run();
}
