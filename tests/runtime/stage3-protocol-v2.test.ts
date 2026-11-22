import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { runClientCli } from "@luna/cli/main";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { SELF_ROUTINE_ORIGINS } from "@/agents/self-routines";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import { finalizeRunnerReply } from "@/messaging/runner-answer";
import { sessionCommandsFor } from "@/messaging/session-command-service";
import { MessageStore } from "@/sessions/message-store";
import { SessionResolver } from "@/sessions/session-resolver";
import { SessionStore } from "@/sessions/session-store";
import { renderMainRunnerPrompt } from "@/main-runner/main-runner";
import {
  buildMainCapabilities,
  isMainSelfRoutineInput,
  RUNNER_PROTOCOL_VERSION,
} from "@/runners/capabilities";
import { encodeInvocation } from "@/runners/invocation-codec";
import { InvocationStore } from "@/runners/invocation-store";
import { mainInvocations } from "@/runners/main-invocation-registry";
import { runnerMessageEnvelopeFromRow } from "@/runners/message-envelope";
import { RunnerOperationService } from "@/runners/operation-service";
import { RunnerContextStore } from "@/runners/runner-context-store";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { createRunnerGroupRoutes } from "@/server/routes/runner-groups";
import { createRunnerMessageRoutes } from "@/server/routes/runner-messages";
import { createRunnerOperationRoutes } from "@/server/routes/runner-operations";
import { createRunnerProactivityRoutes } from "@/server/routes/runner-proactivity";
import { createRunnerProtocolV2Routes } from "@/server/routes/runner-protocol-v2";
import { createRunnerRequestRoutes } from "@/server/routes/runner-requests";
import { createSessionsRoutes } from "@/server/routes/sessions";
import { createTaskReportRoutes } from "@/server/routes/task-reports";
import { createTasksRoutes } from "@/server/routes/tasks";
import { TaskReportService } from "@/tasks/task-report-service";
import type { NormalizedInboundMessage } from "@/channels";
import {
  fixtureSessionOwnership,
  fixtureUser,
} from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";

let home: string;
let connection: DataConnection<typeof schema>;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-stage3-v2-"));
  setLunaHome(home);
  connection = new DataConnection(schema);
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  if (connection) {
    await sessionCommandsFor(connection.db, () => undefined).stop();
    connection.close();
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

function setupGroupInvocation() {
  const db = connection.db;
  const ownership = fixtureSessionOwnership(db, "feishu", "ch-v2");
  fixtureUser(db, ownership.agent_id, "colleague");
  const inbound: NormalizedInboundMessage = {
    id: "om_group_1",
    channel: { id: "ch-v2", type: "feishu" },
    surface: { externalId: "oc_group_v2", kind: "group" },
    sender: { externalId: "colleague", kind: "user" },
    text: "请帮我开话题排查这个问题",
    mentions: [],
    addressing: { addressedToBot: true, reason: "mention" },
  };
  new ChannelDirectoryStore(db).upsertSurface({
    channel: inbound.channel,
    surface: inbound.surface,
  });
  const session = new SessionResolver(
    new SessionStore(db),
  ).resolveFromNormalizedInbound(inbound);
  const msgRow = new MessageStore(db).appendOnce({
    sessionId: session.id,
    channelMessageKey: inbound.id,
    role: "user",
    senderUserId: "colleague",
    content: [{ type: "text", text: inbound.text }],
    inbound,
    channel: inbound.channel,
    surface: inbound.surface,
    sender: inbound.sender,
  }).row;

  const context = new RunnerContextStore(db).resolveForSession(
    session.id,
    "codex",
  );
  const invocationId = "inv-v2-main";
  const controller = new AbortController();
  const invStore = new InvocationStore(db);
  controller.signal.addEventListener("abort", () =>
    invStore.revoke(invocationId, "cancelled"),
  );
  const mainInput = {
    type: "user_messages" as const,
    messages: [
      {
        ...runnerMessageEnvelopeFromRow({ row: msgRow, rawMessage: inbound }),
        rawMessage: inbound,
      },
    ],
    latestMessage: inbound,
    context: { sessionId: session.id, candidateOpenTasks: [] },
  };
  mainInvocations(db).set(invocationId, {
    invocationId,
    turnId: "turn-v2-1",
    runnerContext: context,
    signal: controller.signal,
    input: mainInput,
  });

  const claims: LunaAccessTokenClaims = {
    tokenId: "tok-v2-main",
    actorUserId: "colleague",
    source: "runner",
    role: "runner",
    runnerKind: "main",
    agentId: session.agent_id,
    shadowId: session.shadow_id,
    sessionId: session.id,
    runnerJobId: context.id,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  db.insert(schema.accessTokens)
    .values({
      id: claims.tokenId,
      agentId: claims.agentId,
      tokenHash: "hash-v2-main",
      userId: "colleague",
      source: "runner",
      name: "v2-test",
      role: "runner",
      issuedAt: 1,
      expiresAt: claims.expiresAt,
      createdAt: 1,
      metadataJson: { invocationId },
    })
    .run();
  const snapshot = encodeInvocation(
    "main",
    mainInvocations(db).get(invocationId)!,
  );
  registerTestRunnerJob(db, invocationId, claims, snapshot, "turn-v2-1");

  let sentCount = 0;
  const channelFor = () => ({
    send: async (_in: unknown, op: Record<string, unknown>) => {
      sentCount++;
      return { ...op, id: `out-${sentCount}`, channelId: "ch-v2" } as never;
    },
  });
  sessionCommandsFor(db, channelFor).start();

  const ops = new RunnerOperationService(db, {
    startInitialRun: () => ({ id: "run-v2-1" } as never),
    restartTaskRun: () => ({ id: "run-v2-2" } as never),
    cancelTaskRun: () => undefined,
  });
  const reports = new TaskReportService(db, async () => {});

  const app = new Hono<{
    Variables: {
      lunaAccessTokenClaims: LunaAccessTokenClaims;
      lunaRequestAuthKind: string;
      dashboardAuthSession: unknown;
    };
  }>()
    .use("*", async (c, next) => {
      c.set("lunaAccessTokenClaims", claims);
      c.set("lunaRequestAuthKind", "luna-access-token");
      c.set("dashboardAuthSession", { authenticated: true, account: null });
      await next();
    })
    .route("/api/runner", createRunnerProtocolV2Routes({ db, channelFor }))
    .route("/api/runner", createRunnerMessageRoutes({ db, channelFor }))
    .route("/api/runner", createRunnerProactivityRoutes({ db, channelFor }))
    .route("/api/runner", createRunnerRequestRoutes({ db, channelFor }))
    .route("/api/runner", createRunnerGroupRoutes({ db, channelFor }))
    .route("/api/runner", createRunnerOperationRoutes(ops))
    .route("/api/runner/task-reports", createTaskReportRoutes(reports))
    .route("/api/sessions", createSessionsRoutes({ db }))
    .route("/api/tasks", createTasksRoutes({ db }));

  return {
    db,
    app,
    session,
    msgRow,
    mainInput,
    invocationId,
    claims,
    sentCount: () => sentCount,
  };
}

test("Protocol v2 renders <capabilities> and <events> envelopes and suppresses legacy v1 tags", () => {
  const f = setupGroupInvocation();
  const capabilities = buildMainCapabilities(f.db, f.mainInput, {
    agentId: f.session.agent_id,
    shadowId: f.session.shadow_id,
    actorUserId: "colleague",
  });
  expect(capabilities.protocolVersion).toBe(RUNNER_PROTOCOL_VERSION);
  expect(capabilities.turn.originKind).toBe("user_messages");
  expect(capabilities.turn.terminalOutputMode).toBe("reply_current_session");
  expect(capabilities.turn.allowSilent).toBe(true);

  const prompt = renderMainRunnerPrompt(f.mainInput, {
    db: f.db,
    capabilities,
    timezone: "Asia/Shanghai",
  });
  expect(prompt).toContain("<capabilities>");
  expect(prompt).toContain("<events>");
  expect(prompt).toContain("<now>");
  expect(prompt).not.toContain("<messages>");
  expect(prompt).not.toContain("<trigger>");
  expect(prompt).not.toContain("<task_result>");

  // Self-routine turns switch terminalOutputMode to "ignored" and isMainSelfRoutineInput returns true.
  const heartbeatTriggerId = "hb-cmd-1";
  f.db
    .insert(schema.sessionCommands)
    .values({
      id: heartbeatTriggerId,
      kind: "session.invoke",
      sessionId: f.session.id,
      sourceSessionId: f.session.id,
      actorUserId: "colleague",
      originId: `${SELF_ROUTINE_ORIGINS.heartbeat}${f.session.shadow_id}:1`,
      dedupeKey: "hb-1",
      payload: { content: "heartbeat check" },
      status: "running",
      correlationId: heartbeatTriggerId,
      hops: 2,
      availableAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const hbInput = {
    type: "session_trigger" as const,
    triggerId: heartbeatTriggerId,
    instruction: "heartbeat check",
    correlationId: heartbeatTriggerId,
    hops: 2,
    sourceSessionId: f.session.id,
    requesterUserId: "colleague",
    artifactRefs: [],
    context: { sessionId: f.session.id, candidateOpenTasks: [] },
  };
  expect(isMainSelfRoutineInput(f.db, hbInput)).toBe(true);
  const hbCaps = buildMainCapabilities(f.db, hbInput, {
    agentId: f.session.agent_id,
    shadowId: f.session.shadow_id,
  });
  expect(hbCaps.identity.routineKind).toBe("heartbeat");
  expect(hbCaps.turn.terminalOutputMode).toBe("ignored");
  expect(hbCaps.addressScope.allowCurrent).toBe(false);
});

test("Protocol v2 rejects x-luna-protocol-version < 2 with HTTP 426 and serves /api/runner/whoami", async () => {
  const f = setupGroupInvocation();
  const v1Res = await f.app.request("/api/runner/whoami", {
    headers: { "x-luna-protocol-version": "1" },
  });
  expect(v1Res.status).toBe(426);
  expect(await v1Res.json()).toMatchObject({
    error: "protocol_version_unsupported",
  });

  const v2Res = await f.app.request("/api/runner/whoami", {
    headers: { "x-luna-protocol-version": "2" },
  });
  expect(v2Res.status).toBe(200);
  const body = (await v2Res.json()) as {
    capabilities: { protocolVersion: number; commands: string[] };
  };
  expect(body.capabilities.protocolVersion).toBe(2);
  expect(body.capabilities.commands).toContain("say");
});

test("CLI Protocol v2 derives idempotency, rejects v1 flags/commands, queries unified commands ledger, and enforces atomic create-thread --handoff silence", async () => {
  const f = setupGroupInvocation();
  const otherSession = new SessionStore(f.db).createLocalSession("colleague", {
    agentId: f.session.agent_id,
    shadowId: f.session.shadow_id,
  });
  server = Bun.serve({
    port: 0,
    fetch: req => f.app.fetch(req),
  });
  const env = {
    LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`,
    LUNA_ACCESS_TOKEN: "test-token",
    LUNA_INVOCATION_ID: f.invocationId,
    LUNA_SESSION_ID: f.session.id,
    LUNA_AGENT_ID: f.session.agent_id,
  };

  // Legacy v1 commands and --request-id are rejected cleanly.
  expect((await runClientCli(["messages", "send", "--text", "hi"], env)).status).toBe("error");
  expect((await runClientCli(["task", "list"], env)).status).toBe("error");
  expect((await runClientCli(["session", "messages"], env)).status).toBe("error");
  expect((await runClientCli(["say", "--text", "hi", "--request-id", "old"], env)).status).toBe("error");

  // `luna whoami`
  const whoami = await runClientCli(["whoami"], env);
  expect(whoami.status).toBe("ok");
  expect(JSON.parse(whoami.output!).capabilities.protocolVersion).toBe(2);

  // `luna say` derives deterministic idempotency: identical call deduplicates; `--repeat` sends again.
  const say1 = await runClientCli(["say", "--text", "进度更新"], env);
  expect(say1.status).toBe("ok");
  const say1Json = JSON.parse(say1.output!) as { commandId: string; status: string };
  expect(say1Json.status).toBe("sent");
  const sayDup = await runClientCli(["say", "--text", "进度更新"], env);
  expect(JSON.parse(sayDup.output!).commandId).toBe(say1Json.commandId);
  expect(f.sentCount()).toBe(1);

  const sayRepeat = await runClientCli(["say", "--text", "进度更新", "--repeat"], env);
  expect(sayRepeat.status).toBe("ok");
  expect(JSON.parse(sayRepeat.output!).commandId).not.toBe(say1Json.commandId);
  expect(f.sentCount()).toBe(2);

  // Unified `luna commands status` & `wait` inspect ledgers.
  const cmdStatus = await runClientCli(["commands", "status", say1Json.commandId], env);
  expect(cmdStatus.status).toBe("ok");
  expect(JSON.parse(cmdStatus.output!)).toMatchObject({
    commandId: say1Json.commandId,
    kind: "message.send",
    status: "sent",
  });

  // `luna asks create` + `luna commands status <requestId>`
  const askRes = await runClientCli(
    [
      "asks",
      "create",
      "--to",
      `session:${otherSession.id}`,
      "--question",
      "是否继续？",
      "--options",
      '["继续","暂停"]',
    ],
    env,
  );
  expect(askRes.status).toBe("ok");
  const askJson = JSON.parse(askRes.output!) as { requestId: string; commandId: string };
  const askCmdStatus = await runClientCli(["commands", "status", askJson.requestId], env);
  expect(askCmdStatus.status).toBe("ok");
  expect(JSON.parse(askCmdStatus.output!)).toMatchObject({
    commandId: askJson.requestId,
    kind: "ask",
    status: "pending",
  });

  // Atomic `luna sessions create-thread --handoff` creates topic, queues handoff, and suppresses source duplicate reply!
  const threadRes = await runClientCli(
    [
      "sessions",
      "create-thread",
      "--title",
      "异常排查",
      "--handoff",
      "排查刚才群里反馈的卡顿问题",
    ],
    env,
  );
  expect(threadRes.status).toBe("ok");
  const threadJson = JSON.parse(threadRes.output!) as {
    commandId: string;
    targetSessionId: string;
    handoffCommandId: string;
    handoffRequestId: string;
  };
  expect(threadJson.targetSessionId).toBeTruthy();
  expect(threadJson.handoffCommandId).toBeTruthy();
  expect(threadJson.handoffRequestId).toMatch(/^req_/);

  const opLedger = await runClientCli(["commands", "status", threadJson.commandId], env);
  expect(JSON.parse(opLedger.output!)).toMatchObject({
    commandId: threadJson.commandId,
    kind: "session.create_thread",
    status: "applied",
  });

  // Protocol v2 invariant (3.6): source turn terminal text is suppressed automatically!
  const settlement = finalizeRunnerReply(f.db, {
    sessionId: f.session.id,
    originId: "turn-v2-1",
    invocationId: f.invocationId,
    text: "已为您创建话题跟进",
    allowSilent: true,
    actorUserId: "colleague",
  });
  expect(settlement).toEqual({
    kind: "thread_handoff",
    commandId: threadJson.handoffCommandId,
  });
});
