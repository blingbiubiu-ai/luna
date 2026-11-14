import { expect, test } from "bun:test";
import { SessionDispatcher } from "../../src/sessions/session-dispatcher";

test("user and task-result triggers share FIFO execution while other sessions proceed", async () => {
  const dispatcher = new SessionDispatcher();
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = dispatcher.dispatch({ kind: "user_messages", sessionId: "a" }, async () => {
    events.push("user-start"); await blocked; events.push("user-end");
  });
  const second = dispatcher.dispatch({ kind: "task_result", sessionId: "a" }, async () => { events.push("task"); });
  await dispatcher.dispatch({ kind: "user_messages", sessionId: "b" }, async () => { events.push("other"); });
  expect(events).toEqual(["user-start", "other"]);
  release(); await Promise.all([first, second]);
  expect(events).toEqual(["user-start", "other", "user-end", "task"]);
});

test("a failed trigger releases the session lane", async () => {
  const dispatcher = new SessionDispatcher();
  await expect(dispatcher.dispatch({ kind: "task_result", sessionId: "a" }, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
  expect(await dispatcher.dispatch({ kind: "user_messages", sessionId: "a" }, async () => 42)).toBe(42);
});
