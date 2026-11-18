import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {SessionStore} from "@/sessions/session-store";
import {ownerDirectory, ownerDirectoryName} from "@/runners/prepare-runner-files";
import {fixtureOwnerUserId, fixtureRunnerContext, fixtureScope} from "../helpers/platform-fixtures";

let home: string, connection: DataConnection<typeof schema>;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "luna-owner-dir-")); setLunaHome(home); connection = new DataConnection(schema); });
afterEach(() => { connection.close(); rmSync(home, {recursive: true, force: true}); });

test("every Runner type of a session works in the session's directory", () => {
  const db = connection.db, scope = fixtureScope(db, "owner");
  const session = new SessionStore(db).createLocalSession(fixtureOwnerUserId("owner"), scope).id;
  for (const [id, runner] of [["codex-ctx", "codex"], ["claude-ctx", "claude"]] as const)
    db.insert(schema.runnerContexts).values(fixtureRunnerContext(db, {id, owner_type: "session", owner_id: session, runner_type: runner, runner_root_path: `/unused/${id}`, created_at: 1, updated_at: 1})).run();
  expect(ownerDirectory(db, "codex-ctx")).toBe(`session-${session}`);
  expect(ownerDirectory(db, "claude-ctx")).toBe(`session-${session}`);
  expect(ownerDirectory(db, "unknown")).toBe("unknown");
});

test("task directories are named after the task; unusable names fall back to the context", () => {
  expect(ownerDirectoryName("task", "task_42", "ctx")).toBe("task-task_42");
  expect(ownerDirectoryName("session", "a/b", "ctx")).toBe("ctx");
  expect(ownerDirectoryName("session", "x".repeat(130), "ctx")).toBe("ctx");
});
