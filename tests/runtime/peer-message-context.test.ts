import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { runSayCli } from "../../apps/cli/src/commands/say";
import type { NormalizedInboundMessage } from "../../src/channels";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { MainRunner } from "../../src/main-runner/main-runner";
import { sessionCommandsFor } from "../../src/messaging/session-command-service";
import { encodeInvocation } from "../../src/runners/invocation-codec";
import { InvocationStore } from "../../src/runners/invocation-store";
import { mainInvocations } from "../../src/runners/main-invocation-registry";
import { runnerMessageEnvelopeFromRow } from "../../src/runners/message-envelope";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import type { LunaAccessTokenClaims } from "../../src/server/auth/access-token-service";
import { createRunnerMessageRoutes } from "../../src/server/routes/runner-messages";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionResolver } from "../../src/sessions/session-resolver";
import { SessionStore } from "../../src/sessions/session-store";
import { setLunaHome } from "../../src/shared";
import { fixtureSessionOwnership, fixtureUser } from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";

let home: string;
let connection: DataConnection<typeof schema>;

afterEach(async () => {
  if (connection) {
    await sessionCommandsFor(connection.db, () => undefined).stop();
    connection.close();
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

function setupPeerFixture() {
  home = mkdtempSync(join(tmpdir(), "luna-peer-ctx-"));
  setLunaHome(home);
  connection = new DataConnection(schema);
  const db = connection.db;
  const scope = fixtureSessionOwnership(db, "feishu", "test");
  fixtureUser(db, scope.agent_id, "user");

  const reqInbound: NormalizedInboundMessage = {
    id: "ext-req-1",
    channel: { id: "test", type: "feishu" },
    surface: { externalId: "oc_req_group", kind: "group", displayName: "需求群：死链检测" },
    sender: { externalId: "user", kind: "user" },
    text: "推进需求",
    mentions: [],
    addressing: { addressedToBot: true, reason: "mention" },
  };
  const mrInbound: NormalizedInboundMessage = {
    id: "ext-mr-1",
    channel: { id: "test", type: "feishu" },
    surface: { externalId: "oc_mr_group", kind: "group", displayName: "[Feature] MR 8653100 讨论群" },
    sender: { externalId: "user", kind: "user" },
    text: "群聊创建成功",
    mentions: [],
    addressing: { addressedToBot: false, reason: "silent_group" },
  };
  const dir = new ChannelDirectoryStore(db);
  dir.upsertSurface({ channel: reqInbound.channel, surface: reqInbound.surface });
  dir.upsertSurface({ channel: mrInbound.channel, surface: mrInbound.surface });

  const resolver = new SessionResolver(new SessionStore(db));
  const reqSession = resolver.resolveFromNormalizedInbound(reqInbound);
  const mrSession = resolver.resolveFromNormalizedInbound(mrInbound);

  const row = new MessageStore(db).appendOnce({
    sessionId: reqSession.id,
    channelMessageKey: reqInbound.id,
    role: "user",
    senderUserId: "user",
    content: [{ type: "text", text: "推进需求" }],
    inbound: reqInbound,
    channel: reqInbound.channel,
    surface: reqInbound.surface,
    sender: reqInbound.sender,
  }).row;
  const context = new RunnerContextStore(db).resolveForSession(reqSession.id, "codex");
  const controller = new AbortController();
  const invStore = new InvocationStore(db);
  controller.signal.addEventListener("abort", () => invStore.revoke("invocation", "test cancelled"));
  mainInvocations(db).set("invocation", {
    invocationId: "invocation",
    turnId: "logical-turn",
    runnerContext: context,
    signal: controller.signal,
    input: {
      type: "user_messages",
      messages: [{ ...runnerMessageEnvelopeFromRow({ row, rawMessage: reqInbound }), rawMessage: reqInbound }],
      latestMessage: reqInbound,
      context: { sessionId: reqSession.id, candidateOpenTasks: [] },
    },
  });
  const claims: LunaAccessTokenClaims = {
    tokenId: "token",
    actorUserId: "user",
    source: "runner",
    role: "runner",
    runnerKind: "main",
    agentId: reqSession.agent_id,
    shadowId: reqSession.shadow_id,
    sessionId: reqSession.id,
    runnerJobId: context.id,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  db.insert(schema.accessTokens)
    .values({
      id: "token",
      agentId: claims.agentId,
      tokenHash: "hash",
      userId: "user",
      source: "runner",
      name: "test",
      role: "runner",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      createdAt: 1,
      metadataJson: { invocationId: "invocation" },
    })
    .run();
  registerTestRunnerJob(
    db,
    "invocation",
    claims,
    encodeInvocation("main", mainInvocations(db).get("invocation")!),
    "logical-turn",
  );

  const testChannel = {
    send: async (_inbound: unknown, operation: Record<string, unknown>) =>
      ({ ...operation, id: "out-1", channelId: "test" }) as never,
    createGroup: async () => ({ externalId: "oc_created", kind: "group" as const }),
    inviteGroupMembers: async () => ({
      acceptedMemberIds: [],
      invalidMemberIds: [],
      notExistedMemberIds: [],
      pendingApprovalMemberIds: [],
    }),
  };
  sessionCommandsFor(db, () => testChannel);

  const app = new Hono<{ Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims } }>();
  app.use("*", async (c, next) => {
    c.set("lunaAccessTokenClaims", claims);
    await next();
  });
  app.route("/api/runner", createRunnerMessageRoutes({ db, channelFor: () => testChannel }));

  const insertTask = (id: string, title: string, primarySessionId: string, status = "waiting") => {
    const now = Date.now();
    db.insert(schema.tasks)
      .values({
        id,
        agent_id: reqSession.agent_id,
        shadow_id: reqSession.shadow_id,
        type: "task",
        title,
        status,
        primary_session_id: primarySessionId,
        created_at: now,
        updated_at: now,
        last_activity_at: now,
      })
      .run();
  };

  return { db, app, reqSession, mrSession, insertTask };
}

test("say CLI rejects --task-id without --via-main", async () => {
  const res = await runSayCli(["--to", "session:s1", "--task-id", "task_1", "--text", "hi"], {});
  expect(res.status).toBe("error");
  if (res.status === "error") {
    expect(res.code).toBe("invalid_say_command");
    expect(res.message).toContain("--via-main");
  }
});

test("invokePeer attaches sourceSession and auto-attaches sole active relatedTask", async () => {
  const { db, app, reqSession, mrSession, insertTask } = setupPeerFixture();
  insertTask("task_primary_1", "死链检测客户端开发到合码", reqSession.id, "waiting");

  const res = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "k-auto" },
    body: JSON.stringify({
      to: `session:${mrSession.id}`,
      viaMain: true,
      content: [{ type: "text", text: "请在 MR 群提醒评审" }],
    }),
  });
  expect(res.status).toBe(202);
  const json = (await res.json()) as { commandId: string };
  const cmd = db.select().from(schema.sessionCommands).where(eq(schema.sessionCommands.id, json.commandId)).get();
  const payload = cmd?.payload as Record<string, unknown>;
  const peer = payload.peerMessage as Record<string, unknown>;
  expect(peer.sourceSession).toEqual({
    id: reqSession.id,
    kind: "main",
    title: "需求群：死链检测",
  });
  expect(peer.relatedTask).toEqual({
    id: "task_primary_1",
    title: "死链检测客户端开发到合码",
    status: "waiting",
    primarySessionId: reqSession.id,
  });
});

test("invokePeer omits relatedTask when multiple active tasks exist unless explicitly specified, and validates ownership", async () => {
  const { db, app, reqSession, mrSession, insertTask } = setupPeerFixture();
  insertTask("task_a", "任务 A", reqSession.id, "running");
  insertTask("task_b", "任务 B", reqSession.id, "waiting");
  insertTask("task_other", "MR 群里的任务", mrSession.id, "running");

  // 1) Multiple active tasks without relatedTaskId -> omits relatedTask
  const resAmbiguous = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "k-ambiguous" },
    body: JSON.stringify({
      to: `session:${mrSession.id}`,
      viaMain: true,
      content: [{ type: "text", text: "通知" }],
    }),
  });
  expect(resAmbiguous.status).toBe(202);
  const cmdAmbiguous = db
    .select()
    .from(schema.sessionCommands)
    .where(eq(schema.sessionCommands.id, ((await resAmbiguous.json()) as { commandId: string }).commandId))
    .get();
  const peerAmbiguous = (cmdAmbiguous?.payload as Record<string, unknown>).peerMessage as Record<string, unknown>;
  expect(peerAmbiguous.sourceSession).toEqual({
    id: reqSession.id,
    kind: "main",
    title: "需求群：死链检测",
  });
  expect(peerAmbiguous.relatedTask).toBeUndefined();

  // 2) Explicit relatedTaskId selects the specified task
  const resExplicit = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "k-explicit" },
    body: JSON.stringify({
      to: `session:${mrSession.id}`,
      viaMain: true,
      relatedTaskId: "task_b",
      content: [{ type: "text", text: "通知 B" }],
    }),
  });
  expect(resExplicit.status).toBe(202);
  const cmdExplicit = db
    .select()
    .from(schema.sessionCommands)
    .where(eq(schema.sessionCommands.id, ((await resExplicit.json()) as { commandId: string }).commandId))
    .get();
  const peerExplicit = (cmdExplicit?.payload as Record<string, unknown>).peerMessage as Record<string, unknown>;
  expect(peerExplicit.relatedTask).toEqual({
    id: "task_b",
    title: "任务 B",
    status: "waiting",
    primarySessionId: reqSession.id,
  });

  // 3) Rejects relatedTaskId belonging to another session
  const resForeign = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "k-foreign" },
    body: JSON.stringify({
      to: `session:${mrSession.id}`,
      viaMain: true,
      relatedTaskId: "task_other",
      content: [{ type: "text", text: "越权" }],
    }),
  });
  expect(resForeign.status).toBe(403);

  // 4) Rejects relatedTaskId without viaMain
  const resNoViaMain = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "k-no-via" },
    body: JSON.stringify({
      to: `session:${mrSession.id}`,
      relatedTaskId: "task_b",
      content: [{ type: "text", text: "直发" }],
    }),
  });
  expect(resNoViaMain.status).toBe(400);
});

test("MainRunner surfaces sourceSession and relatedTask inside peer_message <events>", async () => {
  const { db, app, reqSession, mrSession, insertTask } = setupPeerFixture();
  insertTask("task_primary_1", "死链检测客户端开发到合码", reqSession.id, "waiting");

  const res = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "k-e2e-main" },
    body: JSON.stringify({
      to: `session:${mrSession.id}`,
      viaMain: true,
      content: [{ type: "text", text: "请提醒评审" }],
    }),
  });
  expect(res.status).toBe(202);
  const { commandId } = (await res.json()) as { commandId: string };

  const mrContext = new RunnerContextStore(db).resolveForSession(mrSession.id, "codex");
  let capturedPrompt = "";
  const runner = new MainRunner({
    serviceAuthDb: db,
    accessTokenSigningSecret: "test-secret",
    runner: {
      runnerType: "codex",
      async *stream(userMessage: { content: string | Array<{ type: string; text?: string }> }) {
        capturedPrompt = Array.isArray(userMessage.content)
          ? userMessage.content.map(part => part.text ?? "").join("\n")
          : userMessage.content;
        yield {
          role: "assistant",
          final: true,
          content: [{ type: "text", text: "LUNA_NOTHING_TO_SEND" }],
        };
      },
    } as never,
  });

  await runner.run({
    runnerContext: mrContext,
    input: {
      type: "session_trigger",
      triggerId: commandId,
      sourceSessionId: reqSession.id,
      requesterUserId: "user",
      correlationId: commandId,
      artifactRefs: [],
      instruction: "请提醒评审",
      hops: 2,
      context: {
        sessionId: mrSession.id,
        candidateOpenTasks: [],
      },
    },
  });

  expect(capturedPrompt).toContain('"kind":"peer_message"');
  expect(capturedPrompt).toContain(
    `"sourceSession":{"id":"${reqSession.id}","kind":"main","title":"需求群：死链检测"}`,
  );
  expect(capturedPrompt).toContain(
    `"relatedTask":{"id":"task_primary_1","title":"死链检测客户端开发到合码","status":"waiting","primarySessionId":"${reqSession.id}"}`,
  );
});
