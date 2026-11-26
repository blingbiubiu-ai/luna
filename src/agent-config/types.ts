export type AgentType = "claude" | "codex";
export type ExecutionDriver = "stdio" | "pty";

export function isExecutionDriver(value: unknown): value is ExecutionDriver {
  return value === "stdio" || value === "pty";
}

export interface AgentEnvironmentField {
  readonly key: string;
  readonly label: string;
  readonly sensitive: boolean;
  readonly required: boolean;
  readonly affectsProviderIdentity: boolean;
}

export interface AgentTypeDescriptor {
  readonly type: AgentType;
  readonly label: string;
  readonly defaultResumeOnModelChange: boolean;
  readonly allowedCustomPrefixes: readonly string[];
  readonly envFields: readonly AgentEnvironmentField[];
}

export type SecretUpdate =
  | { readonly set: string }
  | { readonly clear: true };

export interface AgentProfileInput {
  readonly modelProvider?: import("@luna/runner-protocol").ModelProviderReference | null;
  readonly agentType: string;
  readonly model: string;
  readonly executionDriver?: string;
  readonly resumeOnModelChange?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, SecretUpdate>>;
  readonly customSensitiveKeys?: readonly string[];
  readonly customNonSensitiveKeys?: readonly string[];
}

export interface ValidatedAgentProfileInput {
  readonly modelProvider?: import("@luna/runner-protocol").ModelProviderReference;
  readonly agentType: AgentType;
  readonly model: string;
  readonly executionDriver: ExecutionDriver;
  readonly resumeOnModelChange: boolean;
  readonly env: Record<string, string>;
  readonly secrets: Record<string, SecretUpdate>;
  readonly customSensitiveKeys: string[];
}
