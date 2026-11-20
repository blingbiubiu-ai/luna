import { z } from "zod";
import { Id } from "./job.js";

/**
 * Interactive streams into a Shadow container (Dashboard terminal and VNC).
 *
 * Only `stream.open` travels on the Worker's control link. The Worker then dials a
 * dedicated data WebSocket to Service (CONTAINER_STREAM_PATH + streamId) carrying the
 * stream token, so bulk bytes never queue behind Job traffic. On the data socket,
 * binary frames are stream bytes and text frames are control messages:
 * Service -> Worker `{type:"resize",cols,rows}`, and Worker -> Service
 * `{type:"end",reason}` just before the Worker closes (Bun servers do not
 * receive client close reasons).
 */
export const ContainerStreamKind = z.enum(["terminal", "vnc", "pty"]);
export type ContainerStreamKind = z.infer<typeof ContainerStreamKind>;
export const ContainerStreamUser = z.enum(["runner", "root"]);
export type ContainerStreamUser = z.infer<typeof ContainerStreamUser>;

const Dimension = z.number().int().min(1).max(1000);
export const CONTAINER_STREAM_PATH = "/api/worker/streams/";
export const CONTAINER_STREAM_TOKEN_HEADER = "x-luna-stream-token";

export const ContainerStreamOpen = z.object({
  type: z.literal("stream.open"), streamId: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  environmentId: Id, agentId: Id, kind: ContainerStreamKind, user: ContainerStreamUser, cols: Dimension, rows: Dimension,
  contextId: Id.optional(),
}).strict();
export type ContainerStreamOpen = z.infer<typeof ContainerStreamOpen>;

export const ContainerStreamResize = z.object({ type: z.literal("resize"), cols: Dimension, rows: Dimension }).strict();
export const ContainerStreamEnd = z.object({ type: z.literal("end"), reason: z.string().max(100) }).strict();
