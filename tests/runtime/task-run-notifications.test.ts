import { fixtureSessionOwnership, fixtureTaskOwnership } from "../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { config, setLunaHome } from "../../src/shared";
import { TaskRunNotificationStore } from "../../src/tasks/task-run-notification-store";
import { TaskSubscriptionStore } from "../../src/tasks/task-subscription-store";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-task-run-notifications-test-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  for (const suffix of ["service-create", "terminal-update", "progress-update", "retry-create"]) {
    seedSession(`session-${suffix}`, `chat-${suffix}`);
  }
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

function seedSession(id: string, channelId: string) {
  database.db.insert(lunaSchema.sessions).values({
    id, channel_type: "feishu", channel_id: channelId, created_at: 1, updated_at: 1,
    ...fixtureSessionOwnership(database.db, "feishu", channelId),
  }).run();
}

describe("TaskRunNotificationStore", () => {
  test("resolves one notification row per task run and subscription", () => {
    const store = new TaskRunNotificationStore(database.db);
    const first = store.resolveForRunSubscription({
      taskId: "task-alpha",
      taskRunId: "task_run_alpha_1",
      runIndex: 1,
      subscriptionId: "subscription-alpha",
      sessionId: "session-alpha",
      channelType: "feishu",
      channelId: "chat-alpha",
      groupId: "group-alpha",
      threadKey: "thread-alpha",
      rootMessageKey: "root-alpha",
      surfaceKey: "feishu:chat-alpha:group-alpha",
    });
    const second = store.resolveForRunSubscription({
      taskId: "task-alpha",
      taskRunId: "task_run_alpha_1",
      runIndex: 1,
      subscriptionId: "subscription-alpha",
      sessionId: "session-alpha",
      channelType: "feishu",
      channelId: "chat-alpha",
      groupId: "group-alpha",
      threadKey: "thread-alpha",
      rootMessageKey: "root-alpha",
      surfaceKey: "feishu:chat-alpha:group-alpha",
    });

    expect(second.id).toBe(first.id);
    expect(store.listForRun("task_run_alpha_1")).toEqual([first]);
  });

  test("tracks provider message id within channel scope", () => {
    const store = new TaskRunNotificationStore(database.db);
    const row = store.resolveForRunSubscription({
      taskId: "task-beta",
      taskRunId: "task_run_beta_1",
      runIndex: 1,
      subscriptionId: "subscription-beta",
      sessionId: "session-beta",
      channelType: "feishu",
      channelId: "chat-beta",
      groupId: null,
      threadKey: null,
      rootMessageKey: "root-beta",
      surfaceKey: "feishu:chat-beta",
    });

    const withMessage = store.setStatusMessageId(row.id, "om_status_beta");

    expect(withMessage.statusMessageId).toBe("om_status_beta");
    expect(
      store.findByStatusMessage({
        channelType: "feishu",
        channelId: "chat-beta",
        statusMessageId: "om_status_beta",
      })?.id,
    ).toBe(row.id);
    expect(
      store.findByStatusMessage({
        channelType: "feishu",
        channelId: "other-chat",
        statusMessageId: "om_status_beta",
      }),
    ).toBeUndefined();
  });

  test("marks notifications terminal without changing message identity", () => {
    const store = new TaskRunNotificationStore(database.db);
    const row = store.resolveForRunSubscription({
      taskId: "task-terminal",
      taskRunId: "task_run_terminal_1",
      runIndex: 1,
      subscriptionId: "subscription-terminal",
      sessionId: "session-terminal",
      channelType: "feishu",
      channelId: "chat-terminal",
      groupId: null,
      threadKey: "thread-terminal",
      rootMessageKey: "root-terminal",
      surfaceKey: "feishu:chat-terminal:thread-terminal",
    });
    store.setStatusMessageId(row.id, "om_terminal");

    const terminal = store.markTerminal(row.id);

    expect(terminal.state).toBe("terminal");
    expect(terminal.statusMessageId).toBe("om_terminal");
  });
});

describe("TaskSubscriptionStore", () => {
  test("canonicalizes provider thread ids to one root-message subscription", () => {
    const sessionId = "session-thread-canonical-root";
    seedSession(sessionId, "feishu-main");
    database.db.insert(lunaSchema.tasks).values({
      ...fixtureTaskOwnership(database.db, sessionId), id: "task-thread-canonical-root", primary_session_id: sessionId,
      type: "work", title: "Canonical subscription", status: "running", created_at: 1, updated_at: 1, last_activity_at: 1,
    }).run();
    const store = new TaskSubscriptionStore(database.db);
    const original = store.resolve({
      taskId: "task-thread-canonical-root",
      sessionId: "session-thread-canonical-root",
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "oc_thread_canonical",
      threadId: "om_thread_canonical_root",
      rootMessageId: "om_thread_canonical_root",
      visibility: "full",
    });

    const attached = store.resolve({
      taskId: "task-thread-canonical-root",
      sessionId: "session-thread-canonical-root",
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "oc_thread_canonical",
      threadId: "omt_provider_thread_id",
      rootMessageId: "om_thread_canonical_root",
      visibility: "summary",
    });

    expect(attached.id).toBe(original.id);
    expect(attached).toMatchObject({
      thread_key: "om_thread_canonical_root",
      root_message_key: "om_thread_canonical_root",
      visibility: "full",
      surface_key: JSON.stringify([
        "v1",
        "feishu",
        "feishu-main",
        "oc_thread_canonical",
        "thread",
        "om_thread_canonical_root",
      ]),
    });
    expect(store.listForTask("task-thread-canonical-root")).toHaveLength(1);
  });
});

describe("TaskRunNotificationService", () => {
  test("creates one active card per run subscription", async () => {
    const operations: unknown[] = [];
    const channel = {
      async send(_inbound: unknown, operation: unknown) {
        operations.push(operation);
        return {
          sender: { externalId: "test-notification-bot", kind: "bot", displayName: "Notification bot" },
          id: "om_run_1",
          channelId: "chat-service-create",
          replyMode: "reply_in_thread",
          content: "第 1 轮执行已开始。",
          ...(typeof operation === "object" && operation !== null
            ? operation
            : {}),
        } as never;
      },
    };

    database.db.insert(lunaSchema.tasks).values({
      id: "task-service-create",
      type: "task",
      title: "查天气",
      summary: "查询广州天气",
      status: "running",
      block_reason: null,
      priority: "medium",
      severity: null,
      creator_user_id: null,
      primary_session_id: "session-service-create",
      source_message_id: "message-service-create",
      source_entry_id: null,
      context_json: null,
      created_at: 1,
      updated_at: 1,
      last_activity_at: 1, ...fixtureTaskOwnership(database.db,"session-service-create")}).run();
    database.db.insert(lunaSchema.taskRuns).values({
      id: "task_run_service_create_1",
      task_id: "task-service-create",
      run_index: 1,
      status: "running",
      reason: "initial",
      input_snapshot: {},
      materialized_prompt: null,
      runner_type: "mock",
      runner_context_id: null,
      source_message_id: "message-service-create",
      started_at: 2,
      finished_at: null,
      cancel_reason: null,
      error: null,
      final_report_artifact_id: null,
    }).run();
    database.db.insert(lunaSchema.taskSubscriptions).values({
      id: "subscription-service-create",
      task_id: "task-service-create",
      session_id: "session-service-create",
      channel_type: "feishu",
      channel_id: "chat-service-create",
      group_id: "group-service-create",
      thread_key: "thread-service-create",
      root_message_key: "root-service-create",
      surface_key: "surface-service-create",
      visibility: "full",
      notification_level: "major_updates",
      created_at: 3,
      updated_at: 3,
    }).run();

    const { TaskRunNotificationService } = await import(
      "../../src/tasks/task-run-notification-service"
    );
    await new TaskRunNotificationService({
      db: database.db,
      channelForNotification: () => channel as never,
    }).onRunCreated({
      taskId: "task-service-create",
      taskRunId: "task_run_service_create_1",
      sourceMessageId: "message-service-create",
      reason: "initial",
    });

    const notifications = database.db
      .select()
      .from(lunaSchema.taskRunNotifications)
      .all();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      task_run_id: "task_run_service_create_1",
      subscription_id: "subscription-service-create",
      status_message_id: "om_run_1",
      state: "active",
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      replyMode: "reply_in_thread",
      statusCardState: "active",
      content: "",
      statusCard: {
        taskId: "task-service-create",
        title: "查天气",
        summary: "查询广州天气",
        status: "running",
      },
    });
  });

  test("updates only the terminal card for the specified run", async () => {
    const operations: unknown[] = [];
    const channel = {
      async send(_inbound: unknown, operation: unknown) {
        operations.push(operation);
        return {
          sender: { externalId: "test-notification-bot", kind: "bot", displayName: "Notification bot" },
          id: "om_terminal_update",
          channelId: "chat-terminal-update",
          replyMode: "update_status_card",
          targetMessageId: "om_run_terminal",
          content: "处理完成。",
          ...(typeof operation === "object" && operation !== null
            ? operation
            : {}),
        } as never;
      },
    };
    database.db.insert(lunaSchema.tasks).values({
      id: "task-terminal-update",
      type: "task",
      title: "终态任务",
      summary: "终态摘要",
      status: "completed",
      block_reason: null,
      priority: "medium",
      severity: null,
      creator_user_id: null,
      primary_session_id: "session-terminal-update",
      source_message_id: "message-terminal-update",
      source_entry_id: null,
      context_json: null,
      created_at: 1,
      updated_at: 1,
      last_activity_at: 1, ...fixtureTaskOwnership(database.db,"session-terminal-update")}).run();
    database.db.insert(lunaSchema.taskRuns).values({
      id: "task_run_terminal_update_1",
      task_id: "task-terminal-update",
      run_index: 1,
      status: "completed",
      reason: "initial",
      input_snapshot: {},
      materialized_prompt: null,
      runner_type: "mock",
      runner_context_id: null,
      source_message_id: "message-terminal-update",
      started_at: 2,
      finished_at: 3,
      cancel_reason: null,
      error: null,
      final_report_artifact_id: "artifact-terminal-update",
    }).run();
    database.db.insert(lunaSchema.taskSubscriptions).values({
      id: "subscription-terminal-update",
      task_id: "task-terminal-update",
      session_id: "session-terminal-update",
      channel_type: "feishu",
      channel_id: "chat-terminal-update",
      group_id: "group-terminal-update",
      thread_key: "thread-terminal-update",
      root_message_key: "root-terminal-update",
      surface_key: "surface-terminal-update",
      visibility: "full",
      notification_level: "major_updates",
      created_at: 4,
      updated_at: 4,
    }).run();
    const notificationStore = new TaskRunNotificationStore(database.db);
    const notification = notificationStore.resolveForRunSubscription({
      taskId: "task-terminal-update",
      taskRunId: "task_run_terminal_update_1",
      runIndex: 1,
      subscriptionId: "subscription-terminal-update",
      sessionId: "session-terminal-update",
      channelType: "feishu",
      channelId: "chat-terminal-update",
      groupId: "group-terminal-update",
      threadKey: "thread-terminal-update",
      rootMessageKey: "root-terminal-update",
      surfaceKey: "surface-terminal-update",
    });
    notificationStore.setStatusMessageId(notification.id, "om_run_terminal");
    database.db.insert(lunaSchema.timelineEvents).values([
      {
        id: "event-terminal-step-1",
        task_id: "task-terminal-update",
        session_id: "session-terminal-update",
        message_id: null,
        actor_user_id: null,
        source_message_id: "message-terminal-update",
        type: "runner.step",
        summary: "正在查询天气数据。",
        data: {
          taskRunId: "task_run_terminal_update_1",
          runIndex: 1,
        },
        visibility: "public",
        created_at: 5,
      },
      {
        id: "event-terminal-step-2",
        task_id: "task-terminal-update",
        session_id: "session-terminal-update",
        message_id: null,
        actor_user_id: null,
        source_message_id: "message-terminal-update",
        type: "runner.step",
        summary: "天气数据查询完成。",
        data: {
          taskRunId: "task_run_terminal_update_1",
          runIndex: 1,
        },
        visibility: "public",
        created_at: 6,
      },
    ]).run();

    const { TaskRunNotificationService } = await import(
      "../../src/tasks/task-run-notification-service"
    );
    await new TaskRunNotificationService({
      db: database.db,
      channelForNotification: () => channel as never,
    }).onRunCompleted({
      taskRunId: "task_run_terminal_update_1",
      result: {
        taskId: "task-terminal-update",
        taskRunId: "task_run_terminal_update_1",
        runIndex: 1,
        title: "终态任务",
        summary: "终态摘要",
        conclusion: "今天多云，适合出门。",
        status: "completed",
        artifactIds: [],
      },
    });

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      replyMode: "update_status_card",
      targetMessageId: "om_run_terminal",
      statusCardState: "terminal",
      statusCard: {
        taskId: "task-terminal-update",
        title: "终态任务",
        summary: "终态摘要",
        status: "completed",
      },
      content: "处理完成。",
      progressUpdate: {mode: "snapshot", entries: [
        expect.objectContaining({text: "正在查询天气数据。", kind: "text"}),
        expect.objectContaining({text: "天气数据查询完成。", kind: "text"}),
      ]},
    });
    expect(notificationStore.requireById(notification.id).state).toBe(
      "terminal",
    );
  });

  test("updates active status card when runner step is recorded", async () => {
    const operations: unknown[] = [];
    const channel = {
      async send(_inbound: unknown, operation: unknown) {
        operations.push(operation);
        return {
          sender: { externalId: "test-notification-bot", kind: "bot", displayName: "Notification bot" },
          id: "om_progress_update",
          channelId: "chat-progress-update",
          replyMode: "update_status_card",
          targetMessageId: "om_run_progress",
          content: "",
          ...(typeof operation === "object" && operation !== null
            ? operation
            : {}),
        } as never;
      },
    };
    database.db.insert(lunaSchema.tasks).values({
      id: "task-progress-update",
      type: "task",
      title: "进度任务",
      summary: "进度摘要",
      status: "running",
      block_reason: null,
      priority: "medium",
      severity: null,
      creator_user_id: null,
      primary_session_id: "session-progress-update",
      source_message_id: "message-progress-update",
      source_entry_id: null,
      context_json: null,
      created_at: 1,
      updated_at: 1,
      last_activity_at: 1, ...fixtureTaskOwnership(database.db,"session-progress-update")}).run();
    database.db.insert(lunaSchema.taskRuns).values({
      id: "task_run_progress_update_1",
      task_id: "task-progress-update",
      run_index: 1,
      status: "running",
      reason: "initial",
      input_snapshot: {},
      materialized_prompt: null,
      runner_type: "mock",
      runner_context_id: null,
      source_message_id: "message-progress-update",
      started_at: 2,
      finished_at: null,
      cancel_reason: null,
      error: null,
      final_report_artifact_id: null,
    }).run();
    database.db.insert(lunaSchema.taskSubscriptions).values({
      id: "subscription-progress-update",
      task_id: "task-progress-update",
      session_id: "session-progress-update",
      channel_type: "feishu",
      channel_id: "chat-progress-update",
      group_id: "group-progress-update",
      thread_key: "thread-progress-update",
      root_message_key: "root-progress-update",
      surface_key: "surface-progress-update",
      visibility: "full",
      notification_level: "major_updates",
      created_at: 3,
      updated_at: 3,
    }).run();
    const notificationStore = new TaskRunNotificationStore(database.db);
    const notification = notificationStore.resolveForRunSubscription({
      taskId: "task-progress-update",
      taskRunId: "task_run_progress_update_1",
      runIndex: 1,
      subscriptionId: "subscription-progress-update",
      sessionId: "session-progress-update",
      channelType: "feishu",
      channelId: "chat-progress-update",
      groupId: "group-progress-update",
      threadKey: "thread-progress-update",
      rootMessageKey: "root-progress-update",
      surfaceKey: "surface-progress-update",
    });
    notificationStore.setStatusMessageId(notification.id, "om_run_progress");
    database.db.insert(lunaSchema.timelineEvents).values([
      {
        id: "event-progress-step-1",
        task_id: "task-progress-update",
        session_id: "session-progress-update",
        message_id: null,
        actor_user_id: null,
        source_message_id: "message-progress-update",
        type: "runner.step",
        summary: "正在查询日志。",
        data: {
          taskRunId: "task_run_progress_update_1",
          runIndex: 1,
        },
        visibility: "public",
        created_at: 4,
      },
    ]).run();

    const { TaskRunNotificationService } = await import(
      "../../src/tasks/task-run-notification-service"
    );
    const progressService = new TaskRunNotificationService({
      db: database.db,
      channelForNotification: () => channel as never,
    });
    await progressService.onRunProgress({
      taskRunId: "task_run_progress_update_1",
    });

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      replyMode: "update_status_card",
      targetMessageId: "om_run_progress",
      statusCardState: "active",
      statusCard: {
        taskId: "task-progress-update",
        title: "进度任务",
        summary: "进度摘要",
        status: "running",
      },
      content: "",
      progressUpdate: {mode: "snapshot", entries: [expect.objectContaining({text: "正在查询日志。", kind: "text"})]},
    });
    expect(notificationStore.requireById(notification.id).state).toBe("active");
    operations.length = 0;
    // No corresponding timeline row: the hot path must use the supplied delta.
    await progressService.onRunProgress({taskRunId:"task_run_progress_update_1",events:[{
      id:"new-delta",type:"runner.step",summary:"已找到原因。",created_at:10,updated_at:10,
      data:{taskRunId:"task_run_progress_update_1",runIndex:1,publicProgress:true},
    }]});
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({progressUpdate:{mode:"delta",entries:[{id:"new-delta",kind:"text",text:"已找到原因。",createdAt:10,updatedAt:10}]}});
  });
});

describe("TaskRunNotificationRecovery", () => {
  test("retries unsent create attempts for active run notifications", async () => {
    const operations: unknown[] = [];
    const channel = {
      async send(_inbound: unknown, operation: unknown) {
        operations.push(operation);
        return {
          sender: { externalId: "test-notification-bot", kind: "bot", displayName: "Notification bot" },
          id: "om_retried_create",
          channelId: "chat-retry-create",
          replyMode: "reply_in_thread",
          content: "第 1 轮执行已开始。",
          ...(typeof operation === "object" && operation !== null
            ? operation
            : {}),
        } as never;
      },
    };
    database.db.insert(lunaSchema.tasks).values({
      id: "task-retry-create",
      type: "task",
      title: "恢复创建卡片",
      summary: "恢复未成功创建的运行卡片",
      status: "running",
      block_reason: null,
      priority: "medium",
      severity: null,
      creator_user_id: null,
      primary_session_id: "session-retry-create",
      source_message_id: "message-retry-create",
      source_entry_id: null,
      context_json: null,
      created_at: 1,
      updated_at: 1,
      last_activity_at: 1, ...fixtureTaskOwnership(database.db,"session-retry-create")}).run();
    database.db.insert(lunaSchema.taskRuns).values({
      id: "task_run_retry_create_1",
      task_id: "task-retry-create",
      run_index: 1,
      status: "running",
      reason: "initial",
      input_snapshot: {},
      materialized_prompt: null,
      runner_type: "mock",
      runner_context_id: null,
      source_message_id: "message-retry-create",
      started_at: 2,
      finished_at: null,
      cancel_reason: null,
      error: null,
      final_report_artifact_id: null,
    }).run();
    database.db.insert(lunaSchema.taskSubscriptions).values({
      id: "subscription-retry-create",
      task_id: "task-retry-create",
      session_id: "session-retry-create",
      channel_type: "feishu",
      channel_id: "chat-retry-create",
      group_id: "group-retry-create",
      thread_key: "thread-retry-create",
      root_message_key: "root-retry-create",
      surface_key: "surface-retry-create",
      visibility: "full",
      notification_level: "major_updates",
      created_at: 3,
      updated_at: 3,
    }).run();
    database.db.insert(lunaSchema.taskRunNotifications).values({
      id: "task_run_notification_retry_create",
      task_id: "task-retry-create",
      task_run_id: "task_run_retry_create_1",
      run_index: 1,
      subscription_id: "subscription-retry-create",
      session_id: "session-retry-create",
      channel_type: "feishu",
      channel_id: "chat-retry-create",
      group_id: "group-retry-create",
      thread_key: "thread-retry-create",
      root_message_key: "root-retry-create",
      surface_key: "surface-retry-create",
      status_message_id: null,
      state: "active",
      created_at: 4,
      updated_at: 4,
    }).run();
    database.db.insert(lunaSchema.notificationAttempts).values({
      id: "attempt-retry-create",
      idempotency_key: JSON.stringify([
        "task-run-notification",
        "task_run_retry_create_1",
        "subscription-retry-create",
        "create_status_card",
      ]),
      task_id: "task-retry-create",
      subscription_id: "subscription-retry-create",
      message_id: "message-retry-create",
      action: "create_status_card",
      status: "failed",
      outbound_id: null,
      created_at: 5,
      updated_at: 5,
    }).run();

    const { TaskRunNotificationRecovery } = await import(
      "../../src/tasks/task-run-notification-recovery"
    );
    const recovered = await new TaskRunNotificationRecovery({
      db: database.db,
      channelForNotification: () => channel as never,
    }).recoverPending();

    expect(recovered).toBe(1);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      replyMode: "reply_in_thread",
      statusCardState: "active",
      statusCard: {
        taskId: "task-retry-create",
        status: "running",
      },
    });
    expect(
      database.db.select().from(lunaSchema.taskRunNotifications).all()[0],
    ).toMatchObject({
      status_message_id: "om_retried_create",
      state: "active",
    });
  });

  test("backfills sent create attempts into run notifications", async () => {
    database.db.insert(lunaSchema.taskRunNotifications).values({
      id: "task_run_notification_recovery",
      task_id: "task-recovery",
      task_run_id: "task_run_recovery_1",
      run_index: 1,
      subscription_id: "subscription-recovery",
      session_id: "session-recovery",
      channel_type: "feishu",
      channel_id: "chat-recovery",
      group_id: null,
      thread_key: null,
      root_message_key: "root-recovery",
      surface_key: "surface-recovery",
      status_message_id: null,
      state: "active",
      created_at: 1,
      updated_at: 1,
    }).run();
    database.db.insert(lunaSchema.notificationAttempts).values({
      id: "attempt-recovery-create",
      idempotency_key: JSON.stringify([
        "task-run-notification",
        "task_run_recovery_1",
        "subscription-recovery",
        "create_status_card",
      ]),
      task_id: "task-recovery",
      subscription_id: "subscription-recovery",
      message_id: "message-recovery",
      action: "create_status_card",
      status: "sent",
      outbound_id: "om_recovered",
      created_at: 2,
      updated_at: 2,
    }).run();

    const { TaskRunNotificationRecovery } = await import(
      "../../src/tasks/task-run-notification-recovery"
    );
    const recovered = await new TaskRunNotificationRecovery({
      db: database.db,
      channelForNotification: () => undefined,
    }).recoverPending();

    expect(recovered).toBe(1);
    expect(database.db.select().from(lunaSchema.taskRunNotifications).all()[0])
      .toMatchObject({ status_message_id: "om_recovered" });
  });
});
