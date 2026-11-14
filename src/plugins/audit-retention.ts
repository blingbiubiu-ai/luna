import { createLogger, type Logger } from "@/shared";

import { OperationInvocationAuditStore } from "./audit-store";

export const OPERATION_AUDIT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface OperationAuditRetentionSchedulerInput {
  readonly store: Pick<OperationInvocationAuditStore, "cleanupExpired">;
  readonly intervalMs?: number;
  readonly logger?: Logger;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

export class OperationAuditRetentionScheduler {
  private readonly _logger: Logger;
  private readonly _setInterval: typeof setInterval;
  private readonly _clearInterval: typeof clearInterval;
  private _timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly _input: OperationAuditRetentionSchedulerInput) {
    this._logger = _input.logger ?? createLogger("operation-audit-retention");
    this._setInterval = _input.setInterval ?? setInterval;
    this._clearInterval = _input.clearInterval ?? clearInterval;
  }

  start(): void {
    if (this._timer !== undefined) {
      return;
    }
    this._cleanup("startup");
    this._timer = this._setInterval(
      () => this._cleanup("scheduled"),
      this._input.intervalMs ?? OPERATION_AUDIT_CLEANUP_INTERVAL_MS,
    );
    this._timer.unref?.();
  }

  stop(): void {
    if (this._timer === undefined) {
      return;
    }
    this._clearInterval(this._timer);
    this._timer = undefined;
  }

  private _cleanup(reason: "startup" | "scheduled"): void {
    try {
      const deleted = this._input.store.cleanupExpired();
      if (deleted > 0) {
        this._logger.info(
          { deleted, reason },
          "deleted expired operation invocation audits",
        );
      }
    } catch (err) {
      this._logger.warn(
        { err, reason },
        "failed to delete expired operation invocation audits",
      );
    }
  }
}
