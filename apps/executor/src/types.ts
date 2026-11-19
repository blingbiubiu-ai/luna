export interface ContainerInput {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly runnerType: string;
  readonly executionDriver?: "stdio" | "pty";
  readonly model?: string;
  readonly env?: Record<string, string>;
}
