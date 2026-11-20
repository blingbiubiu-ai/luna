import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { ExecutionError } from "@luna/execution-store";
import type { ContainerStreamKind, ContainerStreamUser } from "@luna/runner-protocol";
import type { ContainerStreamHandle, WorkerGateway } from "@/runtime/worker-gateway";
import { createLogger } from "@/shared";

const logger = createLogger("container-console");
const ControlMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resize"), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }).strict(),
  z.object({ type: z.literal("mode"), writable: z.boolean() }).strict(),
]);

export interface ContainerConsoleTarget {
  accountId: string; agentId: string; shadowId: string; workerId: string; environmentId: string;
  kind: ContainerStreamKind; user: ContainerStreamUser; cols: number; rows: number;
  contextId?: string; writable?: boolean;
}
export interface ContainerConsoleSocketData { kind: "container-console"; session: ContainerConsoleSession }

/**
 * One Dashboard WebSocket bridged to one Worker container stream.
 * Browser binary frames are stream bytes; text frames are control messages ({type:"resize"} | {type:"mode"}).
 * For `kind: "pty"`, input and resize frames are gated by `writable` (read-only by default until taken over).
 */
export class ContainerConsoleSession {
  private handle: ContainerStreamHandle | undefined;
  private readonly startedAt = Date.now();
  private reason = "client_closed";
  private writable: boolean;

  constructor(private readonly gateway: WorkerGateway, readonly target: ContainerConsoleTarget) {
    this.writable = target.kind === "pty" ? target.writable === true : true;
  }

  open(ws: ServerWebSocket<ContainerConsoleSocketData>): void {
    const { accountId, agentId, shadowId, workerId, environmentId, kind, user, cols, rows, contextId } = this.target;
    logger.info({ event: "start", accountId, agentId, shadowId, workerId, environmentId, kind, user, contextId, writable: this.writable }, "container_console_session");
    try {
      this.handle = this.gateway.openStream(workerId, {
        environmentId, agentId, kind, user, cols, rows,
        ...(contextId ? { contextId } : {}),
      }, {
        data: bytes => { if (ws.send(bytes) === 0) this.end(ws, "client_disconnected"); },
        close: reason => { this.handle = undefined; this.end(ws, reason); },
      });
    } catch (error) {
      this.end(ws, error instanceof ExecutionError ? error.code : "stream_open_failed");
    }
  }

  message(ws: ServerWebSocket<ContainerConsoleSocketData>, raw: string | Buffer): void {
    if (typeof raw !== "string") {
      if (this.writable) this.handle?.write(raw);
      return;
    }
    const control = ControlMessage.safeParse((() => { try { return JSON.parse(raw); } catch { return undefined; } })());
    if (!control.success) { this.end(ws, "invalid_message"); return; }
    if (control.data.type === "mode") {
      this.writable = control.data.writable;
      return;
    }
    if (this.writable) {
      this.handle?.resize(control.data.cols, control.data.rows);
    }
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
