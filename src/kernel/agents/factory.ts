import type { AgentAttemptTransport } from "@/runners/runtime-agent-transport";
import { DummyAgentRunner, MockAgentRunner, type AgentRunner } from "@/shared";
import { ContainerAgentRunner } from "@/runners/container-agent-runner";

export interface AgentRunnerSelection {
  readonly type?: string;
  readonly agentType?: string;
  readonly model: string;
}

export function runnerTypeForAgentConfig(agentConfig: AgentRunnerSelection): string {
  return resolveAgentType(agentConfig);
}

export function createAgentRunnerForConfig(
  agentConfig: AgentRunnerSelection,
  transport?: AgentAttemptTransport,
): AgentRunner {
  const agentType = resolveAgentType(agentConfig);
  switch (agentType) {
    case "dummy":
      return new DummyAgentRunner();
    case "mock":
      return new MockAgentRunner(
        "user-home/sessions/34681283-bf20-4dc4-8301-a0929104002e.jsonl",
      );
    case "claude":
    case "codex":
      if (!transport) throw new Error("Claude and Codex runners require a Runtime connection");
      return new ContainerAgentRunner(transport, agentType, agentConfig.model);
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }
}

function resolveAgentType(config: AgentRunnerSelection): string {
  const type = config.agentType ?? config.type;
  if (type === undefined || type.length === 0) {
    throw new Error("Agent type is required");
  }
  return type;
}
