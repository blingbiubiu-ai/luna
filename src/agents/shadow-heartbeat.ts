import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import {
  agentShadows,
  lunaAgents,
  memoryConsolidations,
  sessionCommands,
  shadowHeartbeats,
} from "@/data/schema";
import type { SessionCommandService } from "@/messaging/session-command-service";
import { resolvePromptAssetsRoot } from "@/runners/runner-prompts";
import { AgentStore } from "./agent-store";
import { inert } from "./agent-memory-maintenance";
import { resolveProactivitySettings } from "./agent-settings-store";
import {
  commandInFlight,
  ensureDedicatedLocalSession,
  runSelfRoutine,
  SELF_ROUTINE_ORIGINS,
  type SelfRoutine,
  type SelfRoutineContext,
} from "./self-routines";
import { queryShadowActivity, type ShadowActivityReport } from "./shadow-activity";

const HEARTBEAT_ORIGIN = SELF_ROUTINE_ORIGINS.heartbeat;
const RUN_EXPIRES_MS = 60 * 60 * 1000;

let cachedHeartbeatRolePrompt: string | undefined;
function loadHeartbeatRolePrompt(): string {
  if (cachedHeartbeatRolePrompt !== undefined) return cachedHeartbeatRolePrompt;
  cachedHeartbeatRolePrompt = readFileSync(
    join(resolvePromptAssetsRoot(), "heartbeat", "role.md"),
    "utf-8",
  ).trim();
  return cachedHeartbeatRolePrompt;
}

function formatIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function renderHeartbeatInstruction(
  now: number,
  report: ShadowActivityReport,
): string {
  const role = loadHeartbeatRolePrompt();
  const sections: string[] = [
    role,
    `Current time: ${formatIso(now)} (activity window since ${formatIso(report.since)}).`,
  ];

  if (report.messagesBySession.length) {
    sections.push(
      [
        "New human messages by session:",
        ...report.messagesBySession.map(
          item =>
            `- [session:${item.sessionId}] (${item.surfaceKind}${item.title ? `, "${inert(item.title)}"` : ""}): ${item.messageCount} message(s), latest ${item.latestMessageId} at ${formatIso(item.latestMessageAt)} from ${item.senderUserIds.join(", ")}`,
        ),
      ].join("\n"),
    );
  }

  if (report.taskRuns.length) {
    sections.push(
      [
        "Settled Task Runs:",
        ...report.taskRuns.map(
          item =>
            `- [task:${item.taskId}] run ${item.runId} (${item.status}) "${inert(item.taskTitle)}"${item.primarySessionId ? ` in session:${item.primarySessionId}` : ""} at ${formatIso(item.finishedAt)}`,
        ),
      ].join("\n"),
    );
  }

  if (report.scheduleOccurrences.length) {
    sections.push(
      [
        "Settled schedule occurrences:",
        ...report.scheduleOccurrences.map(
          item =>
            `- [schedule:${item.scheduleId}] occurrence ${item.occurrenceId} (${item.actionKind}, ${item.status}${item.reason ? `: ${inert(item.reason)}` : ""})${item.scheduleTitle ? ` "${inert(item.scheduleTitle)}"` : ""} -> session:${item.targetSessionId} at ${formatIso(item.createdAt)}`,
        ),
      ].join("\n"),
    );
  }

  if (report.correlatedRequests.length) {
    sections.push(
      [
        "Settled correlated requests:",
        ...report.correlatedRequests.map(
          item =>
            `- [request:${item.requestId}] (${item.kind}, ${item.status}) origin session:${item.originSessionId} -> target session:${item.targetSessionId} at ${formatIso(item.updatedAt)}`,
        ),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

interface HeartbeatCandidate {
  readonly agentId: string;
  readonly shadowId: string;
  readonly state: typeof shadowHeartbeats.$inferSelect | null;
  readonly since: number;
  readonly report: ShadowActivityReport;
}

export function createShadowHeartbeatRoutine(): SelfRoutine<HeartbeatCandidate> {
  return {
    kind: "heartbeat",
    originPrefix: HEARTBEAT_ORIGIN,
    commandKey: "heartbeat",
    freshProviderContext: true,
    expiresMs: RUN_EXPIRES_MS,
    enabled: () => true,
    findDue({ db, now }: SelfRoutineContext): readonly HeartbeatCandidate[] {
      const rows = db
        .select({
          shadow: agentShadows,
          agent: lunaAgents,
          state: shadowHeartbeats,
          consolidation: memoryConsolidations,
        })
        .from(agentShadows)
        .innerJoin(lunaAgents, eq(lunaAgents.id, agentShadows.agentId))
        .leftJoin(
          shadowHeartbeats,
          eq(shadowHeartbeats.shadowId, agentShadows.id),
        )
        .leftJoin(
          memoryConsolidations,
          eq(memoryConsolidations.agentId, lunaAgents.id),
        )
        .where(
          and(
            eq(agentShadows.status, "active"),
            eq(lunaAgents.status, "active"),
          ),
        )
        .all();

      const candidates: HeartbeatCandidate[] = [];
      for (const { shadow, agent, state, consolidation } of rows) {
        const intervalMs = resolveProactivitySettings(
          db,
          agent.id,
        ).heartbeatIntervalMs;
        if (intervalMs <= 0) continue;
        const referenceAt = state ? state.lastQueuedAt : shadow.createdAt;
        if (now - referenceAt < intervalMs) continue;
        if (commandInFlight(db, state?.commandId)) continue;

        const prevStatus = state?.commandId
          ? db
              .select({ status: sessionCommands.status })
              .from(sessionCommands)
              .where(eq(sessionCommands.id, state.commandId))
              .get()?.status
          : undefined;
        // If a previous heartbeat did not complete, re-evaluate from `coveredFrom`.
        // On first-ever heartbeat with no state row yet, look back one interval so historic backlog does not flood.
        const since =
          prevStatus !== undefined && prevStatus !== "completed"
            ? state!.coveredFrom
            : state
              ? state.cursorAt
              : Math.max(0, now - intervalMs);

        const excludeIds = [
          state?.sessionId,
          consolidation?.sessionId,
        ].filter((id): id is string => Boolean(id));

        const report = queryShadowActivity(db, shadow.id, {
          since,
          excludeSessionIds: excludeIds,
        });
        if (!report.hasWakeActivity) continue;

        candidates.push({
          agentId: agent.id,
          shadowId: shadow.id,
          state,
          since,
          report,
        });
      }
      return candidates;
    },
    resolveSessionId({ db, now }, candidate) {
      const ownerUserId = new AgentStore(db).ownerUserId(candidate.agentId);
      const session = ensureDedicatedLocalSession(db, {
        agentId: candidate.agentId,
        shadowId: candidate.shadowId,
        ownerUserId,
        existingSessionId: candidate.state?.sessionId,
        title: "心跳",
        onCreated: sessionId => {
          db.insert(shadowHeartbeats)
            .values({
              shadowId: candidate.shadowId,
              agentId: candidate.agentId,
              sessionId,
              cursorAt: candidate.state?.cursorAt ?? candidate.since,
              coveredFrom: candidate.state?.coveredFrom ?? candidate.since,
              lastQueuedAt: candidate.state?.lastQueuedAt ?? 0,
              commandId: candidate.state?.commandId ?? null,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: shadowHeartbeats.shadowId,
              set: { sessionId, updatedAt: now },
            })
            .run();
        },
      });
      return session.id;
    },
    actorUserId: ({ db }, candidate) =>
      new AgentStore(db).ownerUserId(candidate.agentId),
    originId: ({ now }, candidate) =>
      `${HEARTBEAT_ORIGIN}${candidate.shadowId}:${now}`,
    instruction: ({ now }, candidate) =>
      renderHeartbeatInstruction(now, candidate.report),
    onQueued({ db, now }, candidate, command) {
      const nextCursor = Math.max(now, candidate.report.latestCursorAt);
      db.insert(shadowHeartbeats)
        .values({
          shadowId: candidate.shadowId,
          agentId: candidate.agentId,
          sessionId: command.sessionId,
          cursorAt: nextCursor,
          coveredFrom: candidate.since,
          lastQueuedAt: now,
          commandId: command.id,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: shadowHeartbeats.shadowId,
          set: {
            sessionId: command.sessionId,
            cursorAt: nextCursor,
            coveredFrom: candidate.since,
            lastQueuedAt: now,
            commandId: command.id,
            updatedAt: now,
          },
        })
        .run();
    },
    onFailed(_ctx, candidate, error) {
      console.warn("shadow heartbeat was not queued", {
        shadowId: candidate.shadowId,
        error: String(error),
      });
    },
  };
}

export function scheduleShadowHeartbeats(
  db: DrizzleDB,
  commands: Pick<SessionCommandService, "accept">,
  now = Date.now(),
): string[] {
  return runSelfRoutine({ db, commands, now }, createShadowHeartbeatRoutine());
}

/**
 * Manually triggers an immediate heartbeat checkup for a Shadow from the Dashboard,
 * bypassing the interval gate and running even when no new wake activity has arrived.
 */
export function triggerShadowHeartbeatNow(
  db: DrizzleDB,
  commands: Pick<SessionCommandService, "accept">,
  shadowId: string,
  now = Date.now(),
): {
  readonly commandId: string;
  readonly sessionId: string;
  readonly alreadyRunning: boolean;
} {
  const agents = new AgentStore(db);
  const shadow = agents.shadow(shadowId);
  const agent = agents.get(shadow.agentId);
  if (shadow.status !== "active" || agent.status !== "active") {
    throw new Error("Shadow or Agent is not active");
  }
  const state = db
    .select()
    .from(shadowHeartbeats)
    .where(eq(shadowHeartbeats.shadowId, shadowId))
    .get();
  if (state?.commandId && commandInFlight(db, state.commandId)) {
    return {
      commandId: state.commandId,
      sessionId: state.sessionId,
      alreadyRunning: true,
    };
  }
  const consolidation = db
    .select()
    .from(memoryConsolidations)
    .where(eq(memoryConsolidations.agentId, shadow.agentId))
    .get();
  const intervalMs =
    resolveProactivitySettings(db, shadow.agentId).heartbeatIntervalMs ||
    30 * 60_000;
  const since = state ? state.cursorAt : Math.max(0, now - intervalMs);
  const sessionId = ensureShadowHeartbeatSession(db, shadowId, now);
  const excludeIds = [sessionId, consolidation?.sessionId].filter(
    (id): id is string => Boolean(id),
  );
  const report = queryShadowActivity(db, shadowId, {
    since,
    excludeSessionIds: excludeIds,
  });
  const baseInstruction = renderHeartbeatInstruction(now, report);
  const content = report.hasWakeActivity
    ? baseInstruction
    : `${baseInstruction}\n\nManual trigger note: No new wake activity was recorded since the last cursor, because the Agent owner requested an immediate heartbeat checkup from Dashboard. Review your duties, schedules, open requests, and heartbeat journal; finish quietly if nothing needs follow-up.`;

  const ownerUserId = agents.ownerUserId(shadow.agentId);
  const command = commands.accept(
    {
      userId: ownerUserId,
      sourceSessionId: sessionId,
      originId: `${HEARTBEAT_ORIGIN}${shadowId}:manual:${now}`,
    },
    sessionId,
    "session.invoke",
    "heartbeat",
    { content, purpose: "notification" },
    { expiresAt: now + RUN_EXPIRES_MS },
  );
  const nextCursor = Math.max(now, report.latestCursorAt);
  db.insert(shadowHeartbeats)
    .values({
      shadowId,
      agentId: shadow.agentId,
      sessionId,
      cursorAt: nextCursor,
      coveredFrom: since,
      lastQueuedAt: now,
      commandId: command.id,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: shadowHeartbeats.shadowId,
      set: {
        sessionId,
        cursorAt: nextCursor,
        coveredFrom: since,
        lastQueuedAt: now,
        commandId: command.id,
        updatedAt: now,
      },
    })
    .run();

  return {
    commandId: command.id,
    sessionId,
    alreadyRunning: false,
  };
}

/** Ensures and returns a Shadow's dedicated local Heartbeat session (`self` address target). */
export function ensureShadowHeartbeatSession(
  db: DrizzleDB,
  shadowId: string,
  now = Date.now(),
): string {
  const shadow = new AgentStore(db).shadow(shadowId);
  const ownerUserId = new AgentStore(db).ownerUserId(shadow.agentId);
  const state = db
    .select()
    .from(shadowHeartbeats)
    .where(eq(shadowHeartbeats.shadowId, shadowId))
    .get();
  const session = ensureDedicatedLocalSession(db, {
    agentId: shadow.agentId,
    shadowId,
    ownerUserId,
    existingSessionId: state?.sessionId,
    title: "心跳",
    onCreated: sessionId => {
      db.insert(shadowHeartbeats)
        .values({
          shadowId,
          agentId: shadow.agentId,
          sessionId,
          cursorAt: state?.cursorAt ?? now,
          coveredFrom: state?.coveredFrom ?? now,
          lastQueuedAt: state?.lastQueuedAt ?? 0,
          commandId: state?.commandId ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: shadowHeartbeats.shadowId,
          set: { sessionId, updatedAt: now },
        })
        .run();
    },
  });
  return session.id;
}
