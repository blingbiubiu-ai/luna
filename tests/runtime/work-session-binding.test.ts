import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { sessions, sessionSurfaceAliases } from "../../src/data/schema";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionResolver } from "../../src/sessions/session-resolver";
import { config, setLunaHome } from "../../src/shared";
import { WorkSessionLauncher } from "../../src/work/work-session-launcher";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { MessageStore } from "../../src/sessions/message-store";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";

import { fixtureObserveFeishuSender, fixtureFeishuSender, fixtureSessionOwnership } from "../helpers/platform-fixtures";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-work-binding-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  const owner = "work-fixture-owner";
  fixtureSessionOwnership(database.db, "feishu", "feishu-main", owner);
  fixtureObserveFeishuSender(database.db, "feishu-main", "user-1");
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("work session thread binding", () => {
  test("thread reply resolves to work session, not new main session", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore,
      messageStore: new MessageStore(database.db),
      inboxStore: new SessionInboxStore(database.db),
      schedule: () => {},
    });

    // Create work session via #work
    await launcher.handleWorkCommand({
      id: "om_work_msg_1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-1", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-1"),
      text: "#work 做个任务",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });

    const workSession = database.db.select().from(sessions).where(eq(sessions.kind, "work")).get()!;
    expect(workSession.root_message_key).toBe("om_work_msg_1");

    // Simulate a thread reply message (Feishu thread_id is omt_..., root is om_work_msg_1)
    const resolver = new SessionResolver(sessionStore);
    const resolved = resolver.resolveFromNormalizedInbound({
      id: "om_reply_1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-1", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-1"),
      text: "补充一下需求",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
      thread: { externalId: "omt_thread_1", parentMessageExternalId: "om_work_msg_1", rootMessageExternalId: "om_work_msg_1" },
    });

    // Should resolve to the work session, not create a new main session
    expect(resolved.id).toBe(workSession.id);
    expect(resolved.kind).toBe("work");

    // The initial #work message is persisted in a root main session.
    const mainSessions = database.db
      .select()
      .from(sessions)
      .where(eq(sessions.kind, "main"))
      .all();
    expect(mainSessions).toHaveLength(1);
  });
});
