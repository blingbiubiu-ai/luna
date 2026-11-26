import { z } from "zod";
import { Id } from "./id.js";

export const WORKER_MODEL_PROVIDER_CAPABILITY = "worker-model-provider-v1";
export const ModelProviderReference = z.object({
  kind: z.literal("worker-plugin"), pluginId: Id, providerId: Id, workerId: Id,
  accountId: Id, credentialRevision: Id, releaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ModelProviderReference = z.infer<typeof ModelProviderReference>;

export const WorkerModelDescriptor = z.object({
  id: z.string().min(1).max(256), name: z.string().min(1).max(512),
  contextWindow: z.number().int().positive().optional(),
  capabilities: z.object({ tools: z.boolean().optional(), reasoning: z.boolean().optional() }).strict().optional(),
}).strict();
export const ModelAccountSummary = z.object({
  agentId: Id, pluginId: Id, providerId: Id, accountId: Id, credentialRevision: Id,
  releaseSha256: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().max(512),
  expiresAt: z.number().nullable(), state: z.enum(["ready", "expired", "unavailable"]),
  models: z.array(WorkerModelDescriptor).max(1000),
}).strict();
export type ModelAccountSummary = z.infer<typeof ModelAccountSummary>;

export const WorkerModelRelease = z.object({
  pluginId: Id, providerId: Id, releaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entrypoint: z.string().min(1).max(256), checksums: z.string().max(128 * 1024),
  files: z.array(z.object({ path: z.string().min(1).max(512), content: z.string().max(16 * 1024 * 1024) }).strict()).min(3).max(128),
}).strict();
export type WorkerModelRelease = z.infer<typeof WorkerModelRelease>;
