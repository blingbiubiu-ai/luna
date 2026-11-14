import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { managedArtifacts, messages, sessions, sessionInbox, sessionTimelineEntries } from "../../src/data/schema";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { MessageStore } from "../../src/sessions/message-store";
import { config, setLunaHome } from "../../src/shared";
import { WorkSessionLauncher } from "../../src/work/work-session-launcher";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";

import { fixtureObserveFeishuSender, fixtureFeishuSender, fixtureSessionOwnership } from "../helpers/platform-fixtures";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-work-launch-"));
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

function makeWorkMessage(text: string, id = "msg-work-1") {
  return {
    id,
    channel: { type: "feishu" as const, id: "feishu-main" },
    surface: { externalId: "group-1", kind: "group" as const },
    sender: fixtureFeishuSender("feishu-main", "user-1"),
    text,
    mentions: [],
    addressing: { addressedToBot: true, reason: "mention" as const },
    rawPayload: { id, text },
  };
}

describe("WorkSessionLauncher #work command", () => {
  test("#work creates a work session with kind='work' and enqueues the requirement", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    let scheduled: string | undefined;
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore: new SessionStore(database.db),
      messageStore: new MessageStore(database.db),
      inboxStore: new SessionInboxStore(database.db),
      schedule: (id) => { scheduled = id; },
    });

    const message = makeWorkMessage("#work 帮我实现一个登录页面");
    const handled = await launcher.handleWorkCommand(message);
    expect(handled).toBe(true);

    const workSessions = database.db
      .select()
      .from(sessions)
      .where(eq(sessions.kind, "work"))
      .all();
    expect(workSessions).toHaveLength(1);
    expect(workSessions[0]!.thread_key).toBe("msg-work-1");
    expect(workSessions[0]!.status).toBe("active");
    expect(scheduled).toBe(workSessions[0]!.id);
    const rootSession = database.db
      .select()
      .from(sessions)
      .where(eq(sessions.kind, "main"))
      .get();
    expect(rootSession).toBeDefined();

    const rootMessage = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "msg-work-1"))
      .get();
    expect(rootMessage).toBeDefined();
    expect(rootMessage!.contentJson).toEqual([
      { type: "text", text: "#work 帮我实现一个登录页面" },
    ]);
    expect(database.db
      .select()
      .from(sessionTimelineEntries)
      .where(eq(sessionTimelineEntries.messageId, rootMessage!.id))
      .all()
      .map((entry) => ({
        sessionId: entry.sessionId,
        entryKind: entry.entryKind,
      }))).toEqual(expect.arrayContaining([
        { sessionId: rootSession!.id, entryKind: "message" },
        { sessionId: workSessions[0]!.id, entryKind: "reference" },
      ]));

    const pendingInbox = database.db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.session_id, workSessions[0]!.id))
      .all();
    expect(pendingInbox).toHaveLength(1);
    expect(pendingInbox[0]!.status).toBe("pending");

    expect(channel.outbound).toHaveLength(0);
  });

  test("mentioned group #work creates a work session when command is not the first token", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    let scheduled: string | undefined;
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore: new SessionStore(database.db),
      messageStore: new MessageStore(database.db),
      inboxStore: new SessionInboxStore(database.db),
      schedule: (id) => {
        scheduled = id;
      },
    });

    const message = makeWorkMessage("@Luna #work 帮我实现一个登录页面");
    const handled = await launcher.handleWorkCommand(message);
    expect(handled).toBe(true);

    const workSession = database.db
      .select()
      .from(sessions)
      .where(eq(sessions.kind, "work"))
      .get();
    expect(workSession).toBeDefined();
    expect(scheduled).toBe(workSession!.id);
    expect(channel.outbound).toHaveLength(0);
  });

  test("#work launch message uses normal inbound persistence for local file artifacts", async () => {
    mkdirSync(join(testHome, "workspace", "uploads"), { recursive: true });
    writeFileSync(join(testHome, "workspace", "uploads", "work-input.txt"), "hello");
    const channel = new FakeFeishuChannel("feishu-main");
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore: new SessionStore(database.db),
      messageStore: new MessageStore(database.db),
      inboxStore: new SessionInboxStore(database.db),
      schedule: () => {},
    });

    const handled = await launcher.handleWorkCommand(
      makeWorkMessage("#work 读取 workspace/uploads/work-input.txt"),
    );

    expect(handled).toBe(true);
    const workSession = database.db
      .select()
      .from(sessions)
      .where(eq(sessions.kind, "work"))
      .get();
    expect(workSession).toBeDefined();
    const artifactRows = database.db.select().from(managedArtifacts).all();
    expect(artifactRows).toHaveLength(1);
    expect(artifactRows[0]!.scope_id).toBe(workSession!.id);
    const rootMessage = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "msg-work-1"))
      .get();
    expect(JSON.stringify(rootMessage!.contentJson)).toContain("artifact:");
    expect(JSON.stringify(rootMessage!.rawPayloadJson)).toContain("artifact:");
  });

  test("#work with empty requirement replies with hint", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore: new SessionStore(database.db),
      messageStore: new MessageStore(database.db),
      inboxStore: new SessionInboxStore(database.db),
      schedule: () => {},
    });

    const handled = await launcher.handleWorkCommand(makeWorkMessage("#work"));
    expect(handled).toBe(true);
    expect(channel.outbound).toHaveLength(1);
    expect(channel.outbound[0]!.content).toContain("请在 #work 后面描述");
  });

  test("duplicate #work delivery is idempotent", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    let scheduleCount = 0;
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore: new SessionStore(database.db),
      messageStore: new MessageStore(database.db),
      inboxStore: new SessionInboxStore(database.db),
      schedule: () => { scheduleCount += 1; },
    });

    const message = makeWorkMessage("#work 帮我实现一个登录页面");
    expect(await launcher.handleWorkCommand(message)).toBe(true);
    expect(await launcher.handleWorkCommand(message)).toBe(true);

    const workSessions = database.db
      .select()
      .from(sessions)
      .where(eq(sessions.kind, "work"))
      .all();
    expect(workSessions).toHaveLength(1);

    const inboxRows = database.db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.session_id, workSessions[0]!.id))
      .all();
    expect(inboxRows).toHaveLength(1);
    expect(scheduleCount).toBe(1);
    expect(channel.outbound).toHaveLength(0);
  });

  test("non-#work message returns false", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore: new SessionStore(database.db),
      messageStore: new MessageStore(database.db),
      inboxStore: new SessionInboxStore(database.db),
      schedule: () => {},
    });
    const handled = await launcher.handleWorkCommand(makeWorkMessage("hello there"));
    expect(handled).toBe(false);
  });
});
