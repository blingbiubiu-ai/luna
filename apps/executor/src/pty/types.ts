import type { ProviderOutput } from "@luna/runner-protocol";
import type { IdleDetectorConfig } from "./idle-detector";

export interface PtyWriteTarget {
  write(data: string): void;
  readonly pid: number;
}

export interface PtySpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly initialSessionId?: string;
  readonly hookEventsFile?: string;
}

export interface PtyTurnDrainResult {
  readonly outputs: readonly ProviderOutput[];
  readonly observedSessionId?: string;
  readonly submitConfirmed: boolean;
  readonly terminal?:
    | { readonly kind: "completed"; readonly finalText: string }
    | { readonly kind: "error"; readonly output: Extract<ProviderOutput, { status: "error" }> }
    | { readonly kind: "aborted"; readonly reason?: string | undefined };
}

export interface PtyTurnBridge {
  /** Poll newly appended transcript bytes and return incremental ProviderOutputs + terminal state. */
  drain(options?: { readonly settleFallback?: boolean }): PtyTurnDrainResult;
}

export interface PtyCliAdapter {
  readonly family: "claude" | "codex";
  readonly idleConfig: IdleDetectorConfig;
  prepareSpawn(input: {
    readonly runnerType: string;
    readonly cwd: string;
    readonly home: string;
    readonly model?: string | undefined;
    readonly resumeSessionId?: string | undefined;
    readonly baseEnv: NodeJS.ProcessEnv;
    readonly controlDir: string;
    readonly turnEnvFile: string;
  }): Promise<PtySpawnSpec>;
  beginTurn(input: {
    readonly prompt: string;
    readonly cwd: string;
    readonly home: string;
    readonly env: NodeJS.ProcessEnv;
    readonly cliPid: number;
    readonly currentSessionId?: string | undefined;
  }): {
    readonly bridge: PtyTurnBridge;
    submit(pty: PtyWriteTarget): Promise<{ readonly submitted: boolean; readonly sessionId?: string | undefined; readonly failureReason?: string | undefined }>;
  };
  normalizeExitFailure(message: string): {
    readonly failure: Extract<ProviderOutput, { status: "error" }>["failure"];
    readonly code?: string;
  };
}

/** Commands sent from root Executor (PtyExecutionDriver) to unprivileged pty-main.js over stdin JSONL. */
export type PtyHostCommand =
  | {
      readonly type: "init";
      readonly runnerType: "claude" | "codex";
      readonly model?: string;
      readonly sessionId?: string;
      readonly staticEnv: Record<string, string>;
      readonly idleTimeoutMs?: number;
    }
  | {
      readonly type: "run_turn";
      readonly turnId: string;
      readonly prompt: string;
      readonly sessionId?: string;
      readonly turnEnv: Record<string, string>;
      readonly idleTimeoutMs?: number;
    }
  | {
      readonly type: "set_idle_timeout";
      readonly idleTimeoutMs: number;
    }
  | {
      readonly type: "update_credentials";
      readonly turnId: string;
      readonly turnEnv: Record<string, string>;
    }
  | {
      readonly type: "cancel_turn";
      readonly turnId: string;
    }
  | {
      readonly type: "attach_viewer";
      readonly viewerId: string;
      readonly cols?: number;
      readonly rows?: number;
    }
  | {
      readonly type: "detach_viewer";
      readonly viewerId: string;
    }
  | {
      readonly type: "pty_input";
      readonly data: string;
    }
  | {
      readonly type: "pty_resize";
      readonly cols: number;
      readonly rows: number;
    }
  | {
      readonly type: "shutdown";
    };

/** Framed events emitted by pty-main.js to Executor over stdout (parsed by StreamEventParser). */
export type PtyHostEvent =
  | { readonly status: "host_ready"; readonly sessionId?: string }
  | { readonly status: "turn_output"; readonly turnId: string; readonly output: ProviderOutput }
  | { readonly status: "turn_done"; readonly turnId: string; readonly outcome: "succeeded" | "failed" | "cancelled"; readonly sessionId?: string }
  | { readonly status: "pty_replay"; readonly viewerId: string; readonly data: string; readonly sessionId?: string }
  | { readonly status: "pty_data"; readonly data: string }
  | { readonly status: "session_closed"; readonly reason: string };

export interface PtySessionSummary {
  readonly contextId: string;
  readonly runnerType: "claude" | "codex";
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly busy: boolean;
  readonly privileged: boolean;
  readonly pid: number;
  readonly startedAt: number;
  readonly lastActiveAt: number;
}
