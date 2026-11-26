import { agentTypeDescriptor, isAgentType } from "./type-registry";
import { ModelProviderReference } from "@luna/runner-protocol";
import {
  isExecutionDriver,
  type AgentProfileInput,
  type SecretUpdate,
  type ValidatedAgentProfileInput,
} from "./types";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FORBIDDEN_KEYS = new Set([
  "PATH",
  "HOME",
  "HOSTNAME",
  "IS_SANDBOX",
  "CODEX_FIXED_ARGS_ENV",
]);

export function validateAgentProfileInput(
  input: AgentProfileInput,
): ValidatedAgentProfileInput {
  if (!isAgentType(input.agentType)) {
    throw new Error(`Unsupported agent type: ${input.agentType}`);
  }
  const model = input.model.trim();
  if (model.length === 0) {
    throw new Error("Agent model is required");
  }
  const rawDriver = input.executionDriver ?? "stdio";
  if (!isExecutionDriver(rawDriver)) {
    throw new Error(`Unsupported execution driver: ${String(rawDriver)}`);
  }

  const descriptor = agentTypeDescriptor(input.agentType);
  const env = { ...(input.env ?? {}) };
  const secrets = { ...(input.secrets ?? {}) };
  const modelProvider = input.modelProvider == null ? undefined : ModelProviderReference.parse(input.modelProvider);
  if (modelProvider && (input.agentType !== "codex" || ["OPENAI_BASE_URL", "OPENAI_API_KEY", "CODEX_PROVIDER_MODE"].some(key => key in env || (key in secrets && !(key === "OPENAI_API_KEY" && "clear" in secrets[key]!))))) {
    throw new Error("Worker plugin models require Codex and cannot override gateway URL or credentials");
  }
  const customSensitive = new Set(input.customSensitiveKeys ?? []);
  const customNonSensitive = new Set(input.customNonSensitiveKeys ?? []);
  const knownFields = new Map(
    descriptor.envFields.map((item) => [item.key, item] as const),
  );

  for (const [key, value] of Object.entries(env)) {
    assertKeyAllowed(key, descriptor.allowedCustomPrefixes, knownFields.has(key));
    if (typeof value !== "string") {
      throw new Error(`${key} must be a string`);
    }
    const known = knownFields.get(key);
    if (known?.sensitive === true) {
      throw new Error(`${key} is sensitive and must be written through secrets`);
    }
    if (known === undefined && !isKnownPatternField(key) && !customNonSensitive.has(key)) {
      throw new Error(`${key} is an unknown custom variable and is sensitive by default`);
    }
  }

  for (const [key, update] of Object.entries(secrets)) {
    assertKeyAllowed(key, descriptor.allowedCustomPrefixes, knownFields.has(key));
    assertSecretUpdate(key, update);
    const known = knownFields.get(key);
    if (known !== undefined && !known.sensitive) {
      throw new Error(`${key} is not a sensitive field and must be stored in env`);
    }
    if (known === undefined && !customSensitive.has(key)) {
      throw new Error(`${key} is a custom secret and must be explicitly classified as sensitive`);
    }
  }

  if (input.agentType === "codex" && env.CODEX_PROVIDER_MODE !== undefined) {
    if (env.CODEX_PROVIDER_MODE !== "gateway") {
      throw new Error("CODEX_PROVIDER_MODE must be gateway when configured");
    }
    const baseUrl = URL.parse(env.OPENAI_BASE_URL ?? "");
    if (
      baseUrl === null ||
      !["https:", "http:"].includes(baseUrl.protocol) ||
      baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
    ) {
      throw new Error("Codex gateway requires an HTTP(S) OPENAI_BASE_URL without credentials, a query, or a fragment");
    }
    env.OPENAI_BASE_URL = baseUrl.href;
  }

  return {
    ...(modelProvider ? { modelProvider } : {}),
    agentType: input.agentType,
    model,
    executionDriver: rawDriver,
    resumeOnModelChange:
      input.resumeOnModelChange ?? descriptor.defaultResumeOnModelChange,
    env,
    secrets,
    customSensitiveKeys: [...customSensitive].toSorted(),
  };
}

function assertKeyAllowed(
  key: string,
  allowedPrefixes: readonly string[],
  isKnownField: boolean,
): void {
  if (
    !KEY_PATTERN.test(key) ||
    FORBIDDEN_KEYS.has(key) ||
    key.startsWith("LUNA_") ||
    (!isKnownField && !allowedPrefixes.some((prefix) => key.startsWith(prefix)))
  ) {
    throw new Error(`Agent profile environment variable is not allowed: ${key}`);
  }
}

function isKnownPatternField(key: string): boolean {
  return /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(key);
}

function assertSecretUpdate(key: string, update: SecretUpdate): void {
  if ("set" in update && typeof update.set === "string" && update.set.length > 0) {
    return;
  }
  if ("clear" in update && update.clear === true) {
    return;
  }
  throw new Error(`Invalid secret update for ${key}`);
}
