import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { ArtifactRegistry } from "../../src/artifacts/artifact-registry";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { managedArtifacts } from "../../src/data/schema";
import { config, setLunaHome } from "../../src/shared";

import { fixtureScope } from "../helpers/platform-fixtures";

let testHome: string, previousHome: string;
let scope: ReturnType<typeof fixtureScope>;
let database: DataConnection<typeof schema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-plugin-artifact-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(schema);
  scope = fixtureScope(database.db, "user_1");
  database.db.insert(schema.tasks).values({
    id: "task_1", agent_id: scope.agentId, shadow_id: scope.shadowId,
    creator_user_id: "user_1", type: "work", title: "Plugin artifact owner", status: "completed",
    created_at: 1, updated_at: 1, last_activity_at: 1,
  }).run();
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("plugin artifact attribution", () => {
  test("persists plugin attribution for content artifacts", () => {
    const row = new ArtifactRegistry(database.db).registerContent({
      scopeType: "task",
      scopeId: "task_1",
      producer: "plugin",
      kind: "dump_json",
      name: "behavior-dump.json",
      mimeType: "application/json; charset=utf-8",
      content: new TextEncoder().encode("{}"),
      attribution: {
        pluginId: "media-tools",
        operationId: "media.behavior.query",
        invocationId: "cinv_1",
        source: "cli",
        subjectId: "user_1",
        messageId: "message_1",
      },
    });

    const persisted = database.db
      .select()
      .from(managedArtifacts)
      .where(eq(managedArtifacts.id, row.id))
      .get();

    expect(persisted).toMatchObject({agent_id: scope.agentId, shadow_id: scope.shadowId});
    expect(persisted?.plugin_id).toBe("media-tools");
    expect(persisted?.operation_id).toBe("media.behavior.query");
    expect(persisted?.invocation_id).toBe("cinv_1");
    expect(persisted?.invocation_source).toBe("cli");
    expect(persisted?.invocation_subject_id).toBe("user_1");
    expect(persisted?.message_id).toBe("message_1");
  });

  test("persists plugin attribution for local file artifacts", () => {
    const source = join(testHome, "source.txt");
    writeFileSync(source, "hello");

    const row = new ArtifactRegistry(database.db).registerLocalFile({
      scopeType: "task",
      scopeId: "task_1",
      producer: "plugin",
      kind: "text",
      name: "source.txt",
      path: source,
      attribution: {
        pluginId: "media-tools",
        operationId: "media.behavior.query",
        invocationId: "cinv_2",
        source: "task_runner",
        subjectId: "user_1",
      },
    });

    const persisted = database.db
      .select()
      .from(managedArtifacts)
      .where(eq(managedArtifacts.id, row.id))
      .get();

    expect(persisted).toMatchObject({agent_id: scope.agentId, shadow_id: scope.shadowId});
    expect(persisted?.plugin_id).toBe("media-tools");
    expect(persisted?.operation_id).toBe("media.behavior.query");
    expect(persisted?.invocation_id).toBe("cinv_2");
    expect(persisted?.invocation_source).toBe("task_runner");
    expect(persisted?.invocation_subject_id).toBe("user_1");
  });
});
