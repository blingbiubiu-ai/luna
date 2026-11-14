import type { AgentRunner, AgentRunOptions, UserMessage } from "@/shared";
import type { AgentAttemptTransport } from "./runtime-agent-transport";

export class ContainerAgentRunner implements AgentRunner {
  readonly type = "container";

  constructor(
    private readonly transport: AgentAttemptTransport,
    private readonly runnerType: string,
    private readonly model: string,
  ) {}

  stream(message: UserMessage, options: AgentRunOptions) {
    options.signal?.throwIfAborted();
    return this.transport.stream(message, options, this.runnerType, this.model, {});
  }
}
