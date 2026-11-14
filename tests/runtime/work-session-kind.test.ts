import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { sessions } from "../../src/data/schema";
import { SessionStore } from "../../src/sessions/session-store";
import { config, setLunaHome } from "../../src/shared";

import { fixtureSessionOwnership } from "../helpers/platform-fixtures";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-kind-test-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  fixtureSessionOwnership(database.db, "feishu", "feishu-main");
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("sessions.kind field", () => {
  test("new session defaults to kind='main'", () => {
    const store = new SessionStore(database.db);
    const session = store.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-1",
      rootMessageId: "msg-1",
    });
    expect(session.kind).toBe("main");
  });

  test("createWorkSession creates a session with kind='work'", () => {
    const store = new SessionStore(database.db);
    const session = store.createWorkSession({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-1",
      threadId: "thread-1",
    });
    expect(session.kind).toBe("work");
    expect(session.status).toBe("active");
    expect(session.thread_key).toBe("thread-1");
  });

  test("work session resolves back by thread_key", () => {
    const store = new SessionStore(database.db);
    store.createWorkSession({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-1",
      threadId: "thread-1",
    });
    const resolved = store.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-1",
      threadId: "thread-1",
    });
    expect(resolved.kind).toBe("work");
  });
});
