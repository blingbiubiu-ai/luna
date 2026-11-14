import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { sessionInbox } from "../../src/data/schema";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionQueue } from "../../src/sessions/session-queue";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { config, setLunaHome, type SessionConfig } from "../../src/shared";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

const sessionConfig = {
  coalesce_idle_ms: 1, coalesce_max_wait_ms: 25, max_batch_size: 8,
  max_task_actions_per_batch: 3, processing_notice_after_ms: 1500,
  stale_claim_ms: 120000, turn_warn_after_ms: 120000, max_queue_depth: 50,
  activation_context_window_ms: 300000, activation_context_max_messages: 12,
  activation_context_max_chars: 6000, activation_context_recent_unprocessed_messages: 10,
  activation_context_max_cc_reporters: 1, group_bot_aliases: [],
  group_activation_followup_window_ms: 300000,
  group_activation_followup_senders: "requester_and_reporters",
  group_activation_followup_max_messages: 8,
  group_activation_followup_recent_messages: 3,
  group_activation_followup_interrupt_on_other_user: true,
} satisfies SessionConfig;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-steer-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  fixtureSessionOwnership(database.db, "feishu", "f", "u");
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("SessionQueue abort (#steer)", () => {
  test("abort(sessionId) signals the active turn's AbortController", async () => {
    let receivedSignal: AbortSignal | undefined;
    let turnCompleted = false;
    const queue = new SessionQueue({
      db: database.db,
      config: sessionConfig,
      executeTurn: async (_input, signal) => {
        receivedSignal = signal;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        turnCompleted = true;
      },
    });

    const session = new SessionStore(database.db).resolveByChannelSurface({
      channelType: "feishu", channelId: "f", groupId: "g", rootMessageId: "r",
    });
    const messageStore = new MessageStore(database.db);
    const inboxStore = new SessionInboxStore(database.db);
    const msg = messageStore.append({
      sessionId: session.id, channelMessageKey: "m1", senderUserId: "u",
      role: "user", content: [{ type: "text", text: "hi" }],
      channel: { type: "feishu", id: "f" },
      surface: { externalId: "g", kind: "group" as const },
      sender: { externalId: "u", kind: "user" },
      contentKind: "text", presentationKind: "plain", providerMessageType: "text",
    });
    inboxStore.enqueueOnce({ sessionId: session.id, message: msg });
    queue.schedule(session.id);

    await new Promise((r) => setTimeout(r, 50));
    expect(receivedSignal).toBeDefined();

    queue.abort(session.id);

    await queue.waitForIdle().catch(() => {});
    expect(turnCompleted).toBe(false);
    expect(receivedSignal!.aborted).toBe(true);
  });

  test("abort on idle session is a no-op", async () => {
    const queue = new SessionQueue({
      db: database.db,
      config: sessionConfig,
      executeTurn: async () => {},
    });
    // Should not throw
    queue.abort("nonexistent-session");
    await queue.waitForIdle();
  });

  test("idle requeue abort does not affect a later plain abort", async () => {
    const seenTurns: string[][] = [];
    let turnStarted: (() => void) | undefined;
    const turnStartedPromise = new Promise<void>((resolve) => {
      turnStarted = resolve;
    });

    const queue = new SessionQueue({
      db: database.db,
      config: sessionConfig,
      executeTurn: async (input, signal) => {
        const texts = input.messageRows.map((row) => {
          const content = Array.isArray(row.content_json) ? row.content_json : [];
          return content
            .filter((block: { type?: string }) => block.type === "text")
            .map((block: { text?: string }) => block.text ?? "")
            .join("\n");
        });
        seenTurns.push(texts);
        turnStarted?.();
        if (seenTurns.length > 1) {
          return;
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      },
    });

    const session = new SessionStore(database.db).createWorkSession({
      channelType: "feishu",
      channelId: "f",
      groupId: "g",
      threadId: "root",
      rootMessageId: "root",
    });

    queue.abort(session.id, { requeueActiveRows: true });

    const messageStore = new MessageStore(database.db);
    const inboxStore = new SessionInboxStore(database.db);
    const message = messageStore.append({
      sessionId: session.id,
      channelMessageKey: "m1",
      senderUserId: "u",
      role: "user",
      content: [{ type: "text", text: "普通 abort 不应重排" }],
      channel: { type: "feishu", id: "f" },
      surface: { externalId: "g", kind: "group" },
      sender: { externalId: "u", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });
    const inboxRow = inboxStore.enqueueOnce({
      sessionId: session.id,
      message,
    }).row;

    queue.schedule(session.id);
    await turnStartedPromise;
    queue.abort(session.id);
    await queue.waitForIdle().catch(() => {});

    expect(seenTurns).toEqual([["普通 abort 不应重排"]]);
    const inboxAfterAbort = database.db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.id, inboxRow.id))
      .get();
    expect(inboxAfterAbort?.status).toBe("failed");
  });

  test("#steer abort can requeue the active turn rows for the next turn", async () => {
    const seenTurns: string[][] = [];
    let firstTurnStarted: (() => void) | undefined;
    const firstTurnStartedPromise = new Promise<void>((resolve) => {
      firstTurnStarted = resolve;
    });

    const queue = new SessionQueue({
      db: database.db,
      config: sessionConfig,
      executeTurn: async (input, signal) => {
        const texts = input.messageRows.map((row) => {
          const content = Array.isArray(row.content_json) ? row.content_json : [];
          return content
            .filter((block: { type?: string }) => block.type === "text")
            .map((block: { text?: string }) => block.text ?? "")
            .join("\n");
        });
        seenTurns.push(texts);
        if (seenTurns.length === 1) {
          firstTurnStarted?.();
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
        }
      },
    });

    const session = new SessionStore(database.db).createWorkSession({
      channelType: "feishu",
      channelId: "f",
      groupId: "g",
      threadId: "root",
      rootMessageId: "root",
    });
    const messageStore = new MessageStore(database.db);
    const inboxStore = new SessionInboxStore(database.db);

    const firstMessage = messageStore.append({
      sessionId: session.id,
      channelMessageKey: "m1",
      senderUserId: "u",
      role: "user",
      content: [{ type: "text", text: "原始需求" }],
      channel: { type: "feishu", id: "f" },
      surface: { externalId: "g", kind: "group" },
      sender: { externalId: "u", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });
    const firstInbox = inboxStore.enqueueOnce({
      sessionId: session.id,
      message: firstMessage,
    }).row;
    queue.schedule(session.id);
    await firstTurnStartedPromise;

    const steerMessage = messageStore.append({
      sessionId: session.id,
      channelMessageKey: "m2",
      senderUserId: "u",
      role: "user",
      content: [{ type: "text", text: "#steer 改成 TypeScript" }],
      channel: { type: "feishu", id: "f" },
      surface: { externalId: "g", kind: "group" },
      sender: { externalId: "u", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });
    inboxStore.enqueueOnce({
      sessionId: session.id,
      message: steerMessage,
    });
    queue.abort(session.id, { requeueActiveRows: true });
    queue.schedule(session.id);

    await queue.waitForIdle();

    expect(seenTurns).toEqual([
      ["原始需求"],
      ["原始需求", "#steer 改成 TypeScript"],
    ]);
    const firstInboxAfterAbort = database.db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.id, firstInbox.id))
      .get();
    expect(firstInboxAfterAbort?.status).toBe("completed");
  });
});
