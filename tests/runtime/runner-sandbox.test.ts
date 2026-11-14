import { fixtureNamedSession, fixtureRunnerContext, fixtureTaskOwnership } from "../helpers/platform-fixtures";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import { tasks, runnerContexts, timelineEvents } from "../../src/data/schema";
import * as lunaSchema from "../../src/data/schema";
import {
  assertStoredRunnerRoots,
  createSessionRunnerPaths,
  createTaskRunnerPaths,
  RunnerContextStore,
} from "../../src/runners/runner-context-store";
import {
  ensureRunnerRootLayout,
  resolveBundledSkillsRoot,
} from "../../src/runners/runner-root-layout";
import { FakeRunnerAdapter } from "../../extensions/runners/mock/fake-runner-adapter";
import {
  createAgentRunnerForConfig,
  runnerTypeForAgentConfig,
} from "../../src/kernel/agents/factory";
import type { RunnerAdapter } from "../../src/runners/types";
import { FakeSandboxRuntime } from "../../src/sandbox/fake-sandbox-runtime";
import { config, setLunaHome } from "../../src/shared";
import { materializeRunnerSkills, PluginRegistry } from "../../src/plugins";
import { ArtifactStore } from "../../src/timeline/artifact-store";
import { TimelineStore } from "../../src/timeline/timeline-store";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-runner-sandbox-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("runner and sandbox adapters", () => {
  test("runner adapter is generic and stores runnerType in payloads", () => {
    const adapter: RunnerAdapter<{ readonly issue: string }> =
      new FakeRunnerAdapter<{ readonly issue: string }>({
        runnerType: "mock-plugin",
      });

    const execution = adapter.buildRun({
      taskId: "task-generic",
      mode: "run",
      workspacePath: "/tmp/workspace",
      runnerRootPath: "/tmp/runners/task-generic",
      payload: { issue: "reader 502" },
    });

    expect(execution.runnerType).toBe("mock-plugin");
    expect(execution.payload).toEqual({
      issue: "reader 502",
      runnerType: "mock-plugin",
    });
  });

  test("fake sandbox executes fake runner and returns deterministic artifacts", async () => {
    const workspacePath = join(testHome, "workspace");
    const runnerRootPath = join(testHome, "runner-root");
    const execution = new FakeRunnerAdapter({
      runnerType: "mock",
    }).buildRun({
      taskId: "task-fake-run",
      mode: "run",
      workspacePath,
      runnerRootPath,
      payload: { prompt: "diagnose reader 502" },
    });

    const result = await new FakeSandboxRuntime().run(execution);

    expect(result.exitCode).toBe(0);
    expect(result.artifacts.map((artifact) => artifact.name).sort()).toEqual([
      "final-report.md",
      "runner-events.jsonl",
      "runner-stderr.log",
      "runner-stdout.log",
    ]);
    expect(
      result.artifacts.find((artifact) => artifact.name === "final-report.md")
        ?.mimeType,
    ).toBe("text/markdown");

    const eventsPath = join(workspacePath, "runner-events.jsonl");
    const reportPath = join(workspacePath, "final-report.md");
    const stderrPath = join(workspacePath, "runner-stderr.log");
    const stdoutPath = join(workspacePath, "runner-stdout.log");

    expect(existsSync(eventsPath)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(stderrPath)).toBe(true);
    expect(existsSync(stdoutPath)).toBe(true);
    expect(
      readFileSync(eventsPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        type: "runner.started",
        taskId: "task-fake-run",
        mode: "run",
        runnerType: "mock",
      },
      {
        type: "runner.completed",
        taskId: "task-fake-run",
        mode: "run",
        runnerType: "mock",
      },
    ]);
    expect(readFileSync(reportPath, "utf-8")).toContain(
      "# Fake runner report",
    );
    expect(readFileSync(stderrPath, "utf-8")).toBe("");
    expect(readFileSync(stdoutPath, "utf-8")).toContain(
      "Fake runner completed.",
    );
  });

  test("task-owned runner roots are flat, isolated, and reused on resume", () => {
    const store = new RunnerContextStore(database.db);
    _createTask("task-alpha");
    _createTask("task-beta");

    const alphaRun = store.resolveForTask("task-alpha", "mock");
    const betaRun = store.resolveForTask("task-beta", "mock");
    const alphaResume = store.resolveForTask("task-alpha", "mock");

    expect(alphaRun.workspacePath).toBe(
      join(testHome, "runners", "task-alpha", "workspace"),
    );
    expect(alphaRun.runner_root_path).toBe(
      join(testHome, "runners", "task-alpha"),
    );
    expect(betaRun.workspacePath).toBe(
      join(testHome, "runners", "task-beta", "workspace"),
    );
    expect(betaRun.runner_root_path).toBe(
      join(testHome, "runners", "task-beta"),
    );
    expect(alphaRun.workspacePath).not.toBe(betaRun.workspacePath);
    expect(alphaRun.runner_root_path).not.toBe(betaRun.runner_root_path);
    expect(alphaResume.id).toBe(alphaRun.id);
    expect(alphaResume.runner_root_path).toBe(alphaRun.runner_root_path);
    expect(existsSync(alphaRun.workspacePath)).toBe(true);
    expect(existsSync(alphaRun.runner_root_path)).toBe(true);
  });

  test("runner context store resolves task paths without execution options", () => {
    const store = new RunnerContextStore(database.db);
    _createTask("task-container-only");

    const context = store.resolveForTask("task-container-only", "mock");

    expect(context.runner_root_path).toBe(
      join(testHome, "runners", "task-container-only"),
    );
    expect(context.workspacePath).toBe(
      join(testHome, "runners", "task-container-only", "workspace"),
    );
  });

  test("session and task paths share one runner namespace", () => {
    expect(createSessionRunnerPaths("session_1")).toEqual({
      runnerRootPath: join(testHome, "runners", "session_1"),
      workspacePath: join(testHome, "runners", "session_1", "workspace"),
      ipcPath: join(testHome, "runners", "session_1", "ipc"),
    });
    expect(createTaskRunnerPaths("task_1").runnerRootPath).toBe(
      join(testHome, "runners", "task_1"),
    );
  });

  test("rejects a runner root collision between different owners", () => {
    const store = new RunnerContextStore(database.db);
    fixtureNamedSession(database.db, "shared-id", "fixture-owner");
    _createTask("shared-id");
    store.resolveForSession("shared-id", "claude");

    expect(() => store.resolveForTask("shared-id", "claude")).toThrow(
      /runner root.*different owner/i,
    );
  });

  test("rejects persisted runner roots outside the configured base", () => {
    _createTask("task-outside-base");
    const now = Date.now();
    database.db.insert(runnerContexts).values(fixtureRunnerContext(database.db, {
      id: "context-outside-base",
      owner_type: "task",
      owner_id: "task-outside-base",
      runner_type: "claude",
      runner_session_id: null,
      instruction_fingerprint: null,
      runner_root_path: join(testHome, "outside", "task-outside-base"),
      last_run_id: null,
      created_at: now,
      updated_at: now,
    })).run();

    database.db.insert(lunaSchema.runnerContextOrigins).values({ contextId: "context-outside-base", runtimeId: "test-runtime" }).run();
    expect(() => assertStoredRunnerRoots(database.db)).toThrow(
      /outside the configured runner root base/i,
    );
  });

  test("runner root creates working files while shared resources live in public HOME", () => {
    const runnerRootPath = join(testHome, "runners", "session-layout");
    const workspacePath = join(runnerRootPath, "workspace");
    ensureRunnerRootLayout({ runnerRootPath, workspacePath });
    expect(existsSync(join(runnerRootPath, ".luna"))).toBe(true);
    expect(existsSync(workspacePath)).toBe(true);
    for (const name of ["projects", "memory", ".agents", ".claude", ".luna-bin"]) {
      expect(existsSync(join(runnerRootPath, name))).toBe(false);
    }
  });

  test("creates workspace without migrating old run files", () => {
    const runnerRootPath = join(testHome, "runner-home-migration");
    const workspacePath = join(runnerRootPath, "workspace");
    const transitionalWorkspacePath = join(runnerRootPath, ".luna", "run");
    mkdirSync(transitionalWorkspacePath, { recursive: true });
    writeFileSync(
      join(transitionalWorkspacePath, "final-report.md"),
      "transitional report",
      "utf-8",
    );

    ensureRunnerRootLayout({
      runnerRootPath,
      workspacePath,
    });

    expect(readFileSync(join(transitionalWorkspacePath, "final-report.md"), "utf-8"))
      .toBe("transitional report");
    expect(existsSync(workspacePath)).toBe(true);
    expect(existsSync(join(runnerRootPath, "projects"))).toBe(false);
  });

  test("old and current workspace directories coexist without blocking preparation", () => {
    const runnerRootPath = join(testHome, "runner-home-migration-conflict");
    const workspacePath = join(runnerRootPath, "workspace");
    const transitionalWorkspacePath = join(runnerRootPath, ".luna", "run");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(transitionalWorkspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "current.log"), "current", "utf-8");
    writeFileSync(
      join(transitionalWorkspacePath, "transitional.log"),
      "transitional",
      "utf-8",
    );

    expect(() =>
      ensureRunnerRootLayout({
        runnerRootPath,
        workspacePath,
      })
    ).not.toThrow();
    expect(readFileSync(join(workspacePath, "current.log"), "utf-8"))
      .toBe("current");
    expect(
      readFileSync(join(transitionalWorkspacePath, "transitional.log"), "utf-8"),
    ).toBe("transitional");
  });

  test("runner root preserves existing user files", () => {
    const workspacePath = join(testHome, "workspace");
    const runnerRootPath = join(testHome, "runner-home");
    mkdirSync(join(runnerRootPath, "memory"), { recursive: true });
    writeFileSync(join(runnerRootPath, "memory", "keep.md"), "keep", "utf-8");

    ensureRunnerRootLayout({ runnerRootPath, workspacePath });
    expect(readFileSync(join(runnerRootPath, "memory", "keep.md"), "utf-8"))
      .toBe("keep");
  });

  test("clears session runner session id by runner context scope without clearing other runners", () => {
    const store = new RunnerContextStore(database.db);
    fixtureNamedSession(database.db, "session-scope-clear", "fixture-owner");

    const claudeContext = store.resolveForSession("session-scope-clear", "claude");
    const codexContext = store.resolveForSession("session-scope-clear", "codex");
    store.persistRunnerSessionId(claudeContext.id, "claude-session");
    store.persistRunnerSessionId(codexContext.id, "codex-session");

    store.clearRunnerSessionIdByScopeKey(`session:${claudeContext.id}`);

    const rows = database.db
      .select()
      .from(runnerContexts)
      .all();
    expect(rows.find((row) => row.id === claudeContext.id)?.runner_session_id)
      .toBeNull();
    expect(rows.find((row) => row.id === codexContext.id)?.runner_session_id)
      .toBe("codex-session");
  });

  test("ignores malformed task scope without runner type", () => {
    const store = new RunnerContextStore(database.db);
    _createTask("task-malformed-scope");

    const claudeContext = store.resolveForTask("task-malformed-scope", "claude");
    store.persistRunnerSessionId(claudeContext.id, "claude-session");

    store.clearRunnerSessionIdByScopeKey(`task:${claudeContext.id}`);

    const row = database.db
      .select()
      .from(runnerContexts)
      .all()
      .find((candidate) => candidate.id === claudeContext.id);
    expect(row?.runner_session_id).toBe("claude-session");
  });

  test("clears task runner session id by task scope and runner type", () => {
    const store = new RunnerContextStore(database.db);
    _createTask("task-scope-clear-by-task");

    const claudeContext = store.resolveForTask("task-scope-clear-by-task", "claude");
    const codexContext = store.resolveForTask("task-scope-clear-by-task", "codex");
    store.persistRunnerSessionId(claudeContext.id, "claude-session");
    store.persistRunnerSessionId(codexContext.id, "codex-session");

    store.clearRunnerSessionIdByScopeKey("task:task-scope-clear-by-task:claude");

    const rows = database.db
      .select()
      .from(runnerContexts)
      .all();
    expect(rows.find((row) => row.id === claudeContext.id)?.runner_session_id)
      .toBeNull();
    expect(rows.find((row) => row.id === codexContext.id)?.runner_session_id)
      .toBe("codex-session");
  });

  test("runner roots keep task working files separate from shared resources", () => {
    materializeRunnerSkills({ pluginRegistry: new PluginRegistry() });
    mkdirSync(config.paths.sharedWorkspace, { recursive: true });
    mkdirSync(config.paths.memory, { recursive: true });
    const store = new RunnerContextStore(database.db);
    _createTask("task-skills");

    const context = store.resolveForTask("task-skills", "mock");
    const root = context.runner_root_path;

    expect(context.workspacePath).toBe(join(root, "workspace"));
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(existsSync(join(root, ".luna-prompts"))).toBe(false);
    expect(existsSync(join(root, "projects"))).toBe(false);
    expect(existsSync(join(root, "memory"))).toBe(false);
    expect(existsSync(join(root, ".agents", "skills"))).toBe(false);
    expect(existsSync(join(root, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(root, "attachments"))).toBe(false);
    expect(existsSync(join(root, "workspace", "attachments"))).toBe(false);
  });

  test("container runner roots use the same working layout", () => {
    const workspacePath = join(testHome, "workspace");
    const runnerRootPath = join(testHome, "runner-root");
    mkdirSync(config.paths.memory, { recursive: true });
    mkdirSync(config.paths.sharedWorkspace, { recursive: true });

    ensureRunnerRootLayout({
      runnerRootPath,
      workspacePath,
    });

    expect(existsSync(join(runnerRootPath, "skills"))).toBe(false);
    expect(existsSync(join(runnerRootPath, ".luna-prompts"))).toBe(false);
    expect(existsSync(join(runnerRootPath, ".agents", "skills"))).toBe(false);
    expect(existsSync(join(runnerRootPath, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(runnerRootPath, "memory"))).toBe(false);
    expect(existsSync(join(runnerRootPath, "attachments"))).toBe(false);
    expect(existsSync(join(workspacePath, "attachments"))).toBe(false);
  });

  test("bundled skills root resolves from source and dist module directories", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "luna-skills-root-"));
    try {
      mkdirSync(join(repoRoot, "src", "runners"), { recursive: true });
      mkdirSync(join(repoRoot, "dist"), { recursive: true });
      mkdirSync(join(repoRoot, "skills"), { recursive: true });

      expect(resolveBundledSkillsRoot(join(repoRoot, "src", "runners"))).toBe(
        join(repoRoot, "skills"),
      );
      expect(resolveBundledSkillsRoot(join(repoRoot, "dist"))).toBe(
        join(repoRoot, "skills"),
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("malicious task ids cannot escape the luna tasks root", () => {
    const maliciousTaskId = "../outside/task";
    _createTask(maliciousTaskId);

    const paths = createTaskRunnerPaths(maliciousTaskId);
    const context = new RunnerContextStore(database.db).resolveForTask(
      maliciousTaskId,
      "mock",
    );
    const runnersRoot = join(testHome, "runners");

    expect(_isInside(runnersRoot, paths.workspacePath)).toBe(true);
    expect(_isInside(runnersRoot, paths.runnerRootPath)).toBe(true);
    expect(_isInside(runnersRoot, context.workspacePath)).toBe(true);
    expect(_isInside(runnersRoot, context.runner_root_path)).toBe(true);
    expect(context.workspacePath).not.toContain(`${sep}..${sep}`);
    expect(context.runner_root_path).not.toContain(`${sep}..${sep}`);
  });

  test("runner context uniqueness is enforced by the database", () => {
    _createTask("task-unique");
    const store = new RunnerContextStore(database.db);
    const first = store.resolveForTask("task-unique", "mock");

    expect(() =>
      database.db
        .insert(runnerContexts)
        .values(fixtureRunnerContext(database.db, {
          ...first,
          id: "manual-duplicate",
          created_at: Date.now(),
          updated_at: Date.now(),
        }))
        .run(),
    ).toThrow();
    expect(store.resolveForTask("task-unique", "mock").id).toBe(first.id);
  });

  test("agent runner type remains separate from model", () => {
    expect(
      runnerTypeForAgentConfig({
        type: "claude",
        model: "claude-sonnet-4-6",
      }),
    ).toBe("claude");
    expect(
      runnerTypeForAgentConfig({
        type: "codex",
        model: "gpt-5",
      }),
    ).toBe("codex");
    expect(
      runnerTypeForAgentConfig({
        type: "claude",
        model: "claude-sonnet-4-6",
      }),
    ).toBe("claude");
  });

  test.each(["claude", "codex"])("%s requires Runtime transport", (type) => {
    const selection = { type, model: "test" };
    expect(() => createAgentRunnerForConfig(selection)).toThrow("require a Runtime connection");
    expect(createAgentRunnerForConfig(selection, { async *stream() {} }).type).toBe("container");
  });

  test("container login shells restore fixed Luna tool paths", () => {
    const dockerfile = readFileSync(
      join(import.meta.dir, "../../container/Dockerfile.base"),
      "utf-8",
    );

    expect(dockerfile).toContain(
      "$HOME/.luna-resources/commands:$HOME/.local/bin:$PATH",
    );
    expect(dockerfile).not.toContain("LUNA_RUNNER_BIN_PATH");
    expect(dockerfile).not.toContain("/usr/local/luna-bin");
  });

  test("retired host runner extension directories have been removed", () => {
    expect(
      existsSync(join(import.meta.dir, "../../extensions/runners/claude")),
    ).toBe(false);
    expect(
      existsSync(join(import.meta.dir, "../../extensions/runners/codex")),
    ).toBe(false);
  });

  test("codex task adapter file has been retired", () => {
    expect(
      existsSync(
        join(import.meta.dir, "../../extensions/runners/codex/codex-runner-adapter.ts"),
      ),
    ).toBe(false);
  });

  test("runner adapter abstraction remains only for fake execution doubles", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/runners/types.ts"),
      "utf-8",
    );

    expect(source).not.toContain("Codex CLI execution");
    expect(source).not.toContain("provider execution");
    expect(source).toContain("fake");
  });

  test("agent factory no longer exports the legacy host-runner entrypoint", async () => {
    const factory = await import("../../src/kernel/agents/factory");

    expect(factory).not.toHaveProperty("createAgentRunner");
    expect(factory).toHaveProperty("createAgentRunnerForConfig");
  });

  test("fake runtime persists generic runner timeline events and artifacts", async () => {
    const store = new RunnerContextStore(database.db);
    const timeline = new TimelineStore(database.db);
    const artifacts = new ArtifactStore(database.db);
    _createTask("task-timeline");
    const context = store.resolveForTask("task-timeline", "mock");
    const execution = new FakeRunnerAdapter({ runnerType: "mock" }).buildRun({
      taskId: "task-timeline",
      mode: "run",
      workspacePath: context.workspacePath,
      runnerRootPath: context.runner_root_path,
      payload: {},
    });

    await new FakeSandboxRuntime({ timeline, artifacts }).run(execution);

    const timelineRows = database.db
      .select()
      .from(timelineEvents)
      .all()
      .map((row) => row.type);
    const artifactRows = artifacts.listByTask("task-timeline");
    expect(timelineRows).toEqual(["runner.started", "runner.completed"]);
    expect(timelineRows.every((type) => type.startsWith("runner."))).toBe(true);
    expect(artifactRows.map((row) => row.name).sort()).toEqual([
      "final-report.md",
      "runner-events.jsonl",
      "runner-stderr.log",
      "runner-stdout.log",
    ]);
    expect(
      artifactRows.find((row) => row.name === "final-report.md")?.mime_type,
    ).toBe("text/markdown");
    expect(artifactRows.every((row) => row.status === "active")).toBe(true);
  });

});

function _createTask(taskId: string): void {
  const now = Date.now();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      type: "task",
      status: "new",
      priority: "medium",
      severity: null,
      title: taskId,
      summary: null,
      created_at: now,
      updated_at: now,
      last_activity_at: now, ...fixtureTaskOwnership(database.db)})
    .run();
}

function _isInside(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return (
    childRelativePath !== "" &&
    !childRelativePath.startsWith(`..${sep}`) &&
    childRelativePath !== ".." &&
    !isAbsolute(childRelativePath)
  );
}
