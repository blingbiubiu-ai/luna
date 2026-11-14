import {fixtureScope} from "../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { operationInvocationAudits } from "../../src/data/schema";
import { OperationInvocationAuditStore } from "../../src/plugins/audit-store";
import { setLunaHome } from "../../src/shared";

let testHome: string;
let database: DataConnection<typeof schema>;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-operation-audit-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(schema);
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("OperationInvocationAuditStore", () => {
  test("records plugin invocation start metadata with seven day retention", () => {
    const now = 1_782_480_000_000;
    const store = new OperationInvocationAuditStore(database.db);

    store.recordStarted({
      scope:fixtureScope(database.db),
      invocationId: "cinv_1",
      operationId: "media.behavior.query",
      providerType: "plugin",
      pluginId: "media-tools",
      subjectType: "user",
      subjectId: "user_1",
      source: "cli",
      sessionId: "session_1",
      taskId: "task_1",
      messageId: "message_1",
      startedAt: now,
    });

    const row = database.db
      .select()
      .from(operationInvocationAudits)
      .where(eq(operationInvocationAudits.invocation_id, "cinv_1"))
      .get();

    expect(row?.expires_at).toBe(now + 7 * 24 * 60 * 60 * 1000);
    expect(row?.plugin_id).toBe("media-tools");
    expect(row?.operation_id).toBe("media.behavior.query");
    expect(row?.invocation_id).toBe("cinv_1");
    expect(row?.source).toBe("cli");
    expect(row?.subject_id).toBe("user_1");
    expect(row?.status).toBe("started");
  });

  test("records completion and cleans expired audit rows", () => {
    const now = 1_782_480_000_000;
    const store = new OperationInvocationAuditStore(database.db);

    store.recordStarted({
      scope:fixtureScope(database.db),
      invocationId: "cinv_done",
      operationId: "media.behavior.query",
      providerType: "plugin",
      pluginId: "media-tools",
      subjectType: "user",
      subjectId: "user_1",
      source: "cli",
      startedAt: now,
    });
    store.recordCompleted("cinv_done", {
      status: "success",
      artifactCount: 2,
      endedAt: now + 25,
    });

    const completed = database.db
      .select()
      .from(operationInvocationAudits)
      .where(eq(operationInvocationAudits.invocation_id, "cinv_done"))
      .get();
    expect(completed?.status).toBe("success");
    expect(completed?.artifact_count).toBe(2);
    expect(completed?.duration_ms).toBe(25);

    expect(store.cleanupExpired(now + 7 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(
      database.db.select().from(operationInvocationAudits).all(),
    ).toHaveLength(0);
  });
});
