import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { RunnerContextStore } from "@/runners/runner-context-store";
import { SessionCommandService } from "@/messaging/session-command-service";
import {
  commandInFlight,
  ensureDedicatedLocalSession,
  isSelfRoutineOrigin,
  prepareSelfRoutineRun,
  runSelfRoutines,
  SELF_ROUTINE_ORIGINS,
  selfRoutineKindOfOrigin,
  selfRoutineKindOfTrigger,
  sessionBusy,
  type SelfRoutine,
} from "@/agents/self-routines";
import { fixtureNamedSession } from "../helpers/platform-fixtures";

const NOW = 1_800_000_000_000;
let home: string;
let db: DataConnection<typeof schema>;
let commands: SessionCommandService;
let scope: ReturnType<typeof fixtureNamedSession>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-self-routines-"));
  setLunaHome(home);
  db = new DataConnection(schema);
  scope = fixtureNamedSession(db.db, "session", "alice");
  commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("origin registry resolves reflection, consolidation, heartbeat and request_expiry prefixes", () => {
  expect(selfRoutineKindOfOrigin(`${SELF_ROUTINE_ORIGINS.reflection}msg-1`)).toBe("reflection");
  expect(selfRoutineKindOfOrigin(`${SELF_ROUTINE_ORIGINS.consolidation}agent-1:1`)).toBe("consolidation");
  expect(selfRoutineKindOfOrigin(`${SELF_ROUTINE_ORIGINS.heartbeat}shadow-1:1`)).toBe("heartbeat");
  expect(selfRoutineKindOfOrigin(`${SELF_ROUTINE_ORIGINS.request_expiry}req-1`)).toBe("request_expiry");
  expect(selfRoutineKindOfOrigin("user-turn:1")).toBeUndefined();
  expect(isSelfRoutineOrigin(`${SELF_ROUTINE_ORIGINS.heartbeat}s1`)).toBe(true);
  expect(isSelfRoutineOrigin("user-turn:1")).toBe(false);
});

test("runSelfRoutines isolates candidate and routine failures without blocking subsequent routines", () => {
  const failingRoutine: SelfRoutine<string> = {
    kind: "reflection",
    originPrefix: SELF_ROUTINE_ORIGINS.reflection,
    commandKey: "reflect",
    enabled: () => true,
    findDue: () => ["missing-session", "session"],
    resolveSessionId: (_ctx, id) => id,
    actorUserId: () => "user:alice",
    originId: (_ctx, id) => `${SELF_ROUTINE_ORIGINS.reflection}${id}`,
    instruction: () => "reflect",
  };
  const crashingRoutine: SelfRoutine<string> = {
    kind: "consolidation",
    originPrefix: SELF_ROUTINE_ORIGINS.consolidation,
    commandKey: "consolidate",
    enabled: () => true,
    findDue: () => {
      throw new Error("boom");
    },
    resolveSessionId: () => "session",
    actorUserId: () => "user:alice",
    originId: () => `${SELF_ROUTINE_ORIGINS.consolidation}1`,
    instruction: () => "consolidate",
  };
  const healthyRoutine: SelfRoutine<string> = {
    kind: "heartbeat",
    originPrefix: SELF_ROUTINE_ORIGINS.heartbeat,
    commandKey: "heartbeat",
    enabled: () => true,
    findDue: () => ["hb-1"],
    resolveSessionId: ({ db: routineDb }) =>
      ensureDedicatedLocalSession(routineDb, {
        agentId: scope.agentId,
        shadowId: scope.shadowId,
        ownerUserId: "user:alice",
        title: "心跳",
      }).id,
    actorUserId: () => "user:alice",
    originId: () => `${SELF_ROUTINE_ORIGINS.heartbeat}1`,
    instruction: () => "heartbeat",
  };

  const results = runSelfRoutines(
    { db: db.db, commands, now: NOW },
    [failingRoutine, crashingRoutine, healthyRoutine],
  );
  expect(results.reflection).toHaveLength(1);
  expect(results.consolidation).toEqual([]);
  expect(results.heartbeat).toHaveLength(1);
  expect(selfRoutineKindOfTrigger(db.db, results.heartbeat![0]!)).toBe("heartbeat");
  expect(commandInFlight(db.db, results.heartbeat![0]!)).toBe(true);
});

test("ensureDedicatedLocalSession reuses active local session and recreates when disabled", () => {
  let savedId: string | undefined;
  const first = ensureDedicatedLocalSession(db.db, {
    agentId: scope.agentId,
    shadowId: scope.shadowId,
    ownerUserId: "user:alice",
    title: "心跳",
    onCreated: id => {
      savedId = id;
    },
  });
  expect(savedId).toBe(first.id);
  expect(first.title).toBe("心跳");

  const second = ensureDedicatedLocalSession(db.db, {
    agentId: scope.agentId,
    shadowId: scope.shadowId,
    ownerUserId: "user:alice",
    existingSessionId: first.id,
    title: "心跳",
  });
  expect(second.id).toBe(first.id);

  db.db.update(schema.sessions).set({ status: "archived" }).where(eq(schema.sessions.id, first.id)).run();
  const third = ensureDedicatedLocalSession(db.db, {
    agentId: scope.agentId,
    shadowId: scope.shadowId,
    ownerUserId: "user:alice",
    existingSessionId: first.id,
    title: "心跳",
  });
  expect(third.id).not.toBe(first.id);
});

test("sessionBusy detects pending session.invoke and prepareSelfRoutineRun resets fresh-context routines", () => {
  expect(sessionBusy(db.db, "session")).toBe(false);
  const hbSession = ensureDedicatedLocalSession(db.db, {
    agentId: scope.agentId,
    shadowId: scope.shadowId,
    ownerUserId: "user:alice",
    title: "心跳",
  });
  const ctx = new RunnerContextStore(db.db).resolveForSession(hbSession.id, "codex");
  db.db
    .update(schema.runnerContexts)
    .set({ runner_session_id: "prov-session-1" })
    .where(eq(schema.runnerContexts.id, ctx.id))
    .run();

  const cmd = commands.accept(
    { userId: "user:alice", sourceSessionId: hbSession.id, originId: `${SELF_ROUTINE_ORIGINS.heartbeat}1` },
    hbSession.id,
    "session.invoke",
    "heartbeat",
    { content: "hb", purpose: "notification" },
  );
  expect(sessionBusy(db.db, hbSession.id)).toBe(true);

  prepareSelfRoutineRun(db.db, cmd, true);
  expect(
    db.db.select().from(schema.runnerContexts).where(eq(schema.runnerContexts.id, ctx.id)).get()?.runner_session_id,
  ).toBe("prov-session-1");

  prepareSelfRoutineRun(db.db, cmd, false);
  expect(
    db.db.select().from(schema.runnerContexts).where(eq(schema.runnerContexts.id, ctx.id)).get()?.runner_session_id,
  ).toBeNull();
});
