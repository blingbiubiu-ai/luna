import {z} from "zod";
import { ModelProviderReference } from "@luna/runner-protocol";
import type {AgentExecutionSnapshot} from "./active-agent-config-service";

/** Durable model selection contains references and fingerprints, never environment secrets. */
export const executionReferenceSchema = z.object({
  modelProvider: ModelProviderReference.optional(),
  agentId:z.string().min(1), profileId:z.string().min(1), revisionId:z.string().min(1),
  activationSequence:z.number().int().nonnegative(),
  agentType:z.enum(["claude","codex"]), model:z.string(),
  executionDriver:z.enum(["stdio","pty"]).default("stdio"),
  providerFingerprint:z.string(),modelFingerprint:z.string(),configFingerprint:z.string(),
}).strict();
export type AgentExecutionReference = z.infer<typeof executionReferenceSchema>;
export function executionReference(snapshot:AgentExecutionSnapshot):AgentExecutionReference {
  const {agentId,profileId,revisionId,activationSequence,agentType,model,executionDriver,providerFingerprint,modelFingerprint,configFingerprint}=snapshot;
  return executionReferenceSchema.parse({agentId,profileId,revisionId,activationSequence,agentType,model,executionDriver,providerFingerprint,modelFingerprint,configFingerprint,...(snapshot.modelProvider ? {modelProvider:snapshot.modelProvider} : {})});
}
