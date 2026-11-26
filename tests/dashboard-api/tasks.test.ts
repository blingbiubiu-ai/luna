import { describe, expect, test } from "bun:test";

import {
  buildDashboardTasks,
  type DashboardTasksProjectionRows,
  type TaskRow,
  type TaskRunRow,
} from "../../src/dashboard-api/tasks";

describe("Dashboard task DTOs", () => {
  test("project task status from the latest run instead of the durable task row", () => {
    const [task] = buildDashboardTasks(
      [taskRow({ status: "running" })],
      projectionRows({
        runRows: [
          taskRunRow({ id: "run-1", run_index: 1, status: "failed" }),
          taskRunRow({ id: "run-2", run_index: 2, status: "completed" }),
        ],
      }),
    );

    expect(task?.status).toBe("completed");
  });

  test("uses the highest run index as the latest task status", () => {
    const [task] = buildDashboardTasks(
      [taskRow({ status: "running" })],
      projectionRows({
        runRows: [
          taskRunRow({ id: "run-2", run_index: 2, status: "completed" }),
          taskRunRow({ id: "run-1", run_index: 1, status: "failed" }),
        ],
      }),
    );

    expect(task?.status).toBe("completed");
  });

  test("projects blockReason, wakeAt, wakeReason, and run pauseReason for waiting tasks and clears task wake metadata once completed", () => {
    const [waitingTask] = buildDashboardTasks(
      [
        taskRow({
          status: "waiting",
          block_reason: "waiting_external",
          wake_at: 1_800_000_000_000,
          wake_reason: "等待 2h 增量实验指标稳定后回读",
        }),
      ],
      projectionRows({
        runRows: [
          taskRunRow({
            id: "run-1",
            run_index: 1,
            status: "waiting",
            pause_reason: "等待 2h 增量实验指标稳定后回读",
          }),
        ],
      }),
    );

    expect(waitingTask?.status).toBe("waiting");
    expect(waitingTask?.blockReason).toBe("waiting_external");
    expect(waitingTask?.wakeAt).toBe(1_800_000_000_000);
    expect(waitingTask?.wakeReason).toBe("等待 2h 增量实验指标稳定后回读");
    expect(waitingTask?.runs[0]?.pauseReason).toBe("等待 2h 增量实验指标稳定后回读");

    const [completedTask] = buildDashboardTasks(
      [
        taskRow({
          status: "waiting",
          block_reason: "waiting_external",
          wake_at: 1_800_000_000_000,
          wake_reason: "stale wake reason",
        }),
      ],
      projectionRows({
        runRows: [
          taskRunRow({
            id: "run-2",
            run_index: 2,
            status: "completed",
            pause_reason: "previous pause",
          }),
        ],
      }),
    );

    expect(completedTask?.status).toBe("completed");
    expect(completedTask?.blockReason).toBeNull();
    expect(completedTask?.wakeAt).toBeNull();
    expect(completedTask?.wakeReason).toBeNull();
    expect(completedTask?.runs[0]?.pauseReason).toBe("previous pause");
  });
});

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    type: "task",
    title: "Test task",
    summary: null,
    status: "new",
    priority: "normal",
    severity: null,
    creator_user_id: null,
    session_id: null,
    primary_session_id: null,
    source_message_id: null,
    source_entry_id: null,
    context_json: null,
    created_at: 1,
    updated_at: 1,
    last_activity_at: 1,
    ...overrides,
  };
}

function taskRunRow(overrides: Partial<TaskRunRow> = {}): TaskRunRow {
  return {
    id: "run-1",
    task_id: "task-1",
    run_index: 1,
    status: "running",
    reason: "test",
    input_snapshot: null,
    materialized_prompt: null,
    runner_type: "mock",
    runner_context_id: null,
    source_message_id: null,
    started_at: 1,
    finished_at: null,
    cancel_reason: null,
    error: null,
    final_report_artifact_id: null,
    ...overrides,
  };
}

function projectionRows(
  overrides: Partial<DashboardTasksProjectionRows> = {},
): DashboardTasksProjectionRows {
  return {
    participantRows: [],
    sourceContextItems: [],
    subscriptionRows: [],
    sessionRows: [],
    surfaceRows: [],
    messageRows: [],
    turnEntryRows: [],
    runRows: [],
    timelineRows: [],
    artifactRows: [],
    identityRows: [],
    userRows: [],
    channelUserBindingRows: [],
    contextBundleRows: {
      packsByOwnerKey: new Map(),
      itemsByPackId: new Map(),
      seedRecordsByOwnerKey: new Map(),
    },
    artifactSigner: {
      previewUrl: () => undefined,
      contentUrl: () => undefined,
    },
    ...overrides,
  };
}
