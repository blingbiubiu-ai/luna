import type { RunnerFailure, RunnerFailureKind } from "./types";

export function normalizeProviderFailure(
  provider: RunnerFailure["provider"],
  message: string,
  input: {
    readonly providerCode?: string;
    readonly fallbackKind?: RunnerFailureKind;
  } = {},
): RunnerFailure {
  const normalized = message.toLowerCase();
  const httpStatus = extractHttpStatus(message);
  const retryAfterMs = extractRetryAfterMs(message);
  let kind = input.fallbackKind ?? "unknown";

  if (kind === "session_unusable") {
    // Provider-specific resume recovery is more precise than generic text
    // such as "not found" or "invalid request".
  } else if (
    httpStatus === 401 ||
    normalized.includes("authentication failed") ||
    normalized.includes("unauthorized") ||
    normalized.includes("invalid api key") ||
    normalized.includes("invalid auth token")
  ) {
    kind = "authentication_failed";
  } else if (
    httpStatus === 403 ||
    normalized.includes("permission denied") ||
    normalized.includes("forbidden")
  ) {
    kind = "permission_denied";
  } else if (
    normalized.includes("insufficient_quota") ||
    normalized.includes("insufficient balance") ||
    normalized.includes("insufficient credit") ||
    normalized.includes("credit balance") ||
    normalized.includes("billing")
  ) {
    kind = "quota_exhausted";
  } else if (
    normalized.includes("context length") ||
    normalized.includes("context window") ||
    normalized.includes("prompt too long") ||
    normalized.includes("maximum context")
  ) {
    kind = "context_too_large";
  } else if (
    normalized.includes("model not found") ||
    normalized.includes("unknown model") ||
    normalized.includes("model_not_found")
  ) {
    kind = "model_not_found";
  } else if (
    httpStatus === 400 ||
    normalized.includes("invalid_request_error") ||
    normalized.includes("invalid request")
  ) {
    kind = "invalid_request";
  } else if (
    httpStatus === 429 ||
    normalized.includes("rate_limit") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests")
  ) {
    kind = "rate_limited";
  } else if (
    httpStatus === 529 ||
    normalized.includes("overloaded") ||
    normalized.includes("high demand") ||
    normalized.includes("peak load") ||
    normalized.includes("capacity exhausted")
  ) {
    kind = "capacity_exhausted";
  } else if (
    normalized.includes("timed out") ||
    normalized.includes("request timeout") ||
    normalized.includes("etimedout")
  ) {
    kind = "timeout";
  } else if (
    normalized.includes("reconnecting") ||
    normalized.includes("response.failed") ||
    normalized.includes("stream disconnected") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket hang up") ||
    normalized.includes("fetch failed") ||
    normalized.includes("network error")
  ) {
    kind = "transport_interrupted";
  } else if (
    httpStatus === 500 ||
    httpStatus === 502 ||
    httpStatus === 503 ||
    httpStatus === 504 ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("service unavailable") ||
    normalized.includes("internal server error") ||
    normalized.includes("bad gateway") ||
    normalized.includes("gateway timeout")
  ) {
    kind = "service_unavailable";
  }

  return {
    kind,
    provider,
    message,
    ...(input.providerCode === undefined
      ? {}
      : { providerCode: input.providerCode }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function extractHttpStatus(message: string): number | undefined {
  const match = message.match(
    /(?:\b(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*|["'](?:status|status_code)["']\s*:\s*)(\d{3})\b/i,
  );
  if (match?.[1] === undefined) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

function extractRetryAfterMs(message: string): number | undefined {
  const milliseconds = message.match(
    /\bretry[-_ ]after[-_ ]ms\s*[:=]\s*(\d+)\b/i,
  )?.[1];
  if (milliseconds !== undefined) return Number(milliseconds);
  const seconds = message.match(
    /\bretry[-_ ]after\s*[:=]\s*(\d+)\b/i,
  )?.[1];
  return seconds === undefined ? undefined : Number(seconds) * 1_000;
}
