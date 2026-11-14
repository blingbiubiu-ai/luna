import type { RetryPolicy } from "./job";

/** Only explicit transient provider classifications authorize another execution attempt. */
export function isTransientProviderFailure(kind: string): boolean {
  return ["rate_limited", "capacity_exhausted", "transport_interrupted", "timeout", "service_unavailable"].includes(kind);
}

/** Bound local exponential backoff while respecting a longer provider Retry-After. */
export function executionRetryDelay(policy: RetryPolicy, retryNumber: number, retryAfterMs?: number): number {
  const local = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(30, Math.max(0, retryNumber - 1)));
  return Math.max(local, Number.isSafeInteger(retryAfterMs) && retryAfterMs! >= 0 ? retryAfterMs! : 0);
}

/** Resume the existing invocation without asking the model to repeat its completed work. */
export const EXECUTION_CONTINUATION_PROMPT = "Continue the previous invocation from the last completed step. " +
  "Do not repeat completed work. Finish the original request.";
