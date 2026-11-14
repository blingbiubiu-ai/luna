export type RunnerFailureKind =
  | "rate_limited"
  | "capacity_exhausted"
  | "transport_interrupted"
  | "timeout"
  | "service_unavailable"
  | "authentication_failed"
  | "permission_denied"
  | "invalid_request"
  | "model_not_found"
  | "context_too_large"
  | "quota_exhausted"
  | "session_unusable"
  | "process_failed"
  | "unknown";

export interface RunnerFailure {
  readonly kind: RunnerFailureKind;
  readonly provider: "claude" | "codex";
  readonly message: string;
  readonly providerCode?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}
