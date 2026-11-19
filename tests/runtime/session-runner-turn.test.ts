import { expect, test } from "bun:test";
import type { ResolvedRunnerContext } from "../../src/runners/runner-context-store";
import type { SessionRunnerAttemptRow, SessionRunnerAttemptStore } from "../../src/sessions/session-runner-attempt-store";
import type { AgentExecutionSnapshot } from "../../src/agent-config";
import { contextFileSurface, syncAgentCompatibility, turnAttempt } from "../../src/runners/session-runner-turn";

const context = { id: "ctx", runner_session_id: "provider-session" } as ResolvedRunnerContext;

test("a turn reuses its running attempt in the same context and otherwise starts one", () => {
  const rows: Partial<SessionRunnerAttemptRow>[] = [
    { id: "done", status: "parsed", runnerContextId: "ctx" },
    { id: "other-context", status: "running", runnerContextId: "other" },
  ];
  const created: unknown[] = [];
  const store = {
    listForTurn: () => rows,
    createRunning: (input: unknown) => { created.push(input); return { id: "new" }; },
  } as unknown as SessionRunnerAttemptStore;
  const input = { sessionId: "s", turnId: "t", runnerContext: context, runnerType: "codex", inputPrompt: "p" };
  expect(turnAttempt(store, input).id).toBe("new");
  expect(created).toEqual([{ sessionId: "s", turnId: "t", runnerContextId: "ctx", runnerType: "codex", runnerSessionId: "provider-session", attemptKind: "primary", inputPrompt: "p" }]);
  rows.push({ id: "running", status: "running", runnerContextId: "ctx" });
  expect(turnAttempt(store, input).id).toBe("running");
  expect(created).toHaveLength(1);
});

test("compatibility follows the Agent's provider and model only when both a store and a snapshot exist", () => {
  const calls: unknown[] = [];
  const updated = { ...context, runner_session_id: null } as ResolvedRunnerContext;
  const store = { syncAgentCompatibility: (id: string, fingerprints: unknown) => { calls.push([id, fingerprints]); return { runnerContext: updated }; } };
  const snapshot = { providerFingerprint: "p", modelFingerprint: "m", resumeOnModelChange: false } as AgentExecutionSnapshot;
  expect(syncAgentCompatibility(undefined, context, snapshot)).toBe(context);
  expect(syncAgentCompatibility(store as never, context, undefined)).toBe(context);
  expect(syncAgentCompatibility(store as never, context, snapshot)).toBe(updated);
  expect(calls).toEqual([["ctx", { providerFingerprint: "p", modelFingerprint: "m", resumeOnModelChange: false }]]);
});

test("a context file never carries the sender's raw provider profile", () => {
  const surface = { externalId: "chat", kind: "group", rawProfile: { secret: true } } as never;
  expect(contextFileSurface(surface)).toEqual({ externalId: "chat", kind: "group" } as never);
});
