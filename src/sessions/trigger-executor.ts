import { ContextPackStore } from "@/context/context-pack-store";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { eq, desc } from "drizzle-orm";
import { sessions, sessionTurns, messages, sessionTimelineEntries } from "@/data/schema";
import type { DrizzleDB } from "@/data";
import type { MainRunner } from "@/main-runner/main-runner";
import { MainRunnerContextBuilder } from "@/main-runner/context-builder";
import { RunnerContextStore } from "@/runners/runner-context-store";
import type { SessionCommand } from "@/messaging/session-command-service";
export function createSessionTriggerExecutor(db: DrizzleDB, main: () => MainRunner, runnerType: (sessionId: string) => string) {
    return async (command: SessionCommand, signal: AbortSignal) => {
        const packs = new ContextPackStore(db);
        const pack = packs.createPack({ ownerType: "session", ownerId: command.sessionId, kind: "turn_delta", selectionStrategy: "trigger_recent_context", createdForInvocationId: command.id });
        const recent = db.select({ entry: sessionTimelineEntries, message: messages }).from(sessionTimelineEntries).innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId)).where(eq(sessionTimelineEntries.sessionId, command.sessionId)).orderBy(desc(sessionTimelineEntries.createdAt)).limit(30).all().reverse().filter(row => {
            const raw = row.message.rawPayloadJson as Record<string, unknown> | null;
            return (!raw?.deliveryStatus || raw.deliveryStatus === "sent") && raw?.origin !== "session_trigger";
        });
        packs.addItems(pack.id, recent.map(row => ({ itemKind: "message", itemId: row.message.id, sourceSessionId: command.sessionId, sourceEntryId: row.entry.id, sourceMessageId: row.message.id, role: "delta_context", reason: "trigger_recent_context" })));
        const context = new MainRunnerContextBuilder(db).buildForSession(command.sessionId, { deltaContextPackIds: [pack.id] });
        const now = Date.now();
        db.insert(sessionTurns).values({ id: command.id, session_id: command.sessionId, turn_kind: "execution", status: "running", runner_invoked: true, reason: "session_trigger", started_at: now, created_at: now, updated_at: now }).onConflictDoUpdate({ target: sessionTurns.id, set: { status: "running", error: null, completed_at: null, updated_at: now } }).run();
        let detached = false;
        try {
            const runnerContext = new RunnerContextStore(db).resolveForSession(command.sessionId, runnerType(command.sessionId));
            await main().run({ signal, turnId: command.id, runnerContext, input: { type: "session_trigger", triggerId: command.id,
                    instruction: String(command.payload.content), requesterUserId: command.actorUserId, context,
                    artifactRefs: (command.payload.contextRefs as string[] ?? []).map(id => `artifact:${id}`), sourceSessionId: command.sourceSessionId, correlationId: command.correlationId, hops: command.hops } });
            if (signal.aborted)
                throw new Error("Trigger cancelled");

        }
        catch (error) {
            if (error instanceof RuntimeDetachedError) { detached = true; throw error; }
            db.update(sessionTurns).set({ status: "failed", error: String(error), completed_at: Date.now(), updated_at: Date.now() }).where(eq(sessionTurns.id, command.id)).run();
            throw error;
        }
        finally {
            const turn = db.select().from(sessionTurns).where(eq(sessionTurns.id, command.id)).get();
            if (!detached && turn?.status === "running")
                db.update(sessionTurns).set({ status: signal.aborted ? "failed" : "completed", completed_at: Date.now(), updated_at: Date.now() }).where(eq(sessionTurns.id, command.id)).run();
        }
    };
}
