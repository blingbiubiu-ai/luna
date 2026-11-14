import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { SessionStore } from "../../src/sessions/session-store";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { config, setLunaHome } from "../../src/shared";
import { SessionTurnProcessor } from "../../src/work/session-inbound-router";
import { WorkRunner } from "../../src/work/work-runner";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-work-dispatch-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  fixtureSessionOwnership(database.db, "feishu", "feishu-main", "fixture-owner");
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("work turn dispatch by session.kind", () => {
  test("kind='work' routes to WorkRunner, not Main Runner", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-1",
      threadId: "thread-1",
    });

    let workCalled = false;
    const mockWorkRunner = {
      executeWorkTurn: async () => {
        workCalled = true;
      },
    } as unknown as WorkRunner;

    const processor = new SessionTurnProcessor({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      workRunner: mockWorkRunner,
      mainRunner: { run: async () => ({ action: { action: "no_reply" } }) } as never,
      taskRunSupervisor: { startInitialRun: () => {}, restartTaskRun: () => {}, waitForIdle: async () => {} } as never,
    });

    // Minimal turn execution input
    await processor.execute({
      turn: { id: "turn-1", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-1",
        sessionId: session.id,
        channelType: "feishu",
        channelId: "feishu-main",
        externalMessageId: "msg-1",
        channelMessageKey: "msg-1",
        senderIdentityId: null,
        senderUserId: "user-1",
        role: "user",
        messageKind: "user_message",
        contentKind: "text",
        presentationKind: "plain",
        providerMessageType: "text",
        contentJson: [{ type: "text", text: "帮我写个函数" }],
        rawPayloadJson: {},
        occurredAt: Date.now(),
        createdAt: Date.now(),
        session_id: session.id,
        channel_message_key: "msg-1",
        sender_user_id: "user-1",
        message_kind: "user_message",
        content_json: [{ type: "text", text: "帮我写个函数" }],
        raw_payload_json: {},
        created_at: Date.now(),
      }] as never,
    });

    expect(workCalled).toBe(true);
  });

  test("kind='main' does not call WorkRunner", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.resolveByChannelSurface({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-2",
      rootMessageId: "msg-root",
    });

    let workCalled = false;
    const mockWorkRunner = {
      executeWorkTurn: async () => {
        workCalled = true;
      },
    } as unknown as WorkRunner;

    const processor = new SessionTurnProcessor({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      workRunner: mockWorkRunner,
      mainRunner: { run: async () => ({ action: { action: "no_reply" } }) } as never,
      taskRunSupervisor: { startInitialRun: () => {}, restartTaskRun: () => {}, waitForIdle: async () => {} } as never,
    });

    // For main session without mainRunner, execute will throw when trying
    // to run Main Runner — but WorkRunner should not be called first.
    try {
      await processor.execute({
        turn: { id: "turn-2", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
        inboxRows: [],
        messageRows: [{
          id: "msg-2",
          sessionId: session.id,
          channelType: "feishu",
          channelId: "feishu-main",
          externalMessageId: "msg-2",
          channelMessageKey: "msg-2",
          senderIdentityId: null,
          senderUserId: "user-1",
          role: "user",
          messageKind: "user_message",
          contentKind: "text",
          presentationKind: "plain",
          providerMessageType: "text",
          contentJson: [{ type: "text", text: "hi" }],
          rawPayloadJson: {},
          occurredAt: Date.now(),
          createdAt: Date.now(),
          session_id: session.id,
          channel_message_key: "msg-2",
          sender_user_id: "user-1",
          message_kind: "user_message",
          content_json: [{ type: "text", text: "hi" }],
          raw_payload_json: {},
          created_at: Date.now(),
        }] as never,
      });
    } catch {
      // Expected: Main Runner not configured, will throw
    }

    expect(workCalled).toBe(false);
  });
});
