export interface TranscriptTerminalSettleOptions {
  /** Return true while the transcript's terminal marker for the current turn has not landed yet. */
  readonly awaitingTerminal: () => boolean;
  readonly onTimeout?: () => void;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
}

export interface TranscriptTerminalSettle {
  request(proceed: () => void): void;
  cancel(): void;
}

export const DEFAULT_TERMINAL_SETTLE_TIMEOUT_MS = 2_000;
export const DEFAULT_TERMINAL_SETTLE_POLL_MS = 100;

/**
 * Bounded settle barrier between an idle signal (PTY screen or Stop hook) and
 * turn finalization. Provider CLIs frequently redraw their idle prompt or run Stop hooks
 * ~50-200ms before flushing the closing JSONL record (`end_turn` / `task_complete`).
 */
export function createTranscriptTerminalSettle(
  options: TranscriptTerminalSettleOptions,
): TranscriptTerminalSettle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TERMINAL_SETTLE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_TERMINAL_SETTLE_POLL_MS;
  const now = options.now ?? Date.now;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    request(proceed: () => void): void {
      clear();
      const mine = ++generation;
      const startedAt = now();
      const tick = (): void => {
        timer = null;
        if (mine !== generation) return;
        let waiting = false;
        try {
          waiting = options.awaitingTerminal();
        } catch {
          waiting = false;
        }
        if (waiting && now() - startedAt < timeoutMs) {
          timer = setTimeout(tick, pollMs);
          timer.unref?.();
          return;
        }
        if (waiting) {
          try { options.onTimeout?.(); } catch { /* observer only */ }
        }
        proceed();
      };
      tick();
    },
    cancel(): void {
      generation += 1;
      clear();
    },
  };
}
