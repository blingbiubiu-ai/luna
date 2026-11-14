export interface ContainerInput {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly runnerType: string;
  readonly model?: string;
  readonly env?: Record<string, string>;
}
