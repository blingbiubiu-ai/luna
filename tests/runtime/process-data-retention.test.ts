import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  DataConnection,
  ProcessDataRetentionScheduler,
  pruneExpiredProcessData,
} from "../../src/data";
import * as schema from "../../src/data/schema";
import { PlatformSettingsStore } from "../../src/platform/platform-settings-store";
import { reloadConfig, setLunaHome } from "../../src/shared/config/index";
import { fixtureNamedSession } from "../helpers/platform-fixtures";

const tempHomes: string[] = [];

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

async function openTempConnection(): Promise<{
  home: string;
  conn: DataConnection<typeof schema>;
}> {
  const home = mkdtempSync(join(tmpdir(), "luna-retention-"));
  tempHomes.push(home);
  writeFileSync(join(home, "config.yaml"), "{}\n");
  setLunaHome(home);
  reloadConfig();
  const conn = new DataConnection(schema);
  return { home, conn };
}

describe("DataConnection PRAGMAs & Tool/Progress ProcessDataRetention", () => {
  test("DataConnection configures WAL performance PRAGMAs on open", async () => {
    const { home, conn } = await openTempConnection();
    try {
      const sqlite = (conn.db as unknown as { $client: Database }).$client;
      expect(sqlite.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 }); // NORMAL
      expect(sqlite.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
      expect(sqlite.query("PRAGMA cache_size").get()).toEqual({ cache_size: -131072 });
      expect(sqlite.query("PRAGMA temp_store").get()).toEqual({ temp_store: 2 }); // MEMORY
      expect(sqlite.query("PRAGMA journal_size_limit").get()).toEqual({
        journal_size_limit: 67108864,
      });
    } finally {
      conn.close();
      const raw = new Database(join(home, "data", "luna.db"));
      expect(raw.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      raw.close();
    }
  });

  test("pruneExpiredProcessData removes expired tool events and progress-card records while keeping public steps, active/waiting tasks, quarantined progress, and chat dispatches", async () => {
    const { conn } = await openTempConnection();
    try {
      const db = conn.db;
      const now = 1_800_000_000_000;
      const retentionMs = 30 * 86_400_000;
      const oldTs = now - 45 * 86_400_000;
      const recentTs = now - 2 * 86_400_000;

      const sessionId = "sess-retention-1";
      const scope = fixtureNamedSession(db, sessionId, "owner-ret");
      const agentId = scope.agentId;
      const shadowId = scope.shadowId;
      const userId = scope.ownerUserId;

      // Finished task vs waiting (suspended) task
      db.insert(schema.tasks)
        .values([
          {
            id: "task-finished",
            agent_id: agentId,
            shadow_id: shadowId,
            title: "Finished task",
            type: "task",
            status: "completed",
            creator_user_id: userId,
            primary_session_id: sessionId,
            created_at: oldTs,
            updated_at: oldTs,
            last_activity_at: oldTs,
          },
          {
            id: "task-waiting",
            agent_id: agentId,
            shadow_id: shadowId,
            title: "Waiting multi-stage task",
            type: "task",
            status: "waiting",
            creator_user_id: userId,
            primary_session_id: sessionId,
            created_at: oldTs,
            updated_at: oldTs,
            last_activity_at: oldTs,
          },
        ])
        .run();

      db.insert(schema.taskRuns)
        .values([
          {
            id: "trun-finished",
            task_id: "task-finished",
            run_index: 1,
            status: "completed",
            reason: "initial",
            input_snapshot: { instruction: "done" },
            materialized_prompt: "KEEP PROMPT UNTOUCHED",
            runner_type: "codex",
            started_at: oldTs,
            finished_at: oldTs,
          },
          {
            id: "trun-waiting",
            task_id: "task-waiting",
            run_index: 1,
            status: "waiting",
            reason: "initial",
            input_snapshot: { instruction: "wait" },
            runner_type: "codex",
            started_at: oldTs,
          },
        ])
        .run();

      db.insert(schema.taskRunNotifications)
        .values({
          id: "trn-waiting",
          task_id: "task-waiting",
          task_run_id: "trun-waiting",
          run_index: 1,
          subscription_id: "sub-waiting",
          session_id: sessionId,
          channel_type: "feishu",
          channel_id: "feishu-1",
          status_card_style: "native",
          status_message_id: "om-waiting-card",
          state: "active",
          created_at: oldTs,
          updated_at: oldTs,
        })
        .run();

      // 1. timeline_events:
      // - `te-tool-old` on finished task -> PRUNED
      // - `te-tool-recent` on finished task -> KEPT
      // - `te-tool-artifact` linked to artifact -> KEPT
      // - `te-tool-waiting` on waiting task -> KEPT
      // - `te-step-old` (`runner.step` public text) -> KEPT
      db.insert(schema.timelineEvents)
        .values([
          {
            id: "te-tool-old",
            task_id: "task-finished",
            task_run_id: "trun-finished",
            type: "runner.tool",
            summary: "Read large file",
            data: { status: "ended" },
            visibility: "internal",
            created_at: oldTs,
            updated_at: oldTs,
          },
          {
            id: "te-tool-recent",
            task_id: "task-finished",
            task_run_id: "trun-finished",
            type: "runner.tool",
            summary: "Recent tool",
            data: { status: "ended" },
            visibility: "internal",
            created_at: recentTs,
            updated_at: recentTs,
          },
          {
            id: "te-tool-artifact",
            task_id: "task-finished",
            task_run_id: "trun-finished",
            type: "runner.tool",
            summary: "Generated report",
            data: { status: "ended" },
            visibility: "internal",
            created_at: oldTs,
            updated_at: oldTs,
          },
          {
            id: "te-tool-waiting",
            task_id: "task-waiting",
            task_run_id: "trun-waiting",
            type: "runner.tool",
            summary: "Tool on waiting task",
            data: { status: "ended" },
            visibility: "internal",
            created_at: oldTs,
            updated_at: oldTs,
          },
          {
            id: "te-step-old",
            task_id: "task-finished",
            task_run_id: "trun-finished",
            type: "runner.step",
            summary: "Public milestone",
            data: { publicProgress: true, text: "Step summary" },
            visibility: "public",
            created_at: oldTs,
            updated_at: oldTs,
          },
        ])
        .run();
      db.insert(schema.artifacts)
        .values({
          id: "art-1",
          task_id: "task-finished",
          timeline_event_id: "te-tool-artifact",
          type: "report",
          name: "report.md",
          status: "active",
          created_at: oldTs,
        })
        .run();

      // 2. notification_attempts:
      // - `na-progress-old` (`update_status_card_progress`, sent, finished task) -> PRUNED
      // - `na-create-old` (`create_status_card`) -> KEPT
      // - `na-result-old` (`publish_task_result`) -> KEPT
      // - `na-progress-waiting` (on waiting task) -> KEPT
      db.insert(schema.notificationAttempts)
        .values([
          {
            id: "na-progress-old",
            idempotency_key: "ik-prog-old",
            task_id: "task-finished",
            subscription_id: "sub-1",
            message_id: "u-1",
            action: "update_status_card_progress",
            status: "sent",
            created_at: oldTs,
            updated_at: oldTs,
          },
          {
            id: "na-create-old",
            idempotency_key: "ik-create-old",
            task_id: "task-finished",
            subscription_id: "sub-1",
            message_id: "m-create",
            action: "create_status_card",
            status: "sent",
            created_at: oldTs,
            updated_at: oldTs,
          },
          {
            id: "na-result-old",
            idempotency_key: "ik-result-old",
            task_id: "task-finished",
            subscription_id: "sub-1",
            message_id: "m-result",
            action: "publish_task_result",
            status: "sent",
            created_at: oldTs,
            updated_at: oldTs,
          },
          {
            id: "na-progress-waiting",
            idempotency_key: "ik-prog-wait",
            task_id: "task-waiting",
            subscription_id: "sub-waiting",
            message_id: "u-2",
            action: "update_status_card_progress",
            status: "sent",
            created_at: oldTs,
            updated_at: oldTs,
          },
        ])
        .run();

      // 3. native_progress_deliveries:
      // - `np-settled-old` -> PRUNED
      // - `np-quarantined` (`pending: "append"`) -> KEPT
      // - `np-waiting-task` (bound to waiting task's status_message_id) -> KEPT
      db.insert(schema.nativeProgressDeliveries)
        .values([
          {
            id: "np-settled-old",
            channelId: "feishu-1",
            messageId: "om-finished-card",
            state: { sentEntries: ["t1", "t2"], terminal: true },
            updatedAt: oldTs,
          },
          {
            id: "np-quarantined",
            channelId: "feishu-1",
            messageId: "om-quarantined",
            state: { sentEntries: ["t1"], pending: "append" },
            updatedAt: oldTs,
          },
          {
            id: "np-waiting-task",
            channelId: "feishu-1",
            messageId: "om-waiting-card",
            state: { sentEntries: ["t1"] },
            updatedAt: oldTs,
          },
        ])
        .run();

      // 4. session_reply_dispatches & session_channel_deliveries:
      // - `disp-status-old` (`replyMode: "update_status_card"`, sent) -> PRUNED
      // - `disp-status-waiting` (backing `om-waiting-card` on waiting task) -> KEPT
      // - `disp-chat-old` (ordinary chat reply without statusCard/progressSnapshot) -> KEPT
      const dummyInbound = {
        id: "in-1",
        channel: { type: "feishu", id: "feishu-1" },
        surface: { externalId: "oc_1", kind: "group" },
        sender: { kind: "human", externalId: "u1" },
        text: "hi",
        mentions: [],
        addressing: { addressedToBot: true, reason: "mention" },
      } as never;
      db.insert(schema.sessionReplyDispatches)
        .values([
          {
            id: "disp-status-old",
            sessionId,
            idempotencyKey: "idem-status-old",
            signature: "sha256:1",
            receipt: {
              id: "om-finished-card",
              channelId: "feishu-1",
              content: "",
              replyMode: "update_status_card",
              targetMessageId: "om-finished-card",
              progressSnapshot: true,
            } as never,
            createdAt: oldTs,
          },
          {
            id: "disp-status-waiting",
            sessionId,
            idempotencyKey: "idem-status-waiting",
            signature: "sha256:2",
            receipt: {
              id: "disp-status-waiting",
              channelId: "feishu-1",
              content: "",
              statusCard: { taskId: "task-waiting", title: "Waiting", status: "waiting" },
            } as never,
            createdAt: oldTs,
          },
          {
            id: "disp-chat-old",
            sessionId,
            idempotencyKey: "idem-chat-old",
            signature: "sha256:3",
            receipt: {
              id: "disp-chat-old",
              channelId: "feishu-1",
              content: "Normal assistant answer",
              replyMode: "reply_in_thread",
            } as never,
            createdAt: oldTs,
          },
        ])
        .run();
      db.insert(schema.sessionChannelDeliveries)
        .values([
          {
            id: "deliv-status-old",
            dispatchId: "disp-status-old",
            bindingId: "bind-1",
            channelId: "feishu-1",
            inbound: dummyInbound,
            operation: { content: "", replyMode: "update_status_card" } as never,
            receipt: { id: "om-finished-card", channelId: "feishu-1", content: "" } as never,
            status: "sent",
            updatedAt: oldTs,
          },
          {
            id: "deliv-status-waiting",
            dispatchId: "disp-status-waiting",
            bindingId: "bind-1",
            channelId: "feishu-1",
            inbound: dummyInbound,
            operation: { content: "" } as never,
            receipt: { id: "om-waiting-card", channelId: "feishu-1", content: "" } as never,
            status: "sent",
            updatedAt: oldTs,
          },
          {
            id: "deliv-chat-old",
            dispatchId: "disp-chat-old",
            bindingId: "bind-1",
            channelId: "feishu-1",
            inbound: dummyInbound,
            operation: { content: "Normal assistant answer" } as never,
            receipt: { id: "om-chat-1", channelId: "feishu-1", content: "Normal assistant answer" } as never,
            status: "sent",
            updatedAt: oldTs,
          },
        ])
        .run();

      const stats = pruneExpiredProcessData(db, { now, retentionMs });

      expect(stats).toEqual({
        toolTimelineEvents: 1,
        progressNotificationAttempts: 1,
        nativeProgressDeliveries: 1,
        progressReplyDeliveries: 1,
        progressReplyDispatches: 1,
        totalAffected: 5,
      });

      // Task prompts remain untouched
      expect(
        db
          .select()
          .from(schema.taskRuns)
          .all()
          .find((r) => r.id === "trun-finished")?.materialized_prompt,
      ).toBe("KEEP PROMPT UNTOUCHED");

      // Remaining timeline events include the deterministic `timeline.tools_pruned` marker
      const remainingTimeline = db.select().from(schema.timelineEvents).all();
      expect(remainingTimeline.map((e) => e.id).sort()).toEqual([
        "retention-pruned:task-finished:trun-finished",
        "te-step-old",
        "te-tool-artifact",
        "te-tool-recent",
        "te-tool-waiting",
      ]);
      const marker = remainingTimeline.find(
        (e) => e.id === "retention-pruned:task-finished:trun-finished",
      )!;
      expect(marker.type).toBe("timeline.tools_pruned");
      expect(marker.data).toMatchObject({
        prunedToolCount: 1,
        taskRunId: "trun-finished",
        runIndex: 1,
      });

      // When `te-tool-recent` also ages out later, its count accumulates into the same marker row
      const secondStats = pruneExpiredProcessData(db, {
        now: now + 35 * 86_400_000,
        retentionMs,
      });
      expect(secondStats.toolTimelineEvents).toBe(1);
      const updatedMarker = db
        .select()
        .from(schema.timelineEvents)
        .all()
        .find((e) => e.id === "retention-pruned:task-finished:trun-finished")!;
      expect(updatedMarker.data).toMatchObject({
        prunedToolCount: 2,
        taskRunId: "trun-finished",
        runIndex: 1,
      });

      // Remaining notification attempts
      expect(
        db
          .select()
          .from(schema.notificationAttempts)
          .all()
          .map((a) => a.id)
          .sort(),
      ).toEqual(["na-create-old", "na-progress-waiting", "na-result-old"]);

      // Remaining native progress rows
      expect(
        db
          .select()
          .from(schema.nativeProgressDeliveries)
          .all()
          .map((n) => n.id)
          .sort(),
      ).toEqual(["np-quarantined", "np-waiting-task"]);

      // Remaining reply dispatches (waiting status card + ordinary chat reply survive)
      expect(
        db
          .select()
          .from(schema.sessionReplyDispatches)
          .all()
          .map((d) => d.id)
          .sort(),
      ).toEqual(["disp-chat-old", "disp-status-waiting"]);
    } finally {
      conn.close();
    }
  });

  test("ProcessDataRetentionScheduler respects live PlatformSettingsStore toggle and interval", async () => {
    const { conn } = await openTempConnection();
    try {
      const db = conn.db;
      const settingsStore = new PlatformSettingsStore(db);
      let clock = 1_800_000_000_000;
      const oldTs = clock - 10 * 86_400_000;

      settingsStore.patch({ retention: { enabled: false, retentionDays: 7, intervalMinutes: 30 } });
      db.insert(schema.nativeProgressDeliveries)
        .values({
          id: "np-live",
          channelId: "ch-1",
          messageId: "m-1",
          state: { sentEntries: [], terminal: true },
          updatedAt: oldTs,
        })
        .run();

      const scheduler = new ProcessDataRetentionScheduler({
        db,
        now: () => clock,
        setInterval: (() => ({ unref: () => {} })) as unknown as typeof setInterval,
        clearInterval: (() => {}) as typeof clearInterval,
      });
      scheduler.start();
      expect(db.select().from(schema.nativeProgressDeliveries).all()).toHaveLength(1);

      settingsStore.patch({ retention: { enabled: true, retentionDays: 7, intervalMinutes: 30 } });
      const firstRun = scheduler.tick("scheduled");
      expect(firstRun?.nativeProgressDeliveries).toBe(1);
      expect(db.select().from(schema.nativeProgressDeliveries).all()).toHaveLength(0);

      clock += 5 * 60_000;
      expect(scheduler.tick("scheduled")).toBeUndefined();

      clock += 30 * 60_000;
      expect(scheduler.tick("scheduled")?.totalAffected).toBe(0);
      scheduler.stop();
    } finally {
      conn.close();
    }
  });
});
