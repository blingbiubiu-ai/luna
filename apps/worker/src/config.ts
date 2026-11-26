import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { Id } from "@luna/runner-protocol";
import { absoluteRunnerPath } from "@luna/runner-protocol/runner-assets";

const hostUid = process.getuid?.();
const hostGid = hostUid ? process.getgid?.() : undefined;
export function defaultWorkerHome(env: Record<string, string | undefined> = process.env): string {
  return env.LUNA_WORKER_HOME ?? join(env.HOME ?? homedir(), ".luna-worker");
}

const workerFields = z.object({
  serviceUrl: z.url().refine(value => { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && (url.protocol === "https:" || url.protocol === "http:"); }, "HTTP(S) Service origin required").optional(),
  workerId: Id, runtimeId: Id, dataRoot: z.string().min(1),
  callbackPort: z.number().int().min(1024).max(65535).optional(),
  callbackHost: z.string().default("0.0.0.0"),
  modelPort: z.number().int().min(1024).max(65535).optional(),
  modelHost: z.string().default("0.0.0.0"),
  runtimeEndpoint: z.url().refine((value) => new URL(value).protocol === "http:"),
  controlToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  listenHost: z.literal("127.0.0.1").default("127.0.0.1"), port: z.number().int().min(1).max(65535).default(8092),
  executorHost: z.literal("127.0.0.1").default("127.0.0.1"), publishHost: z.literal("127.0.0.1").default("127.0.0.1"),
  executorPortStart: z.number().int().min(1024).max(65535).default(41000), executorPortEnd: z.number().int().min(1024).max(65535).default(41100),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  imageRef: z.string().min(1).max(512).optional(),
  imageVariant: z.enum(["general", "developer"]).optional(),
  network: z.string().regex(/^[A-Za-z0-9_.-]+$/).default("luna-execution"),
  runnerUid: z.number().int().min(1).max(4294967294).default(hostUid || 1000),
  runnerGid: z.number().int().min(0).max(4294967294).default(hostGid ?? 1000),
  capacity: z.number().int().min(1).max(256).default(8), idleTimeoutMs: z.number().int().min(1000).default(600000),
  projects: z.array(z.object({ projectId: Id, hostPath: absoluteRunnerPath }).strict()).default([]),
}).strict();
export const WorkerConfig = workerFields.refine((config) => config.executorPortStart <= config.executorPortEnd, "Invalid Executor port range");
export type WorkerConfig = z.infer<typeof WorkerConfig>;

/** Persisted local environment, independent of Service credentials. */
export const WorkerLocalConfig = workerFields.omit({
  workerId: true, runtimeId: true, serviceUrl: true, runtimeEndpoint: true, controlToken: true,
}).refine(config => config.executorPortStart <= config.executorPortEnd, "Invalid Executor port range");
export type WorkerLocalConfig = z.infer<typeof WorkerLocalConfig>;

/** Persisted connection identity; bind never modifies local execution settings. */
export const WorkerBindingConfig = z.object({
  workerId: Id, runtimeId: Id, controlToken: workerFields.shape.controlToken,
  serviceUrl: workerFields.shape.serviceUrl.unwrap(),
}).strict();
export type WorkerBindingConfig = z.infer<typeof WorkerBindingConfig>;
