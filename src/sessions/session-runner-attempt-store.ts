import { asc, desc, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { sessionRunnerAttempts } from "@/data/schema";
import { uuid } from "@/shared";

export const MAIN_RUNNER_RAW_OUTPUT_LIMIT_BYTES = 128 * 1024;

export type SessionRunnerAttemptKind = "primary" | "repair";
export type SessionRunnerAttemptStatus =
  | "running"
  | "parsed"
  | "parse_failed"
  | "runner_failed";

export type SessionRunnerAttemptRow = typeof sessionRunnerAttempts.$inferSelect;

export interface CreateRunningSessionRunnerAttemptInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runnerContextId?: string | null;
  readonly runnerType: string;
  readonly runnerSessionId?: string | null;
  readonly attemptKind: SessionRunnerAttemptKind;
  readonly inputPrompt: string;
  readonly repairSourceAttemptId?: string | null;
}

export class SessionRunnerAttemptStore {
  constructor(private readonly _db: DrizzleDB) {}

  createRunning(
    input: CreateRunningSessionRunnerAttemptInput,
  ): SessionRunnerAttemptRow {
    const now = Date.now();
    const row = {
      id: uuid(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      runnerContextId: input.runnerContextId ?? null,
      runnerType: input.runnerType,
      runnerSessionId: input.runnerSessionId ?? null,
      attemptKind: input.attemptKind,
      attemptIndex: this._nextAttemptIndex(input.turnId),
      status: "running",
      inputPrompt: input.inputPrompt,
      rawOutput: null,
      rawOutputTruncated: false,
      parsedActionJson: null,
      parseErrorJson: null,
      repairSourceAttemptId: input.repairSourceAttemptId ?? null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    } satisfies typeof sessionRunnerAttempts.$inferInsert;

    this._db.insert(sessionRunnerAttempts).values(row).run();
    return this.requireById(row.id);
  }

  markParsed(
    id: string,
    input: {
      readonly rawOutput: string;
      readonly parsedActionJson: unknown;
      readonly runnerSessionId?: string | null;
    },
  ): SessionRunnerAttemptRow {
    return this._markTerminal(id, "parsed", {
      rawOutput: input.rawOutput,
      parsedActionJson: input.parsedActionJson,
      parseErrorJson: null,
      ...(input.runnerSessionId !== undefined
        ? { runnerSessionId: input.runnerSessionId }
        : {}),
    });
  }

  markParseFailed(
    id: string,
    input: {
      readonly rawOutput: string;
      readonly parseErrorJson: unknown;
      readonly runnerSessionId?: string | null;
    },
  ): SessionRunnerAttemptRow {
    return this._markTerminal(id, "parse_failed", {
      rawOutput: input.rawOutput,
      parsedActionJson: null,
      parseErrorJson: input.parseErrorJson,
      ...(input.runnerSessionId !== undefined
        ? { runnerSessionId: input.runnerSessionId }
        : {}),
    });
  }

  markRunnerFailed(
    id: string,
    input: {
      readonly rawOutput?: string;
      readonly error: unknown;
      readonly runnerSessionId?: string | null;
    },
  ): SessionRunnerAttemptRow {
    return this._markTerminal(id, "runner_failed", {
      rawOutput: input.rawOutput ?? "",
      parsedActionJson: null,
      parseErrorJson: serializeError(input.error),
      ...(input.runnerSessionId !== undefined
        ? { runnerSessionId: input.runnerSessionId }
        : {}),
    });
  }

  listForTurn(turnId: string): SessionRunnerAttemptRow[] {
    return this._db
      .select()
      .from(sessionRunnerAttempts)
      .where(eq(sessionRunnerAttempts.turnId, turnId))
      .orderBy(
        asc(sessionRunnerAttempts.attemptIndex),
        asc(sessionRunnerAttempts.createdAt),
      )
      .all();
  }

  requireById(id: string): SessionRunnerAttemptRow {
    const row = this._db
      .select()
      .from(sessionRunnerAttempts)
      .where(eq(sessionRunnerAttempts.id, id))
      .get();
    if (row === undefined) {
      throw new Error(`Session runner attempt "${id}" was not found.`);
    }
    return row;
  }

  private _markTerminal(
    id: string,
    status: Exclude<SessionRunnerAttemptStatus, "running">,
    input: {
      readonly rawOutput: string;
      readonly parsedActionJson: unknown;
      readonly parseErrorJson: unknown;
      readonly runnerSessionId?: string | null;
    },
  ): SessionRunnerAttemptRow {
    const rawOutput = truncateRawOutput(input.rawOutput);
    const now = Date.now();
    this._db
      .update(sessionRunnerAttempts)
      .set({
        status,
        rawOutput: rawOutput.value,
        rawOutputTruncated: rawOutput.truncated,
        parsedActionJson: input.parsedActionJson,
        parseErrorJson: input.parseErrorJson,
        ...(input.runnerSessionId !== undefined
          ? { runnerSessionId: input.runnerSessionId }
          : {}),
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(sessionRunnerAttempts.id, id))
      .run();
    return this.requireById(id);
  }

  private _nextAttemptIndex(turnId: string): number {
    const latest = this._db
      .select({ attemptIndex: sessionRunnerAttempts.attemptIndex })
      .from(sessionRunnerAttempts)
      .where(eq(sessionRunnerAttempts.turnId, turnId))
      .orderBy(desc(sessionRunnerAttempts.attemptIndex))
      .limit(1)
      .get();
    return latest === undefined ? 0 : latest.attemptIndex + 1;
  }
}

export function truncateRawOutput(rawOutput: string): {
  readonly value: string;
  readonly truncated: boolean;
} {
  const encoded = new TextEncoder().encode(rawOutput);
  if (encoded.byteLength <= MAIN_RUNNER_RAW_OUTPUT_LIMIT_BYTES) {
    return { value: rawOutput, truncated: false };
  }
  const decoder = new TextDecoder();
  return {
    value: decoder.decode(encoded.slice(0, MAIN_RUNNER_RAW_OUTPUT_LIMIT_BYTES)),
    truncated: true,
  };
}

export function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    const maybeCode = (error as { readonly code?: unknown }).code;
    const maybeCause = (error as { readonly cause?: unknown }).cause;
    const maybeDetails = (error as { readonly details?: unknown }).details;
    const maybeIssues = (error as { readonly issues?: unknown }).issues;
    return toJsonCompatible({
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      ...(typeof maybeCode === "string"
        ? { code: maybeCode }
        : {}),
      ...(maybeDetails !== undefined
        ? { details: serializeErrorPayload(maybeDetails) }
        : {}),
      ...(maybeIssues !== undefined
        ? { issues: serializeErrorPayload(maybeIssues) }
        : {}),
      ...(maybeCause !== undefined
        ? { cause: serializeError(maybeCause) }
        : {}),
    });
  }
  return serializeErrorPayload(error);
}

function serializeErrorPayload(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (isJsonSafe(value)) {
    return toJsonCompatible(value);
  }
  return {
    name: "Error",
    message: String(value),
  };
}

function toJsonCompatible(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

function isJsonSafe(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
