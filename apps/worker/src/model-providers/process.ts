import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExecutionError } from "@luna/execution-store";

// Embedded in the Worker bundle: installed adapters do not import Core internals.
const childSource = `
const init = await new Response(Bun.stdin.stream()).text();
const {token} = JSON.parse(init);
const module = await import(process.argv[2]);
const adapter = await (module.createModelAdapter ?? module.default)();
const server = Bun.serve({hostname:"127.0.0.1",port:0, idleTimeout:0, maxRequestBodySize:16*1024*1024,
 async fetch(request) {
  if(request.headers.get("authorization")!=="Bearer "+token) return new Response("Unauthorized",{status:401});
  try {
   const body=await request.json(); const path=new URL(request.url).pathname;
   const signal=request.signal;
   if(path.startsWith("/login/")){
    if(!adapter.login)throw Object.assign(new Error(),{code:"model_login_unsupported",status:422});
    if(path==="/login/start")return Response.json(await adapter.login.start(body.callbackUrl));
    if(path==="/login/callback")return Response.json(await adapter.login.callback(body.id,body.params));
    if(path==="/login/poll")return Response.json(await adapter.login.poll(body.id));
    if(path==="/login/cancel")return Response.json(await adapter.login.cancel(body.id));
   }
   if(path==="/validate") return Response.json(await adapter.validateCredential(body.credential,signal));
   if(path==="/models") return Response.json(await adapter.models(body.credential,signal));
   if(path==="/respond") {
    const upstream=new Request("http://adapter.invalid/v1/responses",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body.input),signal});
    return await adapter.respond(body.credential,upstream,{sessionId:body.sessionId,signal});
   }
   return new Response("Not found",{status:404});
  } catch(error) { const status=[401,404,409,422,429,503].includes(error?.status)?error.status:502;
   const code=/^model_[a-z_]+$/.test(error?.code)?error.code:"model_adapter_failed";
   return Response.json({error:{code}},{status}); }
 }});
console.log(JSON.stringify({port:server.port}));
process.on("SIGTERM",()=>{server.stop(true);process.exit(0)});
`;

export class ModelProviderProcess {
  private child: ReturnType<typeof Bun.spawn> | undefined;
  private port: number | undefined;
  private starting: Promise<void> | undefined;
  private readonly token = randomBytes(32).toString("base64url");
  private closed = false;
  constructor(private dataRoot: string, private entrypoint: string, private home: string) {}
  private async start(): Promise<void> {
    if (this.closed) throw new ExecutionError(503, "model_provider_stopped");
    if (this.port) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const host = join(this.dataRoot, "model-provider-runtime", `host-${createHash("sha256").update(childSource).digest("hex")}.mjs`);
      mkdirSync(dirname(host), { recursive: true, mode: 0o700 });
      if (!existsSync(host)) writeFileSync(host, childSource, { flag: "wx", mode: 0o400 });
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      const child = Bun.spawn([process.execPath, host, this.entrypoint], { cwd: this.home,
        env: { HOME: this.home, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      this.child = child;
      child.stdin.write(JSON.stringify({ token: this.token })); child.stdin.end();
      const reader = child.stdout.getReader();
      let text = "";
      const ready = (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) throw new Error("child exited");
          text += new TextDecoder().decode(next.value);
          if (text.length > 4096) throw new Error("invalid readiness");
          if (text.includes("\n")) {
            const value = JSON.parse(text.split("\n")[0]!);
            if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("invalid port");
            this.port = value.port; break;
          }
        }
      })();
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("startup timeout")), 10000); })]);
      } catch { child.kill(); throw new ExecutionError(503, "model_provider_start_failed"); }
      finally { clearTimeout(timer!); }
      void (async () => { try { while (!(await reader.read()).done) { /* Never forward adapter stdout. */ } } catch { /* Child exited. */ } })();
      void child.exited.then(() => { if (this.child === child) { this.port = undefined; this.child = undefined; } });
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async call(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    await this.start(); signal.throwIfAborted();
    try {
      return await fetch(`http://127.0.0.1:${this.port}${path}`, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
    } catch { signal.throwIfAborted(); throw new ExecutionError(502, "model_provider_unavailable"); }
  }
  async close(): Promise<void> { this.closed = true; this.child?.kill(); if (this.child) await this.child.exited; this.port = undefined; }
}
