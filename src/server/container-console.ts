import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { ExecutionError } from "@luna/execution-store";
import type { ContainerStreamKind, ContainerStreamUser } from "@luna/runner-protocol";
import type { ContainerStreamHandle, WorkerGateway } from "@/runtime/worker-gateway";
import { createLogger } from "@/shared";

const logger = createLogger("container-console");
const Resize = z.object({ type: z.literal("resize"), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }).strict();

export interface ContainerConsoleTarget {
  accountId: string; agentId: string; shadowId: string; workerId: string; environmentId: string;
  kind: ContainerStreamKind; user: ContainerStreamUser; cols: number; rows: number;
}
export interface ContainerConsoleSocketData { kind: "container-console"; session: ContainerConsoleSession }

/**
 * One Dashboard WebSocket bridged to one Worker container stream.
 * Browser binary frames are stream bytes; text frames are control messages ({type:"resize"}).
 * Server -> browser frames are only bytes, so noVNC can use the socket directly.
 */
export class ContainerConsoleSession {
  private handle: ContainerStreamHandle | undefined;
  private readonly startedAt = Date.now();
  private reason = "client_closed";

  constructor(private readonly gateway: WorkerGateway, readonly target: ContainerConsoleTarget) {}

  open(ws: ServerWebSocket<ContainerConsoleSocketData>): void {
    const { accountId, agentId, shadowId, workerId, environmentId, kind, user, cols, rows } = this.target;
    logger.info({ event: "start", accountId, agentId, shadowId, workerId, environmentId, kind, user }, "container_console_session");
    try {
      this.handle = this.gateway.openStream(workerId, { environmentId, agentId, kind, user, cols, rows }, {
        data: bytes => { if (ws.send(bytes) === 0) this.end(ws, "client_disconnected"); },
        close: reason => { this.handle = undefined; this.end(ws, reason); },
      });
    } catch (error) {
      this.end(ws, error instanceof ExecutionError ? error.code : "stream_open_failed");
    }
  }

  message(ws: ServerWebSocket<ContainerConsoleSocketData>, raw: string | Buffer): void {
    if (typeof raw !== "string") { this.handle?.write(raw); return; }
    const resize = Resize.safeParse((() => { try { return JSON.parse(raw); } catch { return undefined; } })());
    if (!resize.success) { this.end(ws, "invalid_message"); return; }
    this.handle?.resize(resize.data.cols, resize.data.rows);
  }

  closed(): void {
    this.handle?.close();
    this.handle = undefined;
    const { accountId, agentId, shadowId, workerId, environmentId, kind, user } = this.target;
    logger.info({ event: "end", accountId, agentId, shadowId, workerId, environmentId, kind, user, durationMs: Date.now() - this.startedAt, reason: this.reason }, "container_console_session");
  }

  private end(ws: ServerWebSocket<ContainerConsoleSocketData>, reason: string): void {
    this.reason = reason;
    ws.close(4000, reason.slice(0, 100));
  }
}
