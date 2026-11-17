import { z } from "zod";
import {ExecutionScope,ResourceSelection} from "./scope.js";
import { Id, Sequence } from "./job.js";
import { absoluteRunnerPath } from "./runner-assets.js";

export const Occupant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job"), invocationId:Id,scope:ExecutionScope, jobId: Id, assignmentId: Id, requestHash: z.string().regex(/^[a-f0-9]{64}$/), scopeKey: z.string().min(1), contextId: Id }).strict(),
  z.object({ kind: z.literal("maintenance"), scope:ExecutionScope, operationId: Id, operationHash: z.string().regex(/^[a-f0-9]{64}$/), contextId: Id }).strict(),
]);
export type Occupant = z.infer<typeof Occupant>;
export const EnvironmentSpec = z.object({
  protocolVersion:z.literal(2),scope:ExecutionScope,resourceSelection:ResourceSelection,
  environmentId: Id, scopeKey: z.string().min(1).max(512), mode: z.literal("shared"),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), callbackRuntimeId: Id,
  resources: z.object({ memory: z.string().regex(/^\d+[mg]$/i), cpus: z.number().positive().max(256), pidsLimit: z.number().int().min(32).max(65536) }).strict(),
  /** The Shadow's root switch: the container allows sudo (still gated per Job by `privileged`). */
  rootAccess: z.boolean().optional(),
}).strict();
export type EnvironmentSpec = z.infer<typeof EnvironmentSpec>;
export const PrepareRequest = z.object({ requestId: Id, occupant: Occupant, spec: EnvironmentSpec, resourceRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), projectId: Id.optional(), cwd: absoluteRunnerPath.optional() }).strict().refine(value=>value.occupant.scope.agentId===value.spec.scope.agentId && value.occupant.scope.shadowId===value.spec.scope.shadowId && value.occupant.scope.placementGeneration===value.spec.scope.placementGeneration,"Occupant scope mismatch").refine(value=>value.resourceRevision===undefined || value.resourceRevision===value.spec.resourceSelection.digest,"Resource revision mismatch");
export type PrepareRequest = z.infer<typeof PrepareRequest>;
export const EnvironmentHandle = z.object({
  scope:ExecutionScope,
  workerId: Id, environmentId: Id, instanceId: Id, bootId: Id,
  executorEndpoint: z.url().refine((url) => new URL(url).protocol === "http:", "HTTP required"),
  executorIdentity: Id, imageDigest: z.string(), reservationId: Id, occupant: Occupant,
}).strict();
export type EnvironmentHandle = z.infer<typeof EnvironmentHandle>;
export const ReleaseProof = z.object({ kind: z.literal("job"), assignmentId: Id, terminalSeq: Sequence.min(1) }).strict();
export type ReleaseProof = z.infer<typeof ReleaseProof>;

export function occupantId(occupant: Occupant): string {
  return occupant.kind === "job" ? occupant.jobId : occupant.operationId;
}
