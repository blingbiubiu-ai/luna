import type {
  AgentEnvironmentField,
  AgentType,
  AgentTypeDescriptor,
} from "./types";

const field = (
  key: string,
  label: string,
  sensitive: boolean,
  affectsProviderIdentity = false,
): AgentEnvironmentField => ({
  key,
  label,
  sensitive,
  required: false,
  affectsProviderIdentity,
});

const codexFields = [
  field("CODEX_PROVIDER_MODE", "Connection mode", false, true),
  field("OPENAI_BASE_URL", "Base URL", false, true),
  field("OPENAI_API_KEY", "API key", true, true),
  field("OPENAI_ORG_ID", "Organization ID", false, true),
] as const;

export const agentTypeDescriptors: readonly AgentTypeDescriptor[] = [
  {
    type: "claude",
    label: "Claude",
    defaultResumeOnModelChange: true,
    allowedCustomPrefixes: ["ANTHROPIC_", "CLAUDE_CODE_"],
    envFields: [
      field("ANTHROPIC_BASE_URL", "Base URL", false, true),
      field("ANTHROPIC_API_KEY", "API key", true, true),
      field("ANTHROPIC_AUTH_TOKEN", "Auth token", true, true),
      field("ANTHROPIC_MODEL", "Provider model override", false),
      field("API_TIMEOUT_MS", "API timeout (milliseconds)", false),
    ],
  },
  {
    type: "codex",
    label: "Codex",
    defaultResumeOnModelChange: true,
    allowedCustomPrefixes: ["OPENAI_", "CODEX_"],
    envFields: codexFields,
  },
];

export function agentTypeDescriptor(type: string): AgentTypeDescriptor {
  const descriptor = agentTypeDescriptors.find((item) => item.type === type);
  if (descriptor === undefined) {
    throw new Error(`Unsupported agent type: ${type}`);
  }
  return descriptor;
}

export function isAgentType(value: string): value is AgentType {
  return agentTypeDescriptors.some((item) => item.type === value);
}
