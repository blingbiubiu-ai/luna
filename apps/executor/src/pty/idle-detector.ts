import { stripAnsiScreenText } from "./viewport";

const SPINNER_RE = /[·✢✳✶✻✽\u2800-\u28ff■⬝]/;

export interface IdleDetectorConfig {
  readonly readyPattern: RegExp;
  readonly busyPattern?: RegExp;
  readonly completionPattern?: RegExp;
  readonly startupPendingPattern?: RegExp;
  readonly startupReadyPattern?: RegExp;
  readonly isViewportReady?: (viewportText: string) => boolean;
  readonly quiescenceMs?: number;
  readonly spinnerGuardMs?: number;
  readonly now?: () => number;
}

export type IdleSignalSource = "screen" | "hook";

/**
 * Tracks interactive CLI readiness and turn quiescence from PTY output,
 * rendered viewport checks, and optional structured hook callbacks.
 */
export class PtyIdleDetector {
  private readonly quiescenceMs: number;
  private readonly spinnerGuardMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rollingTail = "";
  private startupTail = "";
  private startupComplete: boolean;
  private readySeen = false;
  private lastSpinnerAt = 0;
  private idle = false;
  private onIdleCallback?: (source: IdleSignalSource) => void;

  constructor(
    private readonly config: IdleDetectorConfig,
    private readonly readViewport: () => { full: string; bottom: string },
  ) {
    this.quiescenceMs = config.quiescenceMs ?? 2_000;
    this.spinnerGuardMs = config.spinnerGuardMs ?? 3_000;
    this.now = config.now ?? Date.now;
    this.startupComplete = !config.startupReadyPattern && !config.startupPendingPattern;
  }

  onIdle(cb: (source: IdleSignalSource) => void): void {
    this.onIdleCallback = cb;
  }

  isIdle(): boolean {
    return this.idle;
  }

  isStartupComplete(): boolean {
    return this.startupComplete;
  }

  /** Reset before submitting a new user turn so old prompt evidence does not fire prematurely. */
  resetForTurn(): void {
    this.clearTimer();
    this.idle = false;
    this.readySeen = false;
    this.rollingTail = "";
  }

  /** External SessionStart hook arrived (e.g. Claude Code settings hook). */
  notifyHookStartupReady(): void {
    this.startupComplete = true;
    this.readySeen = true;
    this.scheduleCheck(300);
  }

  /** External Stop / StopFailure hook arrived at the end of a turn. */
  notifyHookTurnStopped(): void {
    this.startupComplete = true;
    this.clearTimer();
    if (!this.idle) {
      this.idle = true;
      this.onIdleCallback?.("hook");
    }
  }

  feed(rawChunk: string): void {
    const stripped = stripAnsiScreenText(rawChunk);
    if (!this.startupComplete) {
      this.startupTail = (this.startupTail + stripped).slice(-8192);
      const pending = this.config.startupPendingPattern?.test(this.startupTail) ?? false;
      if (this.config.startupReadyPattern?.test(this.startupTail)) {
        this.startupComplete = true;
      } else if (!this.config.startupReadyPattern && !pending && this.config.readyPattern.test(stripped)) {
        this.startupComplete = true;
      }
    }

    if (SPINNER_RE.test(stripped)) {
      this.lastSpinnerAt = this.now();
    }

    this.rollingTail = (this.rollingTail + stripped).slice(-4096);
    if (this.config.readyPattern.test(this.rollingTail)) {
      this.readySeen = true;
    }

    if (this.idle && this.config.busyPattern?.test(stripped)) {
      this.idle = false;
    }

    const delay = this.config.completionPattern?.test(stripped)
      ? Math.min(400, this.quiescenceMs)
      : this.quiescenceMs;
    this.scheduleCheck(delay);
  }

  /** Re-evaluate current viewport directly (e.g. during cold-start wait). */
  recheckViewport(): void {
    const { full, bottom } = this.readViewport();
    if (!this.startupComplete) {
      if (this.config.startupReadyPattern?.test(full) || this.config.isViewportReady?.(full)) {
        this.startupComplete = true;
      }
    }
    if (this.config.readyPattern.test(bottom) || this.config.isViewportReady?.(full)) {
      this.readySeen = true;
    }
    this.evaluate();
  }

  dispose(): void {
    this.clearTimer();
  }

  private scheduleCheck(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.evaluate();
    }, delayMs);
    this.timer.unref?.();
  }

  private evaluate(): void {
    if (this.idle) return;
    const { full, bottom } = this.readViewport();
    if (!this.startupComplete) {
      if (this.config.startupReadyPattern?.test(full) || this.config.isViewportReady?.(full)) {
        this.startupComplete = true;
      } else {
        return;
      }
    }
    if (!this.readySeen && !(this.config.readyPattern.test(bottom) || this.config.isViewportReady?.(full))) {
      return;
    }
    this.readySeen = true;

    // Positive busy evidence in the rendered viewport vetoes false quiescence during slow thinking.
    if (this.config.busyPattern?.test(bottom)) {
      this.scheduleCheck(this.quiescenceMs);
      return;
    }
    if (this.config.isViewportReady && !this.config.isViewportReady(full)) {
      this.scheduleCheck(this.quiescenceMs);
      return;
    }

    const sinceSpinner = this.now() - this.lastSpinnerAt;
    if (this.lastSpinnerAt > 0 && sinceSpinner < this.spinnerGuardMs) {
      this.scheduleCheck(this.spinnerGuardMs - sinceSpinner + 50);
      return;
    }

    this.idle = true;
    this.onIdleCallback?.("screen");
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
