import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { AgentError } from "@/agents/agent-store";

// One Service owns its home. All HTTP/MCP accesses share this operation gate.
export const knowledgeJobs = new Map<string, Promise<void>>();

export function knowledgeStorage(serviceHome: string, agentId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error("Invalid knowledge Agent identity");
  let agentRoot = realpathSync(serviceHome);
  for (const part of ["agents", agentId]) {
    agentRoot = resolve(agentRoot, part);
    try {
      const stat = lstatSync(agentRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe knowledge root");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(agentRoot, { mode: 0o700 });
    }
  }
  return { agentRoot, root: resolve(agentRoot, "knowledge"), statePath: resolve(agentRoot, "knowledge-source.json") };
}

export function assertKnowledgeAvailable(root: string) {
  if (knowledgeJobs.has(root)) throw new AgentError("knowledge_busy", 409);
}
