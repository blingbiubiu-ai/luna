import { describe, expect, test } from "bun:test";

import { selectActivationContext } from "../../src/main-runner/activation-context";
import type { MessageRow } from "../../src/sessions/message-store";

function makeRow(input: {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
}): MessageRow {
  return {
    id: input.id,
    role: "user",
    session_id: "session-1",
    channel_message_key: input.id,
    sender_user_id: "user-1",
    message_kind: "user_message",
    content_json: [{ type: "text", text: input.text }],
    created_at: input.createdAt,
  };
}

describe("selectActivationContext", () => {
  test("keeps window semantics when recent messages already satisfy the minimum", () => {
    const windowRows = [
      makeRow({ id: "m1", text: "recent 1", createdAt: 9_000 }),
      makeRow({ id: "m2", text: "recent 2", createdAt: 9_500 }),
      makeRow({ id: "m3", text: "recent 3", createdAt: 9_900 }),
    ];
    const messageStore = {
      listRecentUserMessagesBefore: () => windowRows,
      listRecentSkippedUserMessagesBefore: () => [],
      listLatestUserMessagesBefore: () => {
        throw new Error("fallback query should not run");
      },
    };

    const result = selectActivationContext({
      messageStore: messageStore as never,
      sessionId: "session-1",
      activationMessageRow: makeRow({ id: "current", text: "@bot hi", createdAt: 10_000 }),
      config: {
        activation_context_window_ms: 300_000,
        activation_context_max_messages: 12,
        activation_context_max_chars: 6_000,
        activation_context_recent_unprocessed_messages: 10,
      },
      minimumRecentMessages: 3,
    });

    expect(result.map((row) => row.messageId)).toEqual(["m1", "m2", "m3"]);
  });

  test("expands to recent user history when the window has too few messages", () => {
    const old1 = makeRow({ id: "m1", text: "older 1", createdAt: 1_000 });
    const old2 = makeRow({ id: "m2", text: "older 2", createdAt: 2_000 });
    const recent = makeRow({ id: "m3", text: "recent 3", createdAt: 9_900 });
    const messageStore = {
      listRecentUserMessagesBefore: () => [recent],
      listRecentSkippedUserMessagesBefore: () => [],
      listLatestUserMessagesBefore: () => [old1, old2, recent],
    };

    const result = selectActivationContext({
      messageStore: messageStore as never,
      sessionId: "session-1",
      activationMessageRow: makeRow({ id: "current", text: "@bot hi", createdAt: 10_000 }),
      config: {
        activation_context_window_ms: 300_000,
        activation_context_max_messages: 12,
        activation_context_max_chars: 6_000,
        activation_context_recent_unprocessed_messages: 10,
      },
      minimumRecentMessages: 3,
    });

    expect(result.map((row) => row.messageId)).toEqual(["m1", "m2", "m3"]);
  });

  test("still obeys activation context max message and char caps during fallback", () => {
    const olderRows = [
      makeRow({ id: "m1", text: "alpha", createdAt: 1_000 }),
      makeRow({ id: "m2", text: "bravo", createdAt: 2_000 }),
      makeRow({ id: "m3", text: "charlie", createdAt: 3_000 }),
    ];
    const messageStore = {
      listRecentUserMessagesBefore: () => [],
      listRecentSkippedUserMessagesBefore: () => [],
      listLatestUserMessagesBefore: () => olderRows,
    };

    const result = selectActivationContext({
      messageStore: messageStore as never,
      sessionId: "session-1",
      activationMessageRow: makeRow({ id: "current", text: "@bot hi", createdAt: 10_000 }),
      config: {
        activation_context_window_ms: 300_000,
        activation_context_max_messages: 2,
        activation_context_max_chars: 11,
        activation_context_recent_unprocessed_messages: 10,
      },
      minimumRecentMessages: 3,
    });

    expect(result.map((row) => row.messageId)).toEqual(["m3"]);
  });

  test("does not expand history unless the caller requests a minimum recent count", () => {
    const recent = makeRow({ id: "m3", text: "recent 3", createdAt: 9_900 });
    const messageStore = {
      listRecentUserMessagesBefore: () => [recent],
      listRecentSkippedUserMessagesBefore: () => [],
      listLatestUserMessagesBefore: () => {
        throw new Error("fallback query should not run without an explicit minimum");
      },
    };

    const result = selectActivationContext({
      messageStore: messageStore as never,
      sessionId: "session-1",
      activationMessageRow: makeRow({ id: "current", text: "follow-up", createdAt: 10_000 }),
      config: {
        activation_context_window_ms: 300_000,
        activation_context_max_messages: 12,
        activation_context_max_chars: 6_000,
        activation_context_recent_unprocessed_messages: 10,
      },
    });

    expect(result.map((row) => row.messageId)).toEqual(["m3"]);
  });
});
