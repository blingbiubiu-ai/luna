export interface CliResult {
  status: "ok" | "error";
  code?: string;
  message?: string;
  output?: string;
}

export type Env = Record<string, string | undefined>;

export interface LunaCredentials {
  readonly serviceUrl: string;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly user: { readonly id: string; readonly displayName: string };
}

export interface NormalizedCliInput {
  readonly argv: readonly string[];
  readonly env: Env;
}

export type ManagedService = "agent";

export interface DaemonFiles {
  readonly runtimeDir: string;
  readonly pidFile: string;
  readonly logFile: string;
}

export interface DaemonStartResult extends DaemonFiles {
  readonly service: ManagedService;
  readonly status: "started" | "already_running";
  readonly pid: number;
}

export interface DaemonStopResult extends DaemonFiles {
  readonly service: ManagedService;
  readonly status: "stopped" | "not_running";
  readonly pid?: number;
}

export interface DaemonStatusResult extends DaemonFiles {
  readonly service: ManagedService;
  readonly running: boolean;
  readonly pid?: number;
}

export interface AgentRuntimeProbeResult {
  readonly endpoint: string;
  readonly reachable: boolean;
  readonly status?: string;
  readonly agent?: unknown;
  readonly channels?: unknown;
  readonly error?: string;
}

export type UnifiedServiceMethod = "DELETE" | "GET" | "POST" | "PUT";

export interface UnifiedServiceRequest {
  readonly idempotencyKey?: string;
  readonly method: UnifiedServiceMethod;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}
