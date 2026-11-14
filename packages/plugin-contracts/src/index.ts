export const HOST_PERMISSIONS = [
  "artifact.create",
  "artifact.materialize",
  "workspace.tempFile",
  "network.internal",
  "host.exec",
] as const;

export type PluginSource = "bundled" | "marketplace";
export type HostPermission = typeof HOST_PERMISSIONS[number];
export type OperationProviderType = "core" | "plugin";
export type OperationRiskLevel = "low" | "medium" | "high" | "sensitive";
export type OperationArtifactPolicy = "none" | "allowed" | "required";
export type OperationInvocationSource =
  | "cli"
  | "dashboard"
  | "main_runner"
  | "work_runner"
  | "task_runner"
  | "service_api";

export interface OperationDefinition {
  readonly id: string;
  readonly pluginId?: string;
  readonly providerType?: OperationProviderType;
  readonly title: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly riskLevel: OperationRiskLevel;
  readonly timeoutMs?: number;
  readonly artifactPolicy: OperationArtifactPolicy;
  readonly defaultDecision?: "allow" | "deny";
}

export interface CommandContribution {
  readonly path: readonly string[];
  readonly operationId?: string;
  readonly namespace?: string;
  readonly argsSchema?: unknown;
  readonly help?: string;
}

export interface RunnerToolContribution {
  readonly name: string;
  readonly operationId: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
}

export interface SkillContribution {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly path?: string;
}

export interface ContainerCommandContribution {
  readonly binary: string;
  readonly commandPath: readonly string[];
  readonly shimScript: string;
  /** Package directory copied to $HOME/.luna-resources/commands/.runtime/<binary>. */
  readonly runtimeDirectory?: string;
}

export interface DefaultPermissionRule {
  /** Exact operation ID or trailing prefix.* within a namespace declared by this plugin's operations. */
  readonly pattern: string;
  readonly effect: "allow" | "deny";
}

export interface PluginManifest {
  /** Explicit opt-in after auditing Agent-scoped configuration, credentials and host access. */
  readonly agentScopeVersion?: 2;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly lunaApiVersion?: string;
  readonly runtime?: {
    readonly entrypoint: string;
  };
  readonly configSchema?: unknown;
  readonly requestedHostPermissions: readonly HostPermission[];
  readonly operations: readonly OperationDefinition[];
  readonly operationNamespaces?: readonly { readonly namespace: string; readonly mode: "dynamic" }[];
  /** Explicit operation defaults override these rules; matching deny overrides allow. */
  readonly defaultPermissionRules?: readonly DefaultPermissionRule[];
  readonly commands?: readonly CommandContribution[];
  readonly tools?: readonly RunnerToolContribution[];
  readonly skills?: readonly SkillContribution[];
  readonly allowedExecutables?: readonly string[];
  readonly allowedEnvKeys?: readonly string[];
  readonly containerCommands?: readonly ContainerCommandContribution[];
}

export interface PluginInvocationIdentity {
  readonly pluginId: string;
  readonly operationId: string;
  readonly invocationId: string;
  readonly subject: {
    readonly userId?: string;
    readonly source: string;
  };
  readonly messageId?: string;
}

export interface PluginArtifactRow {
  readonly id: string;
  readonly name: string;
  readonly mime_type: string | null;
  readonly size_bytes: number | null;
  readonly [key: string]: unknown;
}

export interface PluginRegisterLocalFileInput {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly kind: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly path: string;
  readonly retentionPolicy?: string;
  readonly retentionExpiresAt?: number;
}

export interface PluginRegisterContentInput {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly kind: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly content: Uint8Array;
  readonly retentionPolicy?: string;
  readonly retentionExpiresAt?: number;
}

export interface PluginRuntimeContext {
  readonly scope?:Readonly<{agentId:string;shadowId:string}>;
  readonly secrets?: {get(key:string):string|undefined};
  readonly invocation: PluginInvocationIdentity;
  readonly config: unknown;
  readonly logger: {
    info(input: Record<string, unknown>, message: string): void;
    warn(input: Record<string, unknown>, message: string): void;
    error(input: Record<string, unknown>, message: string): void;
  };
  readonly workspace: {
    tempDir(input: { readonly prefix: string }): string;
    tempFile(input: { readonly prefix: string; readonly suffix?: string }): string;
  };
  readonly artifacts: {
    registerContent(input: PluginRegisterContentInput): PluginArtifactRow;
    registerLocalFile(input: PluginRegisterLocalFileInput): PluginArtifactRow;
    materializeLocalFile(input: { readonly ref: string }): {
      readonly artifactId: string;
      readonly path: string;
      readonly name: string;
      readonly mimeType: string | null;
      readonly sizeBytes: number | null;
    };
  };
  readonly host: {
    exec(input: {
      readonly cmd: string;
      readonly args: readonly string[];
      readonly stdin?: string;
      readonly env?: Record<string, string>;
    }): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  };
}

export interface OperationInvocationInput {
  readonly operationId: string;
  readonly input: unknown;
  readonly source: OperationInvocationSource;
  readonly subjectId?: string;
  readonly runtimeContext?: PluginRuntimeContext;
}

export interface OperationInvocationResult {
  readonly status: "success" | "error";
  readonly summary: unknown;
  readonly output?: unknown;
  readonly artifacts: readonly unknown[];
}

export interface PluginRuntime {
  invoke(input: OperationInvocationInput): Promise<OperationInvocationResult>;
}

export interface PluginRuntimeFactoryContext {
  readonly manifest: PluginManifest;
  readonly config: unknown;
}

export type PluginRuntimeFactory = (
  context: PluginRuntimeFactoryContext,
) => PluginRuntime;

export interface PluginCommandInputParseRequest {
  readonly command: CommandContribution;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly stdin?: string;
}

export interface PluginCommandInputParseResult {
  readonly input: Record<string, unknown>;
  readonly operationId?: string;
}

export type PluginCommandInputParser = (
  request: PluginCommandInputParseRequest,
) => PluginCommandInputParseResult;

export interface BundledPluginDefinition {
  readonly manifest: PluginManifest;
  readonly createRuntime: PluginRuntimeFactory;
  readonly parseCommandInput?: PluginCommandInputParser;
}

export function isHostPermission(value: unknown): value is HostPermission {
  return typeof value === "string" &&
    (HOST_PERMISSIONS as readonly string[]).includes(value);
}

export class PluginCommandInputError extends Error {
  readonly code = "plugin_command_input_invalid";
  constructor(message: string) {
    super(message);
    this.name = "PluginCommandInputError";
  }
}
