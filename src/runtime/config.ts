import { z } from "zod";
import { Id, EnvironmentSpec } from "@luna/runner-protocol";

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const RuntimeConfig = z.object({
  runtimeId: Id, serviceId: Id, dataRoot: z.string().min(1), serviceToken: token, adminToken: token,
  listenHost: z.string().default("127.0.0.1"), port: z.number().int().min(1).max(65535).default(8091),
  mode: z.enum(["isolated", "shared"]).default("shared"), homeWorkerId: Id,
  sharedProject: z.object({ projectId: Id }).strict().optional(),
  environmentId: Id.default("luna"),
  resources: EnvironmentSpec.shape.resources.default({ memory: "32g", cpus: 8, pidsLimit: 2048 }),
  maxConcurrentJobs: z.number().int().min(1).max(10000).default(8),
}).strict();
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;
