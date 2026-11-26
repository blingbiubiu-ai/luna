import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { runTasksCli } from "@luna/cli/commands/tasks";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { AgentStore } from "../../src/agents/agent-store";
import type { NormalizedInboundMessage } from "../../src/channels";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { TaskResultEventPublisher } from "../../src/main-runner/task-result-events";
import type { TaskResultForMainRunner } from "../../src/main-runner/types";
import { resolveLunaAddress } from "../../src/messaging/luna-address";
import { SessionReplyDispatcher } from "../../src/messaging/session-reply-dispatcher";
import { encodeInvocation } from "../../src/runners/invocation-codec";
import { runnerMessageEnvelopeFromRow } from "../../src/runners/message-envelope";
import { RunnerOperationService } from "../../src/runners/operation-service";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import type { LunaAccessTokenClaims } from "../../src/server/auth/access-token-service";
import { createRunnerOperationRoutes } from "../../src/server/routes/runner-operations";
import { createTasksRoutes } from "../../src/server/routes/tasks";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionStore } from "../../src/sessions/session-store";
import { setLunaHome } from "../../src/shared";
import { TaskRunNotificationService } from "../../src/tasks/task-run-notification-service";
import { TaskRunSupervisor } from "../../src/tasks/task-run-supervisor";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";

let home: string;
let connection: DataConnection<typeof schema>;

afterEach(async () => {
  connection?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

function createTransferFixture() {
  home = mkdtempSync(join(tmpdir(), "luna-task-transfer-"));
  setLunaHome(home);
  connection = new DataConnection(schema);
  const db = connection.db;
  const ownership = fixtureSessionOwnership(db, "feishu", "test");
  const ownerId = new AgentStore(db).ownerUserId(ownership.agent_id);

  const sessions = new SessionStore(db);
  const p2pSession = sessions.resolveByChannelSurface({
    channelType: "feishu",
    channelId: "test",
    groupId: "oc_p2p",
  });
  const groupSession = sessions.resolveByChannelSurface({
    channelType: "feishu",
    channelId: "test",
    groupId: "oc_demand_group",
  });

  const messages = new MessageStore(db);
  const p2pInbound: NormalizedInboundMessage = {
    id: "om_p2p_1",
    channel: { id: "test", type: "feishu" },
    surface: { externalId: "oc_p2p", kind: "p2p" },
    sender: {
      externalId: ownerId,
      kind: "user",
      requesterIdentity: {
        provider: "local",
        externalUserId: ownerId,
        canonicalUserId: ownerId,
      },
    },
    text: "Start delivery task",
    mentions: [],
    addressing: { addressedToBot: true, reason: "p2p" },
  };
  const groupInbound: NormalizedInboundMessage = {
    id: "om_group_1",
    channel: { id: "test", type: "feishu" },
    surface: { externalId: "oc_demand_group", kind: "group" },
    sender: p2pInbound.sender,
    text: "Demand group initialized",
    mentions: [],
    addressing: { addressedToBot: true, reason: "mention" },
  };

  const p2pMsg = messages.appendOnce({
    sessionId: p2pSession.id,
    channelMessageKey: p2pInbound.id,
    role: "user",
    senderUserId: ownerId,
    inbound: p2pInbound,
    channel: p2pInbound.channel,
    content: [{ type: "text", text: p2pInbound.text }],
  }).row;
  messages.appendOnce({
    sessionId: groupSession.id,
    channelMessageKey: groupInbound.id,
    role: "user",
    senderUserId: ownerId,
    inbound: groupInbound,
    channel: groupInbound.channel,
    content: [{ type: "text", text: groupInbound.text }],
  });

  const p2pContext = new RunnerContextStore(db).resolveForSession(p2pSession.id, "codex");
  const mainInput: Parameters<typeof encodeInvocation>[1] = {
    invocationId: "inv-p2p",
    turnId: "turn-p2p",
    runnerContext: p2pContext,
    input: {
      type: "user_messages",
      messages: [{ ...runnerMessageEnvelopeFromRow({ row: p2pMsg, rawMessage: p2pInbound }), rawMessage: p2pInbound }],
      latestMessage: p2pInbound,
      context: { sessionId: p2pSession.id, candidateOpenTasks: [] },
    },
  };
  const p2pClaims: LunaAccessTokenClaims = {
    agentId: p2pSession.agent_id,
    shadowId: p2pSession.shadow_id,
    tokenId: "tok-p2p",
    actorUserId: ownerId,
    source: "runner",
    role: "runner",
    runnerKind: "main",
    sessionId: p2pSession.id,
    runnerJobId: p2pContext.id,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  db.insert(schema.accessTokens)
    .values({
      id: "tok-p2p",
      agentId: p2pClaims.agentId,
      tokenHash: "hash-p2p",
      userId: ownerId,
      source: "runner",
      name: "main-p2p",
      role: "runner",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      createdAt: 1,
      metadataJson: { invocationId: "inv-p2p" },
    })
    .run();
  registerTestRunnerJob(db, "inv-p2p", p2pClaims, encodeInvocation("main", mainInput), "turn-p2p");

  let releaseRun!: () => void;
  const runHold = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const channel = new FakeFeishuChannel("test");
  const dispatcher = new SessionReplyDispatcher(db, () => channel);
  const cards = new TaskRunNotificationService({
    db,
    channelForNotification: () => dispatcher.channel("test"),
  });

  const deliveredResultSessions: string[] = [];
  const publisher = new TaskResultEventPublisher({
    db,
    runnerType: "mock",
    channelForSubscription: () => dispatcher.channel("test"),
    taskRunNotifications: cards,
    mainRunner: {
      run: async ({ input }) => {
        if (input.type === "task_result") {
          deliveredResultSessions.push(input.sessionId);
        }
        return { action: { type: "no_reply", reason: "verified" } } as never;
      },
    },
  });

  const supervisor = new TaskRunSupervisor({
    db,
    runnerType: "mock",
    executeRun: async ({ taskId }) => {
      await runHold;
      const now = Date.now();
      db.insert(schema.artifacts)
        .values({
          id: "art-final",
          task_id: taskId,
          type: "final_report",
          name: "report.md",
          content: "# Done",
          created_at: now,
        })
        .onConflictDoNothing()
        .run();
      return { finalReportArtifactId: "art-final" };
    },
    runNotifications: cards,
    onTaskResult: async (result: TaskResultForMainRunner) => {
      await publisher.publish(result);
    },
  });

  const service = new RunnerOperationService(db, supervisor, cards);
  return {
    db,
    p2pSession,
    groupSession,
    p2pClaims,
    channel,
    supervisor,
    service,
    releaseRun,
    deliveredResultSessions,
  };
}

test("live transfer moves primary session without restarting active run and keeps origin as silent on-demand watcher", async () => {
  const f = createTransferFixture();
  try {
    const created = await f.service.execute(f.p2pClaims, "task.create", "create-1", {
      title: "Meego 7401353950 dead-link check",
      summary: "Implement and merge",
      facts: ["Client only"],
      sendStatusCard: true,
    });
    const taskId = created.taskIds[0]!;
    const initialRunId = created.runId!;

    const transferred = await f.service.execute(f.p2pClaims, "task.transfer", "transfer-1", {
      taskId,
      to: `session:${f.groupSession.id}`,
    });
    expect(transferred.status).toBe("applied");
    expect(transferred.taskSessionId).toBe(f.groupSession.id);
    expect(transferred.previousSessionId).toBe(f.p2pSession.id);
    expect(transferred.runId).toBe(initialRunId);

    // Active run was NOT cancelled or restarted
    const runs = f.db.select().from(schema.taskRuns).where(eq(schema.taskRuns.task_id, taskId)).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");

    // `main` address from Task Runner now routes directly to the group session
    const mainAddr = resolveLunaAddress(
      f.db,
      { agentId: f.p2pSession.agent_id, shadowId: f.p2pSession.shadow_id, taskId },
      "main",
    );
    expect(mainAddr.sessionId).toBe(f.groupSession.id);

    // Origin P2P session can still list and inspect the Task by ID as a silent watcher
    const app = new Hono<{
      Variables: {
        dashboardAuthSession: unknown;
        lunaRequestAuthKind: string;
        lunaAccessTokenClaims: LunaAccessTokenClaims;
      };
    }>()
      .use("*", async (c, next) => {
        c.set("dashboardAuthSession", { authenticated: true, account: null });
        c.set("lunaRequestAuthKind", "luna-access-token");
        c.set("lunaAccessTokenClaims", f.p2pClaims);
        await next();
      })
      .route("/api/tasks", createTasksRoutes({ db: f.db }))
      .route("/api/runner", createRunnerOperationRoutes(f.service));

    const listRes = await app.request(`/api/tasks?sessionId=${f.p2pSession.id}`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(listBody).toEqual([
      expect.objectContaining({
        taskId,
        sessionRole: "watcher",
        notificationLevel: "none",
        primarySessionId: f.groupSession.id,
      }),
    ]);

    const getRes = await app.request(`/api/tasks/${taskId}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({
      taskId,
      status: "running",
      primarySessionId: f.groupSession.id,
    });

    // Finish the run: ONLY the new primary group session wakes up for `task_result`; P2P stays silent!
    f.releaseRun();
    await f.supervisor.waitForIdle();
    expect(f.deliveredResultSessions).toEqual([f.groupSession.id]);
  } finally {
    f.releaseRun();
    await f.supervisor.abortAndWait();
  }
});

test("CLI watch/unwatch and result_only watcher sync final result without intermediate status cards", async () => {
  const f = createTransferFixture();
  const originalFetch = globalThis.fetch;
  const app = new Hono<{
    Variables: {
      lunaAccessTokenClaims: LunaAccessTokenClaims;
    };
  }>()
    .use("*", async (c, next) => {
      c.set("lunaAccessTokenClaims", f.p2pClaims);
      await next();
    })
    .route("/api/runner", createRunnerOperationRoutes(f.service));

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;

  const cliEnv = {
    LUNA_SERVICE_URL: "http://luna.local",
    LUNA_ACCESS_TOKEN: "tok-p2p",
    LUNA_SESSION_ID: f.p2pSession.id,
    LUNA_AGENT_ID: f.p2pSession.agent_id,
    LUNA_ORIGIN_ID: "inv-p2p",
  };

  try {
    const created = await f.service.execute(f.p2pClaims, "task.create", "create-2", {
      title: "Group-owned task with result_only P2P watcher",
      summary: "Deliver result to both when requested",
      facts: [],
      sessionId: f.groupSession.id,
      sendStatusCard: true,
    });
    const taskId = created.taskIds[0]!;

    // Attach P2P as `result_only` watcher via CLI
    const watchRes = await runTasksCli(
      ["watch", "--task-id", taskId, "--to", "current", "--notify", "result_only"],
      cliEnv,
    );
    expect(watchRes.status).toBe("ok");

    // Only group session received a status card (result_only watcher gets zero cards)
    const createdCards = f.channel.outbound.filter(
      (msg) => msg.statusCard && msg.replyMode !== "update_status_card",
    );
    expect(createdCards.map((c) => c.sessionId)).toEqual([f.groupSession.id]);

    // Cannot unwatch the primary session
    const unwatchPrimary = await runTasksCli(
      ["unwatch", "--task-id", taskId, "--to", `session:${f.groupSession.id}`],
      cliEnv,
    );
    expect(unwatchPrimary.status).toBe("error");

    // Complete the run: BOTH groupSession (primary) and p2pSession (result_only watcher) receive task_result!
    f.releaseRun();
    await f.supervisor.waitForIdle();
    expect(f.deliveredResultSessions.sort()).toEqual(
      [f.groupSession.id, f.p2pSession.id].sort(),
    );

    // Detaching watcher afterwards succeeds cleanly
    const unwatchP2p = await runTasksCli(["unwatch", "--task-id", taskId], cliEnv);
    expect(unwatchP2p.status).toBe("ok");
  } finally {
    globalThis.fetch = originalFetch;
    f.releaseRun();
    await f.supervisor.abortAndWait();
  }
});
