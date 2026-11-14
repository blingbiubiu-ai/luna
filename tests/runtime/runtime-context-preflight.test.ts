import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerContextOrigins, tasks } from "../../src/data/schema";
import { fixtureNamedSession } from "../helpers/platform-fixtures";
import { bindRunnerContextsToRuntime, RunnerContextStore } from "../../src/runners/runner-context-store";
import { verifyRuntimeContexts } from "../../src/runners/runtime-context-preflight";
import { config, setLunaHome } from "../../src/shared";
import { runtimeStub } from "../fixtures/runtime-stub";

test("unbound session and task contexts start fresh CLI sessions once and persist Runtime ownership", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-context-preflight-")));
  const home = config.paths.home;
  let sqlite = new Database(join(root, "service.sqlite")); let db = drizzle(sqlite);
  setLunaHome(root);
  try {
    migrate(db, { migrationsFolder: join(import.meta.dir, "../../src/data/drizzle") });
    const scope = fixtureNamedSession(db, "old-session");
    fixtureNamedSession(db, "new-session");
    fixtureNamedSession(db, "existing-directory");
    db.insert(tasks).values({id: "old-task", type: "task", title: "Existing task", status: "new",
      agent_id: scope.agentId, shadow_id: scope.shadowId, created_at: 1, updated_at: 1, last_activity_at: 1}).run();
    const store = new RunnerContextStore(db);
    const old = store.resolveForSession("old-session", "codex");
    const oldTask = store.resolveForTask("old-task", "codex");
    store.persistRunnerSessionId(old.id, "old-cli-session");
    store.persistRunnerSessionId(oldTask.id, "old-task-cli-session");
    writeFileSync(join(old.workspacePath, "keep.txt"), "existing work");
    mkdirSync(join(root, "runners", "existing-directory"), { recursive: true });
    const client = runtimeStub();
    await verifyRuntimeContexts(db, client);
    bindRunnerContextsToRuntime(db, client.runtimeId);
    const fresh = new RunnerContextStore(db).resolveForSession("new-session", "codex");
    const switched = new RunnerContextStore(db).resolveForSession("old-session", "claude");
    expect(db.select().from(runnerContextOrigins).all()).toEqual([
      { contextId: fresh.id, runtimeId: "runtime" }, { contextId: switched.id, runtimeId: "runtime" },
    ]);
    const rebuilt = store.resolveForSession("old-session", "codex");
    const rebuiltTask = store.resolveForTask("old-task", "codex");
    expect(rebuilt.id).toBe(old.id);
    expect(rebuilt.runner_root_path).toBe(old.runner_root_path);
    expect(rebuilt.runner_session_id).toBeNull();
    expect(rebuiltTask.id).toBe(oldTask.id);
    expect(rebuiltTask.runner_session_id).toBeNull();
    expect(readFileSync(join(rebuilt.workspacePath, "keep.txt"), "utf8")).toBe("existing work");
    const existingDirectory = store.resolveForSession("existing-directory", "codex");
    await verifyRuntimeContexts(db, client, existingDirectory.id);
    store.persistRunnerSessionId(old.id, "new-cli-session");
    expect(store.resolveForSession("old-session", "codex").runner_session_id).toBe("new-cli-session");
    sqlite.close(); sqlite = new Database(join(root, "service.sqlite")); db = drizzle(sqlite);
    await verifyRuntimeContexts(db, client, fresh.id);
    for (const id of [old.id, oldTask.id, switched.id]) await verifyRuntimeContexts(db, client, id);
    bindRunnerContextsToRuntime(db, client.runtimeId);
    expect(new RunnerContextStore(db).resolveForSession("old-session", "codex").runner_session_id).toBe("new-cli-session");
    bindRunnerContextsToRuntime(db, "other");
    expect(() => new RunnerContextStore(db).resolveForSession("old-session", "codex")).toThrow("context_runtime_mismatch");
    expect(() => new RunnerContextStore(db).resolveForSession("old-session", "new-provider")).toThrow("context_runtime_mismatch");
    await expect(verifyRuntimeContexts(db, runtimeStub({runtimeId: "other"}), fresh.id)).rejects.toMatchObject({ code: "context_runtime_mismatch" });
    await expect(verifyRuntimeContexts(db, client, "missing")).rejects.toMatchObject({ code: "context_not_found" });
  } finally {
    setLunaHome(home);
    sqlite.close(); rmSync(root, { recursive: true, force: true });
  }
});
