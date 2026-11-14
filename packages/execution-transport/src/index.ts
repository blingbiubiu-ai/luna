import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ExecutionError } from "@luna/execution-store";
import { TokenAuthority, type PeerIdentity } from "./auth";
export { TokenAuthority, requirePeer, type PeerIdentity } from "./auth";

export interface RequestContext {
  request: IncomingMessage; response: ServerResponse; peer: PeerIdentity; url: URL;
  /** SSE handlers recheck the grant before every event/heartbeat. */
  assertAuthorized(): void;
}
export type Handler = (context: RequestContext) => Promise<void>;

/** Private-network HTTP: authenticate callers first, then authorize each route and Job. */
export function executionServer(authority: TokenAuthority, handler: Handler): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const peer = authority.authenticate(req);
        await handler({ request: req, response: res, peer, url: new URL(req.url ?? "/", "http://execution.invalid"),
          assertAuthorized: () => { authority.authenticate(req); },
        });
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(); return; }
        const status = error instanceof ExecutionError ? error.status : error instanceof Error && error.name === "ZodError" ? 422 : 500;
        json(res, status, { code: error instanceof ExecutionError ? error.code : status === 422 ? "invalid_request" : "internal_error", ...(error instanceof ExecutionError ? error.details : {}) });
      }
    })().catch(() => res.destroy());
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  return server;
}

/** Shutdown the listener and outstanding HTTP streams without cancelling any Job. */
export async function closeExecutionServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function readJson(request: AsyncIterable<Uint8Array | string>, limit = 8 * 1024 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new ExecutionError(413, "request_too_large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new ExecutionError(422, "invalid_json"); }
}
export function json(response: ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  if (body === undefined) response.end();
  else response.end(JSON.stringify(body));
}

/** The configured origin is trusted deployment data; HTTP does not authenticate servers. */
export class ExecutionClient {
  readonly #token: string;
  constructor(readonly endpoint: string, token: string) {
    this.#token = token;
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Execution endpoint must be an HTTP origin");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid execution credential");
  }

  async open(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<IncomingMessage> {
    if (!path.startsWith("/v1/") || /[\\\r\n#]/.test(path)) throw new Error("Invalid execution API path");
    const url = new URL(path, this.endpoint);
    if (url.origin !== new URL(this.endpoint).origin || !url.pathname.startsWith("/v1/")) throw new Error("Invalid execution API path");
    signal?.throwIfAborted();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let response: IncomingMessage | undefined;
      const abort = () => {
        const error = signal?.reason instanceof Error ? signal.reason : new Error("Execution request aborted");
        response?.destroy();
        req.destroy(error);
        reject(error);
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const req = request(url, {
        method, agent: false,
        headers: { authorization: `Bearer ${this.#token}`,
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      }, (incoming) => {
        response = incoming;
        incoming.once("close", cleanup);
        if (signal?.aborted) { abort(); reject(signal.reason); return; }
        resolve(incoming);
      });
      req.setTimeout(30_000, () => req.destroy(new Error("Execution request timeout")));
      req.once("error", (error) => { if (!response) cleanup(); reject(error); });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      req.end(payload);
    });
  }

  async call<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.open(method, path, body, signal);
    const status = response.statusCode ?? 500;
    if (status >= 300 && status < 400) { response.destroy(); throw new ExecutionError(status, "redirect_denied"); }
    if (status === 204) { response.resume(); return undefined as T; }
    const result = await readJson(response, 16 * 1024 * 1024);
    if (status >= 300) {
      const error = result && typeof result === "object" ? result as Record<string, unknown> : {};
      throw new ExecutionError(status, typeof error.code === "string" ? error.code : "remote_error", error);
    }
    return result as T;
  }
}

export { ReverseChannel, type RpcClient, type RpcRequest } from "./reverse-channel";
