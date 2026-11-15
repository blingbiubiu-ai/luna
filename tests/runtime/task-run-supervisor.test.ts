import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import {fixtureNamedSession, fixtureScope, fixtureSessionOwnership} from "../helpers/platform-fixtures";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";

import {
  TaskRunSupervisor,
  type TaskRunSupervisorOptions,
} from "../../src/tasks/task-run-supervisor";
import {
  TaskRunActiveRunError,
  TaskRunStore,
  TaskRunTerminalTransitionError,
} from "../../src/tasks/task-run-store";
import { AgentStore } from "../../src/agents/agent-store";
import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import {
  buildTaskResultForMainRunner,
  executeTaskRun,
  type ExecuteTaskRunInput,
  type ExecuteTaskRunResult,
} from "../../src/kernel/task-run-handler";
import { ContextPackStore } from "../../src/context";
import type { TaskResultForMainRunner } from "../../src/main-runner/types";
import { decodeInvocation } from "../../src/runners/invocation-codec";
import { runnerContextFilePath } from "../../src/runners/runner-context-file";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionTurnStore } from "../../src/sessions/session-turn-store";
import { config, setLunaHome } from "../../src/shared";
import { TaskSubscriptionStore } from "../../src/tasks/task-subscription-store";
import { ArtifactStore } from "../../src/timeline/artifact-store";
import { TimelineStore } from "../../src/timeline/timeline-store";

let testHome: string;
let previousHome: string;
let database: DataConnection<typeof lunaSchema>;
let store: TaskRunStore;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-task-run-store-test-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  store = new TaskRunStore(database.db);
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("TaskRunStore", () => {
  test("allocates sequential runIndex per task", () => {
    const first = store.createRun({
      taskId: "task-alpha",
      reason: "initial",
      inputSnapshot: { did: "old-did" },
      runnerType: "mock",
      startedAt: 100,
    });
    store.markCompleted(first.id, {
      finishedAt: 110,
      finalReportArtifactId: "artifact-1",
    });

    const second = store.createRun({
      taskId: "task-alpha",
      reason: "restart",
      inputSnapshot: { did: "new-did" },
      runnerType: "mock",
      sourceMessageId: "message-correction",
      startedAt: 120,
    });
    const otherTask = store.createRun({
      taskId: "task-beta",
      reason: "initial",
      inputSnapshot: { did: "beta-did" },
      runnerType: "mock",
      startedAt: 130,
    });

    expect(first.runIndex).toBe(1);
    expect(second.runIndex).toBe(2);
    expect(otherTask.runIndex).toBe(1);
    expect(store.listRunsForTask("task-alpha").map((run) => run.runIndex))
      .toEqual([1, 2]);
    expect(second.inputSnapshot).toEqual({ did: "new-did" });
    expect(second.materializedPrompt).toBeNull();
    expect(second.sourceMessageId).toBe("message-correction");
  });

  test("wraps scalar input snapshots when persisting run context pack ids", () => {
    const run = store.createRun({
      taskId: "task-scalar-snapshot-context",
      reason: "initial",
      inputSnapshot: "Investigate scalar prompt.",
      contextPackIds: ["context-pack-scalar"],
      runnerType: "mock",
      startedAt: 150,
    });

    expect(run.inputSnapshot).toEqual({
      rawInputSnapshot: "Investigate scalar prompt.",
      contextPackIds: ["context-pack-scalar"],
    });
  });

  test("returns the active running run for a task", () => {
    const run = store.createRun({
      taskId: "task-active",
      reason: "initial",
      inputSnapshot: { query: "diagnose" },
      runnerType: "mock",
      runnerContextId: "runner-context-1",
      startedAt: 200,
    });

    expect(store.getActiveRunForTask("task-active")).toMatchObject({
      id: run.id,
      taskId: "task-active",
      status: "running",
      runnerContextId: "runner-context-1",
      inputSnapshot: { query: "diagnose" },
    });
    expect(store.getActiveRunForTask("missing-task")).toBeUndefined();
  });

  test("rejects creating a second active run for the same task", () => {
    store.createRun({
      taskId: "task-single-active",
      reason: "initial",
      inputSnapshot: { did: "first" },
      runnerType: "mock",
      startedAt: 300,
    });

    expect(() =>
      store.createRun({
        taskId: "task-single-active",
        reason: "restart",
        inputSnapshot: { did: "second" },
        runnerType: "mock",
        startedAt: 301,
      }),
    ).toThrow(TaskRunActiveRunError);
  });

  test("rejects duplicate restart source message rows for the same task", () => {
    const firstRestart = store.createRun({
      taskId: "task-duplicate-restart-source",
      reason: "restart",
      inputSnapshot: { did: "corrected-did" },
      runnerType: "mock",
      sourceMessageId: "message-duplicate-restart",
      startedAt: 310,
    });
    store.markCompleted(firstRestart.id, {
      finishedAt: 311,
      finalReportArtifactId: "artifact-duplicate-restart",
    });

    expect(() =>
      store.createRun({
        taskId: "task-duplicate-restart-source",
        reason: "restart",
        inputSnapshot: { did: "corrected-did-again" },
        runnerType: "mock",
        sourceMessageId: "message-duplicate-restart",
        startedAt: 312,
      }),
    ).toThrow();
  });

  test("persists terminal completed cancelled and failed transitions", () => {
    const completed = store.createRun({
      taskId: "task-completed",
      reason: "initial",
      inputSnapshot: { kind: "completed" },
      runnerType: "mock",
      startedAt: 400,
    });
    store.markCompleted(completed.id, {
      finishedAt: 410,
      finalReportArtifactId: "artifact-completed",
    });

    const cancelled = store.createRun({
      taskId: "task-cancelled",
      reason: "initial",
      inputSnapshot: { kind: "cancelled" },
      runnerType: "mock",
      startedAt: 420,
    });
    store.markCancelled(cancelled.id, {
      finishedAt: 421,
      cancelReason: "superseded by corrected did",
    });

    const failed = store.createRun({
      taskId: "task-failed",
      reason: "initial",
      inputSnapshot: { kind: "failed" },
      runnerType: "mock",
      startedAt: 430,
    });
    store.markFailed(failed.id, {
      finishedAt: 431,
      error: "runner crashed",
    });

    expect(store.listRunsForTask("task-completed")[0]).toMatchObject({
      status: "completed",
      finishedAt: 410,
      finalReportArtifactId: "artifact-completed",
    });
    expect(store.listRunsForTask("task-cancelled")[0]).toMatchObject({
      status: "cancelled",
      finishedAt: 421,
      cancelReason: "superseded by corrected did",
    });
    expect(store.listRunsForTask("task-failed")[0]).toMatchObject({
      status: "failed",
      finishedAt: 431,
      error: "runner crashed",
    });
    expect(store.getActiveRunForTask("task-completed")).toBeUndefined();
    expect(store.getActiveRunForTask("task-cancelled")).toBeUndefined();
    expect(store.getActiveRunForTask("task-failed")).toBeUndefined();
  });

  test("rejects completing a task run without a final report artifact", () => {
    const completed = store.createRun({
      taskId: "task-completed-without-report",
      reason: "initial",
      inputSnapshot: { kind: "completed" },
      runnerType: "mock",
      startedAt: 440,
    });

    expect(() =>
      store.markCompleted(completed.id, {
        finishedAt: 441,
      } as any)
    ).toThrow("requires a final report artifact");
    expect(store.listRunsForTask("task-completed-without-report")[0])
      .toMatchObject({
        status: "running",
        finishedAt: null,
        finalReportArtifactId: null,
      });
  });

  test("rejects stale terminal-to-terminal supervisor updates", () => {
    const cancelled = store.createRun({
      taskId: "task-stale-cancelled",
      reason: "initial",
      inputSnapshot: { kind: "cancelled" },
      runnerType: "mock",
      startedAt: 450,
    });
    store.markCancelled(cancelled.id, {
      finishedAt: 451,
      cancelReason: "user cancelled",
    });

    expect(() =>
      store.markCompleted(cancelled.id, {
        finishedAt: 452,
        finalReportArtifactId: "artifact-stale",
      }),
    ).toThrow(TaskRunTerminalTransitionError);
    expect(store.listRunsForTask("task-stale-cancelled")[0]).toMatchObject({
      status: "cancelled",
      finishedAt: 451,
      cancelReason: "user cancelled",
      finalReportArtifactId: null,
    });

    const failed = store.createRun({
      taskId: "task-stale-failed",
      reason: "initial",
      inputSnapshot: { kind: "failed" },
      runnerType: "mock",
      startedAt: 460,
    });
    store.markFailed(failed.id, {
      finishedAt: 461,
      error: "runner crashed",
    });

    expect(() =>
      store.markCancelled(failed.id, {
        finishedAt: 462,
        cancelReason: "late cancellation",
      }),
    ).toThrow(TaskRunTerminalTransitionError);
    expect(store.listRunsForTask("task-stale-failed")[0]).toMatchObject({
      status: "failed",
      finishedAt: 461,
      cancelReason: null,
      error: "runner crashed",
    });
  });

  test("clears mutually exclusive terminal fields", () => {
    const completed = store.createRun({
      taskId: "task-clear-completed",
      reason: "initial",
      inputSnapshot: { kind: "completed" },
      runnerType: "mock",
      startedAt: 470,
    });
    database.db
      .update(lunaSchema.taskRuns)
      .set({
        cancel_reason: "stale cancellation",
        error: "stale error",
      })
      .where(eq(lunaSchema.taskRuns.id, completed.id))
      .run();
    store.markCompleted(completed.id, {
      finishedAt: 471,
      finalReportArtifactId: "artifact-clear-completed",
    });
    expect(store.listRunsForTask("task-clear-completed")[0]).toMatchObject({
      status: "completed",
      cancelReason: null,
      error: null,
      finalReportArtifactId: "artifact-clear-completed",
    });

    const cancelled = store.createRun({
      taskId: "task-clear-cancelled",
      reason: "initial",
      inputSnapshot: { kind: "cancelled" },
      runnerType: "mock",
      startedAt: 480,
    });
    database.db
      .update(lunaSchema.taskRuns)
      .set({
        error: "stale error",
        final_report_artifact_id: "stale-artifact",
      })
      .where(eq(lunaSchema.taskRuns.id, cancelled.id))
      .run();
    store.markCancelled(cancelled.id, { finishedAt: 481 });
    expect(store.listRunsForTask("task-clear-cancelled")[0]).toMatchObject({
      status: "cancelled",
      cancelReason: null,
      error: null,
      finalReportArtifactId: null,
    });

    const failed = store.createRun({
      taskId: "task-clear-failed",
      reason: "initial",
      inputSnapshot: { kind: "failed" },
      runnerType: "mock",
      startedAt: 490,
    });
    database.db
      .update(lunaSchema.taskRuns)
      .set({
        cancel_reason: "stale cancellation",
        final_report_artifact_id: "stale-artifact",
      })
      .where(eq(lunaSchema.taskRuns.id, failed.id))
      .run();
    store.markFailed(failed.id, { finishedAt: 491 });
    expect(store.listRunsForTask("task-clear-failed")[0]).toMatchObject({
      status: "failed",
      cancelReason: null,
      error: null,
      finalReportArtifactId: null,
    });
  });

  test("marks leftover running runs as failed for recovery", () => {
    const first = store.createRun({
      taskId: "task-recovery-1",
      reason: "initial",
      inputSnapshot: { did: "one" },
      runnerType: "mock",
      startedAt: 500,
    });
    const second = store.createRun({
      taskId: "task-recovery-2",
      reason: "initial",
      inputSnapshot: { did: "two" },
      runnerType: "mock",
      startedAt: 501,
    });
    const completed = store.createRun({
      taskId: "task-recovery-3",
      reason: "initial",
      inputSnapshot: { did: "three" },
      runnerType: "mock",
      startedAt: 502,
    });
    store.markCompleted(completed.id, {
      finishedAt: 503,
      finalReportArtifactId: "artifact-safe",
    });

    const recovered = store.markRunningRunsFailedForRecovery({
      finishedAt: 600,
      error: "Runtime restarted before this Task Run finished.",
    });

    expect(recovered.map((run) => run.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(store.listRunsForTask("task-recovery-1")[0]).toMatchObject({
      status: "failed",
      finishedAt: 600,
      error: "Runtime restarted before this Task Run finished.",
    });
    expect(store.listRunsForTask("task-recovery-2")[0]).toMatchObject({
      status: "failed",
      finishedAt: 600,
    });
    expect(store.listRunsForTask("task-recovery-3")[0]).toMatchObject({
      status: "completed",
      finalReportArtifactId: "artifact-safe",
    });
  });
});

describe("TaskRunSupervisor configuration", () => {
  test("no longer requires runnerExecution", () => {
    expect(
      () =>
        new TaskRunSupervisor({
          db: database.db,
          runnerType: "mock",
        } as unknown as TaskRunSupervisorOptions),
    ).not.toThrow();
  });
});

describe("TimelineStore", () => {
  test("separate store instances append timeline events with increasing persisted timestamps", () => {
    const originalDateNow = Date.now;
    Date.now = () => 1_000;
    try {
      const taskId = "task-timeline-store-monotonic";
      const firstTimeline = new TimelineStore(database.db);
      const secondTimeline = new TimelineStore(database.db);

      const contextEvent = firstTimeline.append({
        taskId,
        messageId: "message-context-update",
        type: "context.updated",
        summary: "Updated task context.",
      });
      const runnerEvent = secondTimeline.append({
        taskId,
        type: "runner.started",
        summary: "Started runner after context update.",
      });

      const events = database.db
        .select()
        .from(lunaSchema.timelineEvents)
        .where(eq(lunaSchema.timelineEvents.task_id, taskId))
        .orderBy(asc(lunaSchema.timelineEvents.created_at))
        .all();

      expect(runnerEvent.created_at).toBeGreaterThan(contextEvent.created_at);
      expect(events.map((event) => event.type)).toEqual([
        "context.updated",
        "runner.started",
      ]);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

describe("TaskRunSupervisor", () => {
  test("foreign Shadow input leaves the running task and its update history intact", () => {
    const taskId = _createTask("task-invalid-restart-source");
    const {agentId} = fixtureScope(database.db, "user-1");
    const shadow = new AgentStore(database.db).createShadow("user-1", agentId, {name: "Other Shadow"}, "foreign-source");
    const session = new SessionStore(database.db).createLocalSession("user-1", {agentId, shadowId: shadow.id});
    const source = new MessageStore(database.db).append({
      sessionId: session.id, senderUserId: "user-1", role: "user",
      content: [{type: "text", text: "Foreign input"}],
    });
    const supervisor = new TaskRunSupervisor({db: database.db, runnerType: "mock"});
    const current = store.createRun({taskId, reason: "initial", runnerType: "mock", inputSnapshot: {}});
    expect(() => supervisor.restartTaskRun({
      taskId, sourceMessageId: source.id, updatedTaskSummary: "Foreign change",
      updateSummary: "Foreign change", inputSnapshot: {},
    })).toThrow("task_scope_mismatch");
    expect(store.getActiveRunForTask(taskId)?.id).toBe(current.id);
    expect(database.db.select().from(lunaSchema.tasks).where(eq(lunaSchema.tasks.id, taskId)).get()?.summary).toBe("Initial task summary");
    expect(database.db.select().from(lunaSchema.timelineEvents).where(eq(lunaSchema.timelineEvents.task_id, taskId)).all()).toEqual([]);
    expect(database.db.select().from(lunaSchema.contextPacks).where(eq(lunaSchema.contextPacks.ownerId, taskId)).all()).toEqual([]);
  });

  test("emits run notification lifecycle events", async () => {
    const taskId = _createTask("task-notify-lifecycle");
    const updateMessageId = _taskMessage("message-second");
    const initialMessageId = _taskMessage("message-first");
    const events: unknown[] = [];
    const firstRunStarted = _deferred<void>();
    const firstRunRelease = _deferred<ExecuteTaskRunResult>();
    const artifacts = new ArtifactStore(database.db);
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      runNotifications: {
        onRunCreated: async (event) => {
          events.push({ type: "created", ...event });
        },
        onRunCancelled: async (event) => {
          events.push({ type: "cancelled", ...event });
        },
        onRunCompleted: async (event) => {
          events.push({ type: "completed", ...event });
        },
        onRunProgress: async (event) => {
          events.push({ type: "progress", ...event });
        },
        onRunFailed: async (event) => {
          events.push({ type: "failed", ...event });
        },
      },
      executeRun: async (input) => {
        if (input.reason === "initial") {
          firstRunStarted.resolve();
          return await firstRunRelease.promise;
        }
        await input.onProgress?.();
        const artifact = artifacts.create({
          taskId: input.taskId,
          type: "report",
          name: "final-report.md",
          mimeType: "text/markdown",
          content: "# Second run report",
        });
        return { finalReportArtifactId: artifact.id };
      },
    });

    const first = supervisor.startInitialRun({
      taskId,
      inputSnapshot: { prompt: "first" },
      sourceMessageId: initialMessageId,
    });
    await firstRunStarted.promise;
    const second = supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "Second summary",
      updateSummary: "补充第二轮输入",
      inputSnapshot: { prompt: "second" },
      sourceMessageId: updateMessageId,
      cancelReason: "new valuable input",
    });
    firstRunRelease.resolve({ finalReportArtifactId: "ignored-first-report" });
    await supervisor.waitForIdle();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "created", taskRunId: first.id }),
      expect.objectContaining({
        type: "cancelled",
        taskRunId: first.id,
        cancelledByRunId: second.id,
      }),
      expect.objectContaining({ type: "created", taskRunId: second.id }),
      expect.objectContaining({ type: "progress", taskRunId: second.id }),
      expect.objectContaining({ type: "completed", taskRunId: second.id }),
    ]));
  });

  test("startInitialRun creates one Task Run and completes without legacy task row", async () => {
    const taskId = _createTask("task-supervisor-success");
    const taskResults: TaskResultForMainRunner[] = [];
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      onTaskResult: (result) => {
        taskResults.push(result);
      },
    });

    const startedRun = supervisor.startInitialRun({
      taskId,
      inputSnapshot: {
        prompt: "Diagnose 502 failures for the payment API.",
      },
      sourceMessageId: "message-initial",
    });

    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    const taskRow = database.db
      .select()
      .from(lunaSchema.tasks)
      .where(eq(lunaSchema.tasks.id, taskId))
      .get();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: startedRun.id,
      taskId,
      runIndex: 1,
      reason: "initial",
      status: "completed",
      runnerType: "mock",
      sourceMessageId: "message-initial",
      inputSnapshot: {
        prompt: "Diagnose 502 failures for the payment API.",
      },
    });
    expect(runs[0]?.runnerContextId).toBeString();
    expect(runs[0]?.finishedAt).toBeNumber();
    expect(runs[0]?.finalReportArtifactId).toBeString();
    expect(store.getActiveRunForTask(taskId)).toBeUndefined();
    expect(taskRow?.status).toBe("completed");
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]).toMatchObject({
      taskId,
      status: "completed",
      userVisibleReport: expect.stringContaining("# Fake runner report"),
    });
    expect(taskResults[0]?.conclusion).toBeUndefined();
  });

  test("treats a successful task run without a final report artifact as failed", async () => {
    const taskId = _createTask("task-supervisor-missing-final-report");
    const taskResults: TaskResultForMainRunner[] = [];
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      onTaskResult: (result) => {
        taskResults.push(result);
      },
      executeRun: async () => ({}) as ExecuteTaskRunResult,
    });

    supervisor.startInitialRun({
      taskId,
      inputSnapshot: {
        prompt: "Complete without returning a final report artifact.",
      },
      sourceMessageId: "message-missing-final-report",
    });

    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    const taskRow = database.db
      .select()
      .from(lunaSchema.tasks)
      .where(eq(lunaSchema.tasks.id, taskId))
      .get();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      taskId,
      status: "failed",
      finalReportArtifactId: null,
      error: "Task runner completed without a final report artifact.",
    });
    expect(taskRow?.status).toBe("failed");
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]).toMatchObject({
      taskId,
      status: "failed",
      userVisibleReport:
        "Task runner failed: Task runner completed without a final report artifact.",
    });
  });

  test("success persists the exact materialized prompt used for each task run", async () => {
    const taskId = _createTask("task-supervisor-prompt-input");
    database.db
      .update(lunaSchema.tasks)
      .set({
        context_json: {
          knownFacts: ["EU users see 502 during playback."],
          assumptions: ["Start with CDN and origin timeout evidence."],
        },
      })
      .where(eq(lunaSchema.tasks.id, taskId))
      .run();
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
    });

    supervisor.startInitialRun({
      taskId,
      inputSnapshot: {
        prompt: "Investigate playback failures.",
      },
      sourceMessageId: "message-prompt-source",
    });

    await supervisor.waitForIdle();

    const [run] = store.listRunsForTask(taskId);
    expect(run?.inputSnapshot).toEqual({
      prompt: "Investigate playback failures.",
    });
    expect(run?.materializedPrompt).toContain(
      `Title: Task ${taskId}`,
    );
    expect(run?.materializedPrompt).toContain(
      "New user input:\nInvestigate playback failures.",
    );
    expect(run?.materializedPrompt).toContain(
      "Confirmed facts:\n- EU users see 502 during playback.",
    );
    expect(run?.materializedPrompt).toContain(
      "Launch assumptions:\n- Start with CDN and origin timeout evidence.",
    );
  });

  test("materializes task launch context and records seed records once per runner context", async () => {
    database.db
      .insert(lunaSchema.sessions)
      .values({
        id: "session-task-launch-context",
        surface_key: "feishu:task-launch-context",
        channel_type: "feishu",
        channel_id: "task-launch-context",
        group_id: null,
        thread_key: null,
        root_message_key: null,
        title: "task launch context",
        created_at: 1000,
        updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","task-launch-context")})
      .run();
    const taskId = _createTask("task-supervisor-launch-context", "session-task-launch-context");
    const messageStore = new MessageStore(database.db);
    const sourceMessage = messageStore.append({
      sessionId: "session-task-launch-context",
      channelMessageKey: "message-source-context",
      senderUserId: "user-1",
      role: "user",
      content: [{ type: "text", text: "source message: 用户反馈播放失败 did=123" }],
      channel: { type: "feishu", id: "task-launch-context" },
      sender: { externalId: "user-1", kind: "user" },
      createdAt: 1001,
    });
    const turnContextMessage = messageStore.append({
      sessionId: "session-task-launch-context",
      channelMessageKey: "message-turn-context",
      senderUserId: "user-2",
      role: "user",
      content: [{ type: "text", text: "source turn context: 只影响 Android 端" }],
      channel: { type: "feishu", id: "task-launch-context" },
      sender: { externalId: "user-2", kind: "user" },
      createdAt: 1002,
    });
    const sourceEntry = _entryIdForMessage(sourceMessage.id);
    const turnContextEntry = _entryIdForMessage(turnContextMessage.id);
    const contextPackStore = new ContextPackStore(database.db);
    const launchPack = contextPackStore.createPack({
      ownerType: "task",
      ownerId: taskId,
      kind: "task_launch",
      selectionStrategy: "source_turn",
      triggerEntryId: sourceEntry,
      triggerMessageId: sourceMessage.id,
      createdAt: 1010,
    });
    const launchItems = contextPackStore.addItems(launchPack.id, [
      {
        itemKind: "message",
        itemId: sourceMessage.id,
        sourceSessionId: "session-task-launch-context",
        sourceEntryId: sourceEntry,
        sourceMessageId: sourceMessage.id,
        role: "source",
        reason: "task source message",
      },
      {
        itemKind: "timeline_entry",
        itemId: turnContextEntry,
        sourceSessionId: "session-task-launch-context",
        sourceEntryId: turnContextEntry,
        sourceMessageId: turnContextMessage.id,
        role: "launch_context",
        reason: "source turn context",
      },
    ]);
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
    });

    const startedRun = supervisor.startInitialRun({
      taskId,
      inputSnapshot: {
        prompt: "Investigate current playback failure.",
      },
      sourceMessageId: sourceMessage.id,
    });
    await supervisor.waitForIdle();
    database.db
      .update(lunaSchema.runnerContexts)
      .set({ runner_session_id: "codex-provider-session" })
      .where(eq(lunaSchema.runnerContexts.id, startedRun.runnerContextId!))
      .run();
    supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "用户补充只影响 Android，需要重新排查。",
      updateSummary: "补充信息：只影响 Android 端。",
      inputSnapshot: {
        prompt: "Restart with Android-only scope.",
      },
      sourceMessageId: turnContextMessage.id,
    });
    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    const seedRecords = contextPackStore.listSeedRecords("task", taskId);
    const updatePack = contextPackStore
      .listPacksForOwner("task", taskId)
      .find((pack) => pack.kind === "task_update");
    expect(updatePack).toMatchObject({
      ownerType: "task",
      ownerId: taskId,
      kind: "task_update",
      selectionStrategy: "task_restart",
      triggerMessageId: turnContextMessage.id,
    });
    expect(contextPackStore.listItemsForPack(updatePack!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "source",
          reason: "task update source message",
          sourceMessageId: turnContextMessage.id,
          sourceEntryId: turnContextEntry,
        }),
        expect.objectContaining({
          role: "delta_context",
          reason: "latest restart context",
          sourceMessageId: turnContextMessage.id,
          sourceEntryId: turnContextEntry,
        }),
      ]),
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      id: startedRun.id,
      inputSnapshot: {
        prompt: "Investigate current playback failure.",
        contextPackIds: [launchPack.id],
      },
    });
    expect(runs[0]?.materializedPrompt).toContain("Launch context:");
    expect(runs[0]?.materializedPrompt).toContain("role=source");
    expect(runs[0]?.materializedPrompt).toContain("source message: 用户反馈播放失败 did=123");
    expect(runs[0]?.materializedPrompt).toContain("role=launch_context");
    expect(runs[0]?.materializedPrompt).toContain("source turn context: 只影响 Android 端");
    expect(runs[0]?.materializedPrompt).toContain(
      "New user input:\nInvestigate current playback failure.",
    );
    expect(runs[1]).toMatchObject({
      inputSnapshot: {
        prompt: "Restart with Android-only scope.",
        contextPackIds: [launchPack.id, updatePack!.id],
      },
    });
    expect(runs[1]?.materializedPrompt).toContain("Update context:");
    expect(runs[1]?.materializedPrompt).toContain("latest restart context");
    expect(runs[1]?.materializedPrompt).not.toContain("Launch context:");
    expect(runs[1]?.materializedPrompt).toContain("source turn context: 只影响 Android 端");
    expect(seedRecords).toHaveLength(1);
    expect(seedRecords[0]).toMatchObject({
      runnerContextId: runs[0]?.runnerContextId,
      ownerType: "task",
      ownerId: taskId,
      seedContextPackId: launchPack.id,
    });
    expect(seedRecords[0]?.seedEntryIdsJson).toEqual([
      sourceEntry,
      turnContextEntry,
    ]);
    expect(seedRecords[0]?.seedContextItemIdsJson).toEqual(
      launchItems.map((item) => item.id),
    );
    expect(
      contextPackStore.findTaskIdForSourceMessage(turnContextMessage.id),
    ).toBe(taskId);
  });

  test("restartTaskRun repairs an existing empty task_update pack", async () => {
    fixtureNamedSession(database.db, "session-repair-empty-update-pack", "user-1");
    const taskId = _createTask("task-supervisor-restart-repairs-empty-update-pack", "session-repair-empty-update-pack");
    const messageStore = new MessageStore(database.db);
    const updateMessage = messageStore.append({
      sessionId: "session-repair-empty-update-pack",
      channelMessageKey: "message-repair-empty-update-pack",
      senderUserId: "user-2",
      role: "user",
      content: [{ type: "text", text: "补充信息：只影响 Android 端。" }],
      channel: { type: "feishu", id: "repair-empty-update-pack" },
      sender: { externalId: "user-2", kind: "user" },
      createdAt: 1100,
    });
    const updateEntry = _entryIdForMessage(updateMessage.id);
    const contextPackStore = new ContextPackStore(database.db);
    const emptyPack = contextPackStore.createPack({
      ownerType: "task",
      ownerId: taskId,
      kind: "task_update",
      selectionStrategy: "task_restart",
      triggerEntryId: updateEntry,
      triggerMessageId: updateMessage.id,
      metadataJson: {
        updateSummary: "补充信息：只影响 Android 端。",
        updatedTaskSummary: "用户补充只影响 Android，需要重新排查。",
      },
    });
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
    });

    supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "用户补充只影响 Android，需要重新排查。",
      updateSummary: "补充信息：只影响 Android 端。",
      inputSnapshot: {
        prompt: "Restart with Android-only scope.",
      },
      sourceMessageId: updateMessage.id,
    });
    await supervisor.waitForIdle();

    const repairedItems = contextPackStore.listItemsForPack(emptyPack.id);
    expect(repairedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "source",
          sourceMessageId: updateMessage.id,
          sourceEntryId: updateEntry,
        }),
        expect.objectContaining({
          role: "delta_context",
          sourceMessageId: updateMessage.id,
          sourceEntryId: updateEntry,
        }),
      ]),
    );
    expect(
      contextPackStore.findTaskIdForSourceMessage(updateMessage.id),
    ).toBe(taskId);
    expect(store.listRunsForTask(taskId)[0]?.inputSnapshot).toMatchObject({
      contextPackIds: [emptyPack.id],
    });
    expect(store.listRunsForTask(taskId)[0]?.materializedPrompt).toContain(
      "Update context:",
    );
  });

  test("task launch source turn context excludes output entries", () => {
    fixtureNamedSession(database.db, "session-launch-excludes-output", "user-1");
    const taskId = _createTask("task-supervisor-launch-excludes-output", "session-launch-excludes-output");
    const messageStore = new MessageStore(database.db);
    const turnStore = new SessionTurnStore(database.db);
    const sourceMessage = messageStore.append({
      sessionId: "session-launch-excludes-output",
      channelMessageKey: "message-launch-source",
      senderUserId: "user-1",
      role: "user",
      content: [{ type: "text", text: "source message: 建个任务" }],
      channel: { type: "feishu", id: "launch-excludes-output" },
      sender: { externalId: "user-1", kind: "user" },
      createdAt: 1200,
    });
    const coalescedMessage = messageStore.append({
      sessionId: "session-launch-excludes-output",
      channelMessageKey: "message-launch-context",
      senderUserId: "user-1",
      role: "user",
      content: [{ type: "text", text: "input context: 带上这条补充" }],
      channel: { type: "feishu", id: "launch-excludes-output" },
      sender: { externalId: "user-1", kind: "user" },
      createdAt: 1201,
    });
    const outputMessage = messageStore.append({
      sessionId: "session-launch-excludes-output",
      channelMessageKey: "message-launch-output",
      senderUserId: "bot-1",
      role: "assistant",
      content: [{ type: "text", text: "output message: 已创建任务" }],
      channel: { type: "feishu", id: "launch-excludes-output" },
      sender: { externalId: "bot-1", kind: "bot" },
      createdAt: 1202,
    });
    const sourceEntry = _entryIdForMessage(sourceMessage.id);
    const coalescedEntry = _entryIdForMessage(coalescedMessage.id);
    const outputEntry = _entryIdForMessage(outputMessage.id);
    const turn = turnStore.createExecutionTurn({
      sessionId: "session-launch-excludes-output",
      triggerEntryId: sourceEntry,
      reason: "addressed",
    });
    turnStore.attachEntries(turn.id, [
      { entryId: coalescedEntry, role: "coalesced_input" },
      { entryId: outputEntry, role: "output" },
    ]);
    const contextPackStore = new ContextPackStore(database.db);

    contextPackStore.appendTaskSourceItem({
      taskId,
      sessionId: "session-launch-excludes-output",
      messageId: sourceMessage.id,
      userId: "user-1",
    });

    const launchPack = contextPackStore
      .listPacksForOwner("task", taskId)
      .find((pack) => pack.kind === "task_launch");
    const items = contextPackStore.listItemsForPack(launchPack!.id);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "launch_context",
          sourceEntryId: coalescedEntry,
        }),
      ]),
    );
    expect(
      items.some(
        (item) =>
          item.role === "launch_context" && item.sourceEntryId === outputEntry,
      ),
    ).toBe(false);
  });

  test("success emits started and completed timeline events with run metadata", async () => {
    const taskId = _createTask("task-supervisor-timeline");
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
    });
    const startedRun = supervisor.startInitialRun({
      taskId,
      inputSnapshot: { prompt: "Investigate elevated error rate." },
    });

    await supervisor.waitForIdle();

    const events = database.db
      .select()
      .from(lunaSchema.timelineEvents)
      .where(eq(lunaSchema.timelineEvents.task_id, taskId))
      .orderBy(asc(lunaSchema.timelineEvents.created_at))
      .all();

    expect(events.map((event) => event.type)).toEqual([
      "runner.started",
      "runner.completed",
    ]);
    expect(events[0]?.data).toMatchObject({
      taskRunId: startedRun.id,
      runIndex: 1,
      runReason: "initial",
      runnerType: "mock",
    });
    expect(events[1]?.data).toMatchObject({
      taskRunId: startedRun.id,
      runIndex: 1,
      runReason: "initial",
      runnerType: "mock",
    });
  });

  test("executeTaskRun timeline metadata includes taskRunId even when runIndex is absent", async () => {
    const taskId = _createTask("task-execute-run-metadata-task-run-id");
    const runnerContext = new RunnerContextStore(database.db)
      .resolveForTask(taskId, "mock");

    await executeTaskRun({
      db: database.db,
      taskRunId: "task-run-direct-no-index",
      taskId,
      reason: "initial",
      inputSnapshot: { prompt: "Run directly without a persisted run index." },
      runnerType: "mock",
      runnerContext,
    });

    const events = database.db
      .select()
      .from(lunaSchema.timelineEvents)
      .where(eq(lunaSchema.timelineEvents.task_id, taskId))
      .orderBy(asc(lunaSchema.timelineEvents.created_at))
      .all();

    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({
        taskRunId: "task-run-direct-no-index",
        runReason: "initial",
        runnerType: "mock",
      }),
      expect.objectContaining({
        taskRunId: "task-run-direct-no-index",
        runReason: "initial",
        runnerType: "mock",
      }),
    ]);
    expect(events[0]?.data).not.toHaveProperty("runIndex");
  });

  test("failure marks run and task failed and invokes result callback", async () => {
    const taskId = _createTask("task-supervisor-failure");
    const taskResults: TaskResultForMainRunner[] = [];
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      executeRun: async () => { throw new Error("Fixture runner failed"); },
      onTaskResult: (result) => {
        taskResults.push(result);
      },
    });
    const startedRun = supervisor.startInitialRun({
      taskId,
      inputSnapshot: { prompt: "This runner type should fail." },
    });

    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    const taskRow = database.db
      .select()
      .from(lunaSchema.tasks)
      .where(eq(lunaSchema.tasks.id, taskId))
      .get();
    const failedEvent = database.db
      .select()
      .from(lunaSchema.timelineEvents)
      .where(
        and(
          eq(lunaSchema.timelineEvents.task_id, taskId),
          eq(lunaSchema.timelineEvents.type, "runner.failed"),
        ),
      )
      .get();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: startedRun.id,
      status: "failed",
      error: "Fixture runner failed",
      finalReportArtifactId: null,
    });
    expect(store.getActiveRunForTask(taskId)).toBeUndefined();
    expect(taskRow?.status).toBe("failed");
    expect(failedEvent).toMatchObject({
      task_id: taskId,
      type: "runner.failed",
    });
    expect(failedEvent?.data).toMatchObject({
      taskRunId: startedRun.id,
      runIndex: 1,
      runReason: "initial",
      runnerType: "mock",
      error: "Fixture runner failed",
    });
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]).toMatchObject({
      taskId,
      status: "failed",
      userVisibleReport:
        "Task runner failed: Fixture runner failed",
      artifactIds: [],
      nextActions: [],
    });
  });

  test("recovery marks non-terminal tasks with running Task Runs failed", async () => {
    const taskId = _createTask("task-supervisor-recover-running");
    const taskResults: TaskResultForMainRunner[] = [];
    const runnerContext = new RunnerContextStore(database.db).resolveForTask(
      taskId,
      "mock",
    );
    const run = store.createRun({
      taskId,
      reason: "initial",
      inputSnapshot: { prompt: "Runtime died after dispatch." },
      runnerType: "mock",
      runnerContextId: runnerContext.id,
      sourceMessageId: "message-before-crash",
      startedAt: 700,
    });
    database.db
      .update(lunaSchema.tasks)
      .set({ status: "running" })
      .where(eq(lunaSchema.tasks.id, taskId))
      .run();
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      onTaskResult: (result) => {
        taskResults.push(result);
      },
    });

    await expect(supervisor.recoverRunningRuns()).resolves.toBe(1);

    const runs = store.listRunsForTask(taskId);
    const taskRow = database.db
      .select()
      .from(lunaSchema.tasks)
      .where(eq(lunaSchema.tasks.id, taskId))
      .get();
    const failedEvent = database.db
      .select()
      .from(lunaSchema.timelineEvents)
      .where(
        and(
          eq(lunaSchema.timelineEvents.task_id, taskId),
          eq(lunaSchema.timelineEvents.type, "runner.failed"),
        ),
      )
      .get();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: run.id,
      status: "failed",
      error: "Runtime recovered an interrupted running Task Run.",
    });
    expect(store.getActiveRunForTask(taskId)).toBeUndefined();
    expect(taskRow?.status).toBe("failed");
    expect(failedEvent).toMatchObject({
      task_id: taskId,
      type: "runner.failed",
      summary: "Task runner interrupted by runtime recovery.",
    });
    expect(failedEvent?.data).toMatchObject({
      taskRunId: run.id,
      runIndex: 1,
      runReason: "initial",
      runnerType: "mock",
      sourceMessageId: "message-before-crash",
      recoveryReason: "Runtime recovered an interrupted running Task Run.",
      recoveredFrom: "runtime_startup",
    });
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]).toMatchObject({
      taskId,
      status: "failed",
      userVisibleReport:
        "Task runner interrupted by runtime recovery. The Task failed instead of being rerun automatically.",
      nextActions: [],
    });
  });

  test("recovery aligns task status to failed running run even when previous task status was completed", async () => {
    const taskId = _createTask("task-supervisor-recover-completed-task");
    const taskResults: TaskResultForMainRunner[] = [];
    const runnerContext = new RunnerContextStore(database.db).resolveForTask(
      taskId,
      "mock",
    );
    const run = store.createRun({
      taskId,
      reason: "restart",
      inputSnapshot: { prompt: "Runtime died after restart dispatch." },
      runnerType: "mock",
      runnerContextId: runnerContext.id,
      sourceMessageId: "message-restart-before-crash",
      startedAt: 800,
    });
    database.db
      .update(lunaSchema.tasks)
      .set({ status: "completed" })
      .where(eq(lunaSchema.tasks.id, taskId))
      .run();
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      onTaskResult: (result) => {
        taskResults.push(result);
      },
    });

    await expect(supervisor.recoverRunningRuns()).resolves.toBe(1);

    const runs = store.listRunsForTask(taskId);
    const taskRow = database.db
      .select()
      .from(lunaSchema.tasks)
      .where(eq(lunaSchema.tasks.id, taskId))
      .get();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: run.id,
      status: "failed",
      reason: "restart",
      error: "Runtime recovered an interrupted running Task Run.",
    });
    expect(taskRow?.status).toBe("failed");
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]).toMatchObject({
      taskId,
      status: "failed",
      userVisibleReport:
        "Task runner interrupted by runtime recovery. The Task failed instead of being rerun automatically.",
      nextActions: [],
    });
  });

  test("waitForIdle waits for asynchronous initial run completion", async () => {
    const taskId = _createTask("task-supervisor-idle");
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
    });

    supervisor.startInitialRun({
      taskId,
      inputSnapshot: { prompt: "Verify idle waits for runner completion." },
    });
    expect(store.listRunsForTask(taskId)[0]?.status).toBe("running");

    await supervisor.waitForIdle();

    expect(store.listRunsForTask(taskId)[0]?.status).toBe("completed");
  });

  test("progress notification failure does not keep an initial run running", async () => {
    const taskId = _createTask("task-supervisor-progress-isolated");
    const taskResults: TaskResultForMainRunner[] = [];
    let progressCallCount = 0;
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      runNotifications: {
        onRunProgress: () => {
          progressCallCount += 1;
          throw new Error("progress status card update failed");
        },
      },
      onTaskResult: (result) => {
        taskResults.push(result);
      },
    });
    const startedRun = supervisor.startInitialRun({
      taskId,
      inputSnapshot: {
        prompt: "Callback failure must not affect task run lifecycle.",
      },
    });

    await expect(supervisor.waitForIdle()).resolves.toBeUndefined();

    const runs = store.listRunsForTask(taskId);
    const taskRow = database.db
      .select()
      .from(lunaSchema.tasks)
      .where(eq(lunaSchema.tasks.id, taskId))
      .get();
    expect(progressCallCount).toBeGreaterThan(0);
    expect(runs[0]).toMatchObject({
      id: startedRun.id,
      status: "completed",
      error: null,
    });
    expect(store.getActiveRunForTask(taskId)).toBeUndefined();
    expect(taskRow?.status).toBe("completed");
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]).toMatchObject({
      taskId,
      status: "completed",
    });
  });

  test("restartTaskRun cancels obsolete wrong-DID run and completes corrected run", async () => {
    const taskId = _createTask("task-supervisor-restart-corrected-did");
    const updateMessageId = _taskMessage("message-corrected-did");
    const initialMessageId = _taskMessage("message-old-did");
    const taskResults: TaskResultForMainRunner[] = [];
    const firstRunStarted = _deferred<void>();
    const firstRunRelease = _deferred<ExecuteTaskRunResult>();
    const secondRunStarted = _deferred<void>();
    const executorInputs: ExecuteTaskRunInput[] = [];
    const timeline = new TimelineStore(database.db);
    const artifacts = new ArtifactStore(database.db);
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      onTaskResult: (result) => {
        taskResults.push(result);
      },
      executeRun: async (input) => {
        executorInputs.push(input);
        timeline.append({
          taskId: input.taskId,
          type: "runner.started",
          summary: `Started controlled run ${input.runIndex}.`,
          data: {
            taskRunId: input.taskRunId,
            runIndex: input.runIndex,
            runReason: input.reason,
            runnerType: input.runnerType,
            ...(input.sourceMessageId !== undefined
              ? { sourceMessageId: input.sourceMessageId }
              : {}),
          },
        });

        if (input.runIndex === 1) {
          firstRunStarted.resolve();
          return await firstRunRelease.promise;
        }

        secondRunStarted.resolve();
        const artifact = artifacts.create({
          taskId: input.taskId,
          type: "report",
          name: "final-report.md",
          mimeType: "text/markdown",
          content: "# Corrected DID report\n\nDID=corrected-did",
        });
        timeline.append({
          taskId: input.taskId,
          type: "runner.completed",
          summary: `Completed controlled run ${input.runIndex}.`,
          data: {
            taskRunId: input.taskRunId,
            runIndex: input.runIndex,
            runReason: input.reason,
            runnerType: input.runnerType,
          },
        });
        return { finalReportArtifactId: artifact.id };
      },
    });

    const firstRun = supervisor.startInitialRun({
      taskId,
      inputSnapshot: { did: "old-did" },
      sourceMessageId: initialMessageId,
    });
    await firstRunStarted.promise;

    const restartedRun = supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "用户更正 DID=corrected-did，需要重新排查。",
      updateSummary: "DID 从 old-did 更正为 corrected-did。",
      inputSnapshot: { did: "corrected-did" },
      sourceMessageId: updateMessageId,
      cancelReason: "Superseded by corrected DID.",
    });
    await secondRunStarted.promise;
    firstRunRelease.resolve({ finalReportArtifactId: "stale-old-report" });
    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    const taskRow = database.db
      .select()
      .from(lunaSchema.tasks)
      .where(eq(lunaSchema.tasks.id, taskId))
      .get();
    const events = database.db
      .select()
      .from(lunaSchema.timelineEvents)
      .where(eq(lunaSchema.timelineEvents.task_id, taskId))
      .orderBy(asc(lunaSchema.timelineEvents.created_at))
      .all();

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      id: firstRun.id,
      runIndex: 1,
      reason: "initial",
      status: "cancelled",
      inputSnapshot: { did: "old-did" },
      cancelReason: "Superseded by corrected DID.",
      finalReportArtifactId: null,
    });
    expect(runs[1]).toMatchObject({
      id: restartedRun.id,
      runIndex: 2,
      reason: "restart",
      status: "completed",
      inputSnapshot: { did: "corrected-did" },
      sourceMessageId: updateMessageId,
    });
    expect(runs[1]?.finalReportArtifactId).toBeString();
    expect(taskRow).toMatchObject({
      status: "completed",
      summary: "用户更正 DID=corrected-did，需要重新排查。",
    });
    expect(taskRow?.context_json).toMatchObject({
      currentSummary: "用户更正 DID=corrected-did，需要重新排查。",
      latestUserMessage: "DID 从 old-did 更正为 corrected-did。",
    });
    expect(executorInputs.map((input) => input.inputSnapshot)).toEqual([
      { did: "old-did" },
      {
        did: "corrected-did",
        contextPackIds: expect.any(Array),
      },
    ]);
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]).toMatchObject({
      taskId,
      status: "completed",
      userVisibleReport: expect.stringContaining("DID=corrected-did"),
      artifactIds: [runs[1]?.finalReportArtifactId],
    });
    expect(events.map((event) => event.type)).toEqual([
      "runner.started",
      "context.updated",
      "runner.cancelled",
      "runner.started",
      "runner.completed",
    ]);
    expect(events[1]).toMatchObject({
      type: "context.updated",
      summary: "DID 从 old-did 更正为 corrected-did。",
      message_id: updateMessageId,
    });
    expect(events[2]?.data).toMatchObject({
      taskRunId: firstRun.id,
      runIndex: 1,
      runReason: "initial",
      runnerType: "mock",
      cancelReason: "Superseded by corrected DID.",
    });
    expect(events[3]?.data).toMatchObject({
      taskRunId: restartedRun.id,
      runIndex: 2,
      runReason: "restart",
      sourceMessageId: updateMessageId,
    });
  });

  test("restartTaskRun proceeds when context.updated exists without a restart row", async () => {
    const taskId = _createTask("task-supervisor-restart-crash-window");
    const updateMessageId = _taskMessage("message-crash-window-restart");
    const initialMessageId = _taskMessage("message-obsolete-did");
    const firstRunStarted = _deferred<void>();
    const firstRunRelease = _deferred<ExecuteTaskRunResult>();
    const executorInputs: ExecuteTaskRunInput[] = [];
    const artifacts = new ArtifactStore(database.db);
    const timeline = new TimelineStore(database.db);
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      executeRun: async (input) => {
        executorInputs.push(input);
        if (input.runIndex === 1) {
          firstRunStarted.resolve();
          return await firstRunRelease.promise;
        }

        const artifact = artifacts.create({
          taskId: input.taskId,
          type: "report",
          name: "final-report.md",
          mimeType: "text/markdown",
          content: "# Restarted after crash-window event",
        });
        return { finalReportArtifactId: artifact.id };
      },
    });

    const firstRun = supervisor.startInitialRun({
      taskId,
      inputSnapshot: { did: "obsolete-did" },
      sourceMessageId: initialMessageId,
    });
    await firstRunStarted.promise;
    timeline.append({
      taskId,
      messageId: updateMessageId,
      type: "context.updated",
      summary: "DID 从 obsolete-did 更正为 corrected-did。",
      data: {
        sourceMessageId: updateMessageId,
      },
    });

    const restartedRun = supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "使用 corrected-did 重新排查。",
      updateSummary: "DID 从 obsolete-did 更正为 corrected-did。",
      inputSnapshot: { did: "corrected-did" },
      sourceMessageId: updateMessageId,
    });
    firstRunRelease.resolve({ finalReportArtifactId: "obsolete-report" });
    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    const contextUpdatedEvents = database.db
      .select()
      .from(lunaSchema.timelineEvents)
      .where(
        and(
          eq(lunaSchema.timelineEvents.task_id, taskId),
          eq(lunaSchema.timelineEvents.type, "context.updated"),
        ),
      )
      .all();

    expect(restartedRun.id).not.toBe(firstRun.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual([
      "cancelled",
      "completed",
    ]);
    expect(runs[1]).toMatchObject({
      id: restartedRun.id,
      reason: "restart",
      sourceMessageId: updateMessageId,
      inputSnapshot: { did: "corrected-did" },
    });
    expect(executorInputs.map((input) => input.runIndex)).toEqual([1, 2]);
    expect(contextUpdatedEvents).toHaveLength(1);
  });

  test("restartTaskRun is idempotent for duplicate restart delivery", async () => {
    const taskId = _createTask("task-supervisor-duplicate-restart-delivery");
    const updateMessageId = _taskMessage("message-duplicate-delivery");
    const firstRunStarted = _deferred<void>();
    const firstRunRelease = _deferred<ExecuteTaskRunResult>();
    const restartedRunStarted = _deferred<void>();
    const restartedRunRelease = _deferred<ExecuteTaskRunResult>();
    const executorInputs: ExecuteTaskRunInput[] = [];
    const artifacts = new ArtifactStore(database.db);
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      executeRun: async (input) => {
        executorInputs.push(input);
        if (input.runIndex === 1) {
          firstRunStarted.resolve();
          return await firstRunRelease.promise;
        }

        restartedRunStarted.resolve();
        await restartedRunRelease.promise;
        const artifact = artifacts.create({
          taskId: input.taskId,
          type: "report",
          name: "final-report.md",
          mimeType: "text/markdown",
          content: "# Deduplicated restarted report",
        });
        return { finalReportArtifactId: artifact.id };
      },
    });

    supervisor.startInitialRun({
      taskId,
      inputSnapshot: { did: "obsolete-did" },
    });
    await firstRunStarted.promise;

    const restartedRun = supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "使用 corrected-did 重新排查。",
      updateSummary: "用户更正 DID。",
      inputSnapshot: { did: "corrected-did" },
      sourceMessageId: updateMessageId,
    });
    await restartedRunStarted.promise;
    const duplicateRun = supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "使用 corrected-did 重新排查。",
      updateSummary: "用户更正 DID。",
      inputSnapshot: { did: "corrected-did" },
      sourceMessageId: updateMessageId,
    });
    firstRunRelease.resolve({ finalReportArtifactId: "obsolete-report" });
    restartedRunRelease.resolve({
      finalReportArtifactId: "unused-release-report",
    });
    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    const contextUpdatedEvents = database.db
      .select()
      .from(lunaSchema.timelineEvents)
      .where(
        and(
          eq(lunaSchema.timelineEvents.task_id, taskId),
          eq(lunaSchema.timelineEvents.type, "context.updated"),
        ),
      )
      .all();

    expect(duplicateRun.id).toBe(restartedRun.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual([
      "cancelled",
      "completed",
    ]);
    expect(executorInputs.map((input) => input.runIndex)).toEqual([1, 2]);
    expect(contextUpdatedEvents).toHaveLength(1);
  });

  test("cancelled run failure cannot overwrite restarted run status or result", async () => {
    const taskId = _createTask("task-supervisor-stale-cancelled-run");
    const updateMessageId = _taskMessage("message-stale-guard");
    const taskResults: TaskResultForMainRunner[] = [];
    const firstRunStarted = _deferred<void>();
    const firstRunFailure = _deferred<ExecuteTaskRunResult>();
    const secondRunStarted = _deferred<void>();
    const timeline = new TimelineStore(database.db);
    const artifacts = new ArtifactStore(database.db);
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      onTaskResult: (result) => {
        taskResults.push(result);
      },
      executeRun: async (input) => {
        timeline.append({
          taskId: input.taskId,
          type: "runner.started",
          summary: `Started controlled run ${input.runIndex}.`,
          data: {
            taskRunId: input.taskRunId,
            runIndex: input.runIndex,
            runReason: input.reason,
            runnerType: input.runnerType,
          },
        });

        if (input.runIndex === 1) {
          firstRunStarted.resolve();
          return await firstRunFailure.promise;
        }

        secondRunStarted.resolve();
        const artifact = artifacts.create({
          taskId: input.taskId,
          type: "report",
          name: "final-report.md",
          mimeType: "text/markdown",
          content: "# Restarted run report",
        });
        return { finalReportArtifactId: artifact.id };
      },
    });

    supervisor.startInitialRun({
      taskId,
      inputSnapshot: { did: "obsolete-did" },
    });
    await firstRunStarted.promise;

    supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "使用 corrected-did 重新排查。",
      updateSummary: "用户更正 DID。",
      inputSnapshot: { did: "corrected-did" },
      sourceMessageId: updateMessageId,
    });
    await secondRunStarted.promise;
    firstRunFailure.reject(new Error("obsolete runner crashed after cancel"));
    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    const taskRow = database.db
      .select()
      .from(lunaSchema.tasks)
      .where(eq(lunaSchema.tasks.id, taskId))
      .get();
    const failedEvents = database.db
      .select()
      .from(lunaSchema.timelineEvents)
      .where(
        and(
          eq(lunaSchema.timelineEvents.task_id, taskId),
          eq(lunaSchema.timelineEvents.type, "runner.failed"),
        ),
      )
      .all();

    expect(runs.map((run) => run.status)).toEqual(["cancelled", "completed"]);
    expect(runs[0]).toMatchObject({
      error: null,
      finalReportArtifactId: null,
    });
    expect(taskRow?.status).toBe("completed");
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]).toMatchObject({
      status: "completed",
      userVisibleReport: expect.stringContaining("Restarted run report"),
    });
    expect(failedEvents).toHaveLength(0);
  });

  test("restarted result ignores stale report artifact written by cancelled run", async () => {
    const taskId = _createTask("task-supervisor-stale-report-selection");
    const updateMessageId = _taskMessage("message-stale-report-selection");
    const taskResults: TaskResultForMainRunner[] = [];
    const firstRunStarted = _deferred<void>();
    const releaseFirstRun = _deferred<void>();
    const staleReportWritten = _deferred<void>();
    const secondRunStarted = _deferred<void>();
    const artifacts = new ArtifactStore(database.db);
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      onTaskResult: (result) => {
        taskResults.push(result);
      },
      executeRun: async (input) => {
        if (input.runIndex === 1) {
          firstRunStarted.resolve();
          await releaseFirstRun.promise;
          const staleArtifact = artifacts.create({
            taskId: input.taskId,
            type: "report",
            name: "final-report.md",
            mimeType: "text/markdown",
            content: "# Stale cancelled report\n\nDID=obsolete-did",
          });
          database.db
            .update(lunaSchema.artifacts)
            .set({ created_at: 100 })
            .where(eq(lunaSchema.artifacts.id, staleArtifact.id))
            .run();
          staleReportWritten.resolve();
          return { finalReportArtifactId: staleArtifact.id };
        }

        secondRunStarted.resolve();
        await staleReportWritten.promise;
        const correctedArtifact = artifacts.create({
          taskId: input.taskId,
          type: "report",
          name: "final-report.md",
          mimeType: "text/markdown",
          content: "# Corrected restarted report\n\nDID=corrected-did",
        });
        database.db
          .update(lunaSchema.artifacts)
          .set({ created_at: 200 })
          .where(eq(lunaSchema.artifacts.id, correctedArtifact.id))
          .run();
        return { finalReportArtifactId: correctedArtifact.id };
      },
    });

    const firstRun = supervisor.startInitialRun({
      taskId,
      inputSnapshot: { did: "obsolete-did" },
    });
    await firstRunStarted.promise;

    const restartedRun = supervisor.restartTaskRun({
      taskId,
      updatedTaskSummary: "使用 corrected-did 重新排查。",
      updateSummary: "用户更正 DID。",
      inputSnapshot: { did: "corrected-did" },
      sourceMessageId: updateMessageId,
    });
    await secondRunStarted.promise;
    releaseFirstRun.resolve();
    await supervisor.waitForIdle();

    const runs = store.listRunsForTask(taskId);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      id: firstRun.id,
      status: "cancelled",
      finalReportArtifactId: null,
    });
    expect(runs[1]).toMatchObject({
      id: restartedRun.id,
      status: "completed",
    });
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]?.userVisibleReport).toContain("DID=corrected-did");
    expect(taskResults[0]?.userVisibleReport).not.toContain(
      "DID=obsolete-did",
    );
    const restartedReportArtifactId = runs[1]?.finalReportArtifactId;
    if (
      restartedReportArtifactId === null ||
      restartedReportArtifactId === undefined
    ) {
      throw new Error(
        "Restarted run did not persist a final report artifact id.",
      );
    }
    expect(taskResults[0]?.artifactIds).toEqual([restartedReportArtifactId]);
  });

  test("result builder defaults to latest completed run report and scoped evidence", () => {
    const taskId = _createTask("task-supervisor-latest-completed-result");
    const artifacts = new ArtifactStore(database.db);
    const timeline = new TimelineStore(database.db);
    const staleArtifact = artifacts.create({
      taskId,
      type: "report",
      name: "final-report.md",
      mimeType: "text/markdown",
      content: "# Stale cancelled report\n\nDID=obsolete-did",
    });
    const currentArtifact = artifacts.create({
      taskId,
      type: "report",
      name: "final-report.md",
      mimeType: "text/markdown",
      content: "# Current completed report\n\nDID=corrected-did",
    });
    const cancelledRun = store.createRun({
      taskId,
      reason: "initial",
      inputSnapshot: { did: "obsolete-did" },
      runnerType: "mock",
    });
    store.markCancelled(cancelledRun.id, {
      cancelReason: "corrected DID",
    });
    const completedRun = store.createRun({
      taskId,
      reason: "restart",
      inputSnapshot: { did: "corrected-did" },
      runnerType: "mock",
    });
    store.markCompleted(completedRun.id, {
      finalReportArtifactId: currentArtifact.id,
    });
    timeline.append({
      taskId,
      type: "runner.step",
      summary: "obsolete run queried did=obsolete-did",
      data: {
        taskRunId: cancelledRun.id,
        runIndex: 1,
        runReason: "initial",
        runnerType: "mock",
      },
    });
    timeline.append({
      taskId,
      type: "runner.step",
      summary: "current run queried did=corrected-did",
      data: {
        taskRunId: completedRun.id,
        runIndex: 2,
        runReason: "restart",
        runnerType: "mock",
      },
    });

    const result = buildTaskResultForMainRunner(
      database.db,
      taskId,
      "completed",
    );

    expect(result.userVisibleReport).toContain("DID=corrected-did");
    expect(result.userVisibleReport).not.toContain("DID=obsolete-did");
    expect(result.artifactIds).toEqual([currentArtifact.id]);
    expect(result.artifactIds).not.toContain(staleArtifact.id);
    expect(result.evidenceSummary).toEqual([
      "current run queried did=corrected-did",
    ]);
  });

  test("result builder uses the explicit completed Task Run report", () => {
    const taskId = _createTask("task-supervisor-explicit-run-report");
    const artifacts = new ArtifactStore(database.db);
    const firstReport = artifacts.create({
      taskId,
      type: "report",
      name: "final-report.md",
      mimeType: "text/markdown",
      content: "# First completed report\n\nDID=first-did",
    });
    const secondReport = artifacts.create({
      taskId,
      type: "report",
      name: "final-report.md",
      mimeType: "text/markdown",
      content: "# Second completed report\n\nDID=second-did",
    });
    const firstRun = store.createRun({
      taskId,
      reason: "initial",
      inputSnapshot: { did: "first-did" },
      runnerType: "mock",
    });
    store.markCompleted(firstRun.id, {
      finalReportArtifactId: firstReport.id,
    });
    const secondRun = store.createRun({
      taskId,
      reason: "restart",
      inputSnapshot: { did: "second-did" },
      runnerType: "mock",
    });
    store.markCompleted(secondRun.id, {
      finalReportArtifactId: secondReport.id,
    });

    const result = buildTaskResultForMainRunner(
      database.db,
      taskId,
      "completed",
      {
        taskRunId: firstRun.id,
        runIndex: firstRun.runIndex,
      },
    );

    expect(result.taskRunId).toBe(firstRun.id);
    expect(result.userVisibleReport).toContain("DID=first-did");
    expect(result.userVisibleReport).not.toContain("DID=second-did");
    expect(result.artifactIds).toEqual([firstReport.id]);
  });

  test("result builder rejects explicit completed Task Run without a report", () => {
    const taskId = _createTask("task-supervisor-explicit-run-missing-report");
    const artifacts = new ArtifactStore(database.db);
    const laterReport = artifacts.create({
      taskId,
      type: "report",
      name: "final-report.md",
      mimeType: "text/markdown",
      content: "# Later report\n\nDID=later-did",
    });
    database.db
      .insert(lunaSchema.taskRuns)
      .values({
        id: "task-run-missing-report",
        task_id: taskId,
        run_index: 1,
        status: "completed",
        reason: "initial",
        input_snapshot: { did: "missing-report" },
        materialized_prompt: null,
        runner_type: "mock",
        runner_context_id: null,
        source_message_id: null,
        started_at: Date.now() - 2,
        finished_at: Date.now() - 1,
        cancel_reason: null,
        error: null,
        final_report_artifact_id: null,
      })
      .run();
    const laterRun = store.createRun({
      taskId,
      reason: "restart",
      inputSnapshot: { did: "later-did" },
      runnerType: "mock",
    });
    store.markCompleted(laterRun.id, {
      finalReportArtifactId: laterReport.id,
    });

    expect(() =>
      buildTaskResultForMainRunner(database.db, taskId, "completed", {
        taskRunId: "task-run-missing-report",
        runIndex: 1,
      })
    ).toThrow("requires a final report artifact");
  });

  test("result builder does not derive conclusion from report markdown", () => {
    const taskId = _createTask("task-supervisor-report-markdown-no-conclusion");
    const artifacts = new ArtifactStore(database.db);
    const reportArtifact = artifacts.create({
      taskId,
      type: "report",
      name: "final-report.md",
      mimeType: "text/markdown",
      content: [
        "老大，检测对象：![image](artifact:img_123)",
        "",
        "**Completed work**",
        "结论：有黄色信息，且不是轻微疑似。",
        "",
        "**Verification**",
        "- 已检查图片。",
      ].join("\n"),
    });
    const completedRun = store.createRun({
      taskId,
      reason: "initial",
      inputSnapshot: { image: "artifact:img_123" },
      runnerType: "mock",
    });
    store.markCompleted(completedRun.id, {
      finalReportArtifactId: reportArtifact.id,
    });

    const result = buildTaskResultForMainRunner(
      database.db,
      taskId,
      "completed",
    );

    expect(result.conclusion).toBeUndefined();
    expect(result.userVisibleReport).toContain("老大，检测对象");
    expect(result.userVisibleReport).toContain("结论：有黄色信息");
  });

  test("failed result does not inherit artifacts from earlier completed runs", () => {
    const taskId = _createTask("task-supervisor-failed-result-artifact-scope");
    const artifacts = new ArtifactStore(database.db);
    const completedReport = artifacts.create({
      taskId,
      type: "report",
      name: "final-report.md",
      mimeType: "text/markdown",
      content: "# Earlier completed report",
    });
    const completedRun = store.createRun({
      taskId,
      reason: "initial",
      inputSnapshot: { text: "first run" },
      runnerType: "mock",
    });
    store.markCompleted(completedRun.id, {
      finalReportArtifactId: completedReport.id,
    });
    const failedRun = store.createRun({
      taskId,
      reason: "restart",
      inputSnapshot: { text: "second run" },
      runnerType: "mock",
    });
    store.markFailed(failedRun.id, { error: "runner failed" });

    const result = buildTaskResultForMainRunner(database.db, taskId, "failed", {
      failureMessage: "Task runner failed: runner failed",
      taskRunId: failedRun.id,
      runIndex: failedRun.runIndex,
    });

    expect(result.artifactIds).toEqual([]);
  });
});

describe("executeTaskRun", () => {
  test("task runner contexts persist provider sessions for both claude and codex", () => {
    const taskId = _createTask("task-provider-runtime");
    const contextStore = new RunnerContextStore(database.db);
    const claudeContext = contextStore.resolveForTask(taskId, "claude");
    const codexContext = contextStore.resolveForTask(taskId, "codex");

    contextStore.persistRunnerSessionId(claudeContext.id, "claude-session-1");
    contextStore.persistRunnerSessionId(codexContext.id, "codex-thread-1");

    const rows = database.db
      .select()
      .from(lunaSchema.runnerContexts)
      .all();
    expect(rows.find((row) => row.id === claudeContext.id)?.runner_session_id)
      .toBe("claude-session-1");
    expect(rows.find((row) => row.id === codexContext.id)?.runner_session_id)
      .toBe("codex-thread-1");
  });

  test("writes Task Runner instructions into runner root before executing", async () => {
    fixtureSessionOwnership(database.db, "feishu", "feishu-main", "user-1");
    const session = new SessionStore(database.db).resolveByChannelSurface({
      channelType: "feishu", channelId: "feishu-main", groupId: "group-task-runner-instructions",
      threadId: "thread-task-runner-instructions", rootMessageId: "root-task-runner-instructions",
    });
    const taskId = _createTask("task-runner-instructions", session.id);
    new TaskSubscriptionStore(database.db).resolve({
      taskId,
      sessionId: session.id,
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-task-runner-instructions",
      threadId: "thread-task-runner-instructions",
      rootMessageId: "root-task-runner-instructions",
      visibility: "full",
    });
    const runnerContext = new RunnerContextStore(database.db).resolveForTask(
      taskId,
      "mock",
    );

    await executeTaskRun({
      db: database.db,
      taskRunId: "task-runner-instructions-run",
      taskId,
      reason: "initial",
      inputSnapshot: { prompt: "用户反馈播放失败，需要排查。" },
      runnerType: "mock",
      runnerContext,
    });

    const claudeMdPath = join(runnerContext.runner_root_path, "CLAUDE.md");
    const agentsMdPath = join(runnerContext.runner_root_path, "AGENTS.md");

    expect(existsSync(claudeMdPath)).toBe(true);
    expect(existsSync(agentsMdPath)).toBe(true);
    expect(readFileSync(claudeMdPath, "utf-8")).toContain(
      "# Task Runner Runtime Prompt",
    );
    expect(readFileSync(claudeMdPath, "utf-8")).not.toContain(
      "@.luna-prompts/task-runner/instructions.md",
    );
    expect(readFileSync(agentsMdPath, "utf-8")).not.toContain(
      "Plugin Skills and Tools",
    );
    expect(readFileSync(agentsMdPath, "utf-8")).toContain(
      "luna artifacts materialize artifact:<id> --json",
    );
    expect(readFileSync(agentsMdPath, "utf-8")).toContain(
      "reference the file only through that ref",
    );
    const agentsMd = readFileSync(agentsMdPath, "utf-8");
    expect(agentsMd).toContain("$HOME/.luna-resources/config/USER.md");
    expect(agentsMd).toContain("$HOME/.luna-resources/config/SOUL.md");
    expect(agentsMd).toContain("$HOME/.luna-resources/memory/");
    expect(agentsMd).toContain("read-only snapshots");
    expect(agentsMd).toContain("Stable Runner Context");
    expect(agentsMd).toContain(".luna/runner-context.json");
    expect(agentsMd).toContain("Per-turn or per-run user input");
    const contextFile = JSON.parse(
      readFileSync(runnerContextFilePath(runnerContext.runner_root_path), "utf-8"),
    );
    expect(contextFile).toMatchObject({
      schemaVersion: 1,
      runnerKind: "task",
      owner: { type: "task", id: taskId },
      stableContext: {
        task: {
          id: taskId,
          type: "task",
          createdByUserId: "user-1",
        },
        deliverySubscriptions: [
          {
            sessionId: session.id,
            channel: { type: "feishu", id: "feishu-main" },
            surface: {
              kind: "group",
              externalId: "group-task-runner-instructions",
            },
            thread: {
              externalId: "root-task-runner-instructions",
              rootMessageExternalId: "root-task-runner-instructions",
            },
            visibility: "full",
          },
        ],
      },
    });
  });

  test("task runner reuses generated instruction files when the fingerprint is unchanged", async () => {
    const taskId = _createTask("task-runner-fingerprint");
    const runnerContext = new RunnerContextStore(database.db).resolveForTask(
      taskId,
      "mock",
    );

    await executeTaskRun({
      db: database.db,
      taskRunId: "task-run-fingerprint-1",
      taskId,
      reason: "initial",
      inputSnapshot: { prompt: "第一次执行" },
      runnerType: "mock",
      runnerContext,
    });

    const claudeMdPath = join(runnerContext.runner_root_path, "CLAUDE.md");
    const before = statSync(claudeMdPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const refreshedRunnerContext = new RunnerContextStore(database.db).resolveForTask(
      taskId,
      "mock",
    );
    await executeTaskRun({
      db: database.db,
      taskRunId: "task-run-fingerprint-2",
      taskId,
      reason: "retry",
      inputSnapshot: { prompt: "第二次执行" },
      runnerType: "mock",
      runnerContext: refreshedRunnerContext,
    });

    expect(statSync(claudeMdPath).mtimeMs).toBe(before);
  });

  test("mock executeTaskRun honors pre-aborted signal before writing final report", async () => {
    const taskId = _createTask("task-mock-aborted-before-write");
    const runnerContext = new RunnerContextStore(database.db).resolveForTask(
      taskId,
      "mock",
    );
    const controller = new AbortController();
    controller.abort("obsolete mock run");

    await expect(
      executeTaskRun({
        db: database.db,
        taskRunId: "task-run-aborted-mock",
        taskId,
        reason: "initial",
        inputSnapshot: { prompt: "This obsolete mock run must not publish." },
        runnerType: "mock",
        runnerContext,
        signal: controller.signal,
      }),
    ).rejects.toThrow("obsolete mock run");

    expect(
      database.db
        .select()
        .from(lunaSchema.artifacts)
        .where(eq(lunaSchema.artifacts.task_id, taskId))
        .all(),
    ).toHaveLength(0);
    expect(
      database.db
        .select()
        .from(lunaSchema.timelineEvents)
        .where(eq(lunaSchema.timelineEvents.task_id, taskId))
        .all(),
    ).toHaveLength(0);
  });
});

function _createTask(taskId: string, sourceSessionId?: string): string {
  const scope = fixtureScope(database.db, "user-1");
  const ownership = sourceSessionId ? fixtureTaskOwnership(database.db, sourceSessionId) : {agent_id: scope.agentId, shadow_id: scope.shadowId};
  const now = Date.now();
  database.db
    .insert(lunaSchema.tasks)
    .values({
      id: taskId,
      type: "task",
      status: "new",
      priority: "medium",
      severity: null,
      title: `Task ${taskId}`,
      summary: "Initial task summary",
      creator_user_id: "user-1",
      context_json: null,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      ...ownership,
    })
    .run();
  return taskId;
}

function _taskMessage(key: string): string {
  const sessionId = "session-" + key;
  fixtureNamedSession(database.db, sessionId, "user-1");
  return new MessageStore(database.db).append({
    sessionId, channelMessageKey: key, senderUserId: "user-1", role: "user",
    content: [{type: "text", text: key}],
  }).id;
}

function _entryIdForMessage(messageId: string): string {
  const entry = database.db
    .select({ id: lunaSchema.sessionTimelineEntries.id })
    .from(lunaSchema.sessionTimelineEntries)
    .where(eq(lunaSchema.sessionTimelineEntries.messageId, messageId))
    .get();
  if (entry === undefined) {
    throw new Error(`Timeline entry for message "${messageId}" was not found.`);
  }
  return entry.id;
}

function _deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

test("Runtime recovery attaches the original Task Run without applying legacy interrupted failure", async () => {
  const { config } = await import("../../src/shared");
  const { InvocationStore } = await import("../../src/runners/invocation-store");
  const { RuntimeDetachedError } = await import("../../src/runners/runtime-detach");
  const descriptor = Object.getOwnPropertyDescriptor(config, "sandbox")!;
  const sandbox = config.sandbox;
  const { writePrivateJson } = await import("@luna/execution-store");
  const runtimeConfigFile = join(testHome, "runtime.json");
  writePrivateJson(runtimeConfigFile, { endpoint: "http://127.0.0.1:9", token: "t".repeat(43), runtimeId: "runtime", environmentId: "luna" });
  Object.defineProperty(config, "sandbox", { configurable: true, get: () => ({ ...sandbox, runtimeConfigFile }) });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const taskId = _createTask("runtime-recover-task");
    const runnerContext = new RunnerContextStore(database.db).resolveForTask(taskId, "mock");
    const run = store.createRun({ taskId, reason: "initial", runnerType: "mock", runnerContextId: runnerContext.id, inputSnapshot: { prompt: "original" } });
    new InvocationStore(database.db).register({ id: "inv_task_resume", runnerKind: "task", actorUserId: "user-1", runnerContextId: runnerContext.id, sessionId: null, taskId, taskRunId: run.id, originId: run.id,
      inputSnapshot: { version: 1, kind: "task", input: { taskId, taskRunId: run.id, runnerContextId: runnerContext.id } } as never, contextPackIds: [] });
    const calls: string[] = [];
    const supervisor = new TaskRunSupervisor({ db: database.db, runnerType: "mock", executeRun: async input => {
      calls.push(input.taskRunId); await gate; throw new RuntimeDetachedError();
    } });
    await supervisor.recoverRunningRuns();
    expect(calls).toEqual([run.id]);
    expect(store.getActiveRunForTask(taskId)?.id).toBe(run.id);
    await supervisor.recoverRunningRuns();
    expect(calls).toHaveLength(1);
    release(); await supervisor.waitForIdle();
    expect(store.getActiveRunForTask(taskId)?.id).toBe(run.id);
  } finally { release(); Object.defineProperty(config, "sandbox", descriptor); }
});

test("explicit cancellation aborts the existing process and revokes its authority before late completion", async () => {
  const {InvocationStore} = await import("../../src/runners/invocation-store");
  const taskId = _createTask("task-explicit-cancel");
  const results: unknown[] = [];
  const notifications: unknown[] = [];
  let signal!: AbortSignal;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const supervisor = new TaskRunSupervisor({db: database.db, runnerType: "mock",
    executeRun: async input => {signal = input.signal!; await gate; return {finalReportArtifactId: "late-report"};},
    onTaskResult: result => {results.push(result);},
    runNotifications: {onRunCancelled: event => {notifications.push(event);}},
  });
  const run = supervisor.startInitialRun({taskId, inputSnapshot: {}});
  const ledger = new InvocationStore(database.db);
  ledger.register({id: "cancel-invocation", runnerKind: "task", actorUserId: "user-1", runnerContextId: run.runnerContextId!, sessionId: null,
    taskId, taskRunId: run.id, originId: run.id,
    inputSnapshot: decodeInvocation({version: 1, kind: "task", input: {taskId, taskRunId: run.id, runnerContextId: run.runnerContextId!}}), contextPackIds: []});
  const token = new AccessTokenService({db: database.db, signingSecret: "task-cancel-fixture"}).issueToken({
    userId: "user-1", source: "runner", role: "runner", name: "Task", runnerKind: "task",
    sourceRunnerJobId: run.runnerContextId!, sourceTaskId: taskId, sourceTaskRunId: run.id, now: Date.now(),
    ttlMs: 60_000, metadata: {invocationId: "cancel-invocation"},
  });
  ledger.bindToken("cancel-invocation", token.record.id);
  try {
    expect(supervisor.cancelTaskRun({taskId, runId: run.id, reason: "User cancelled"})?.status).toBe("cancelled");
    expect(signal.aborted).toBe(true);
    expect(ledger.require("cancel-invocation").state).toBe("revoked");
    expect(database.db.select().from(lunaSchema.accessTokens).get()?.revokedAt).not.toBeNull();
    release(); await supervisor.waitForIdle();
    expect(results).toHaveLength(0);
    expect(notifications).toMatchObject([{taskRunId: run.id, reason: "User cancelled"}]);
    expect(notifications[0]).not.toHaveProperty("cancelledByRunId");
    expect(store.listRunsForTask(taskId)).toMatchObject([{status: "cancelled", finalReportArtifactId: null}]);
    expect(database.db.select().from(lunaSchema.tasks).where(eq(lunaSchema.tasks.id, taskId)).get()?.status).toBe("cancelled");
  } finally {release(); await supervisor.waitForIdle();}
});

function _registerTaskInvocation(id: string, taskId: string, run: {id: string; runnerContextId: string | null}) {
  return import("../../src/runners/invocation-store").then(({InvocationStore}) => {
    const ledger = new InvocationStore(database.db);
    ledger.register({id, runnerKind: "task", actorUserId: "user-1", runnerContextId: run.runnerContextId!, sessionId: null,
      taskId, taskRunId: run.id, originId: run.id,
      inputSnapshot: decodeInvocation({version: 1, kind: "task", input: {taskId, taskRunId: run.id, runnerContextId: run.runnerContextId!}}), contextPackIds: []});
    const token = new AccessTokenService({db: database.db, signingSecret: "task-supervisor-fixture"}).issueToken({
      userId: "user-1", source: "runner", role: "runner", name: "Task", runnerKind: "task",
      sourceRunnerJobId: run.runnerContextId!, sourceTaskId: taskId, sourceTaskRunId: run.id, now: Date.now(),
      ttlMs: 60_000, metadata: {invocationId: id},
    });
    ledger.bindToken(id, token.record.id);
    return {ledger, tokenId: token.record.id};
  });
}

test("restart revokes the superseded run's authority even before its transport attached an abort listener", async () => {
  const taskId = _createTask("task-restart-revokes");
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  // The fake executor never reaches the runtime transport, like a run aborted
  // while still preparing runner files.
  const supervisor = new TaskRunSupervisor({db: database.db, runnerType: "mock",
    executeRun: async input => {
      if (input.runIndex === 1) { await gate; throw new Error("aborted during preparation"); }
      return await new Promise<ExecuteTaskRunResult>(() => {});
    }});
  const first = supervisor.startInitialRun({taskId, inputSnapshot: {}});
  const {ledger, tokenId} = await _registerTaskInvocation("restart-old-invocation", taskId, first);
  try {
    supervisor.restartTaskRun({taskId, inputSnapshot: {}, updatedTaskSummary: "s", updateSummary: "new facts"});
    expect(ledger.require("restart-old-invocation").state).toBe("revoked");
    expect(database.db.select().from(lunaSchema.accessTokens).where(eq(lunaSchema.accessTokens.id, tokenId)).get()?.revokedAt).not.toBeNull();
    release();
    // The superseded run's settled cleanup can now finish its revoked invocation.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(ledger.require("restart-old-invocation").settledAt).not.toBeNull();
    expect(store.listRunsForTask(taskId).map(run => run.status)).toEqual(["cancelled", "running"]);
  } finally {
    release();
    supervisor.cancelTaskRun({taskId, runId: store.getActiveRunForTask(taskId)!.id, reason: "test cleanup"});
  }
});

test("a run cancelled by another authority without aborting the process closes its status card", async () => {
  const taskId = _createTask("task-external-cancel");
  const cancelled: unknown[] = [];
  const results: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const supervisor = new TaskRunSupervisor({db: database.db, runnerType: "mock",
    executeRun: async () => { await gate; throw new Error("Invocation is no longer active"); },
    onTaskResult: result => {results.push(result);},
    runNotifications: {onRunCancelled: event => {cancelled.push(event);}},
  });
  const run = supervisor.startInitialRun({taskId, inputSnapshot: {}});
  // Same writes as JobReconciler.completeCancelledBusiness for a revoked Task invocation.
  database.db.update(lunaSchema.taskRuns).set({status: "cancelled", cancel_reason: "actor_inactive", finished_at: Date.now()})
    .where(eq(lunaSchema.taskRuns.id, run.id)).run();
  release();
  await supervisor.waitForIdle();
  expect(cancelled).toEqual([{taskRunId: run.id, reason: "actor_inactive"}]);
  expect(results).toHaveLength(0);
});
