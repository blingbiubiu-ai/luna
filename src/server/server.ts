import {createPlatformAgentRoutes} from "./routes/platform-agents";
import type {AgentLifecycleJob} from "@/agents/agent-lifecycle-store";
import { getKernel } from "@/server/routes/kernel";
import type { WorkerSocketData } from "@/runtime/worker-gateway";
import { createTaskReportRoutes } from "./routes/task-reports";
import { createRunnerOperationRoutes } from "./routes/runner-operations";
import { createChannelConfigRoutes } from "./routes/channel-config";
import { createRunnerGroupRoutes } from "./routes/runner-groups";
import { createRunnerUserRoutes } from "./routes/runner-users";
import { createSessionCommandAdminRoutes } from "./routes/session-commands";
import { createRunnerMessageRoutes } from "./routes/runner-messages";
import { loginDotMatrixScript } from "./login-dot-matrix";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

import type { Server } from "bun";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";

import type { DrizzleDB } from "@/data";
import { cliAuthSessions } from "@/data/schema";
import { config, type Logger } from "@/shared";
import { createLogger } from "@/shared";
import type { PluginRegistry } from "@/plugins";
import { AgentSecretCipher } from "@/agent-config";
import { eq } from "drizzle-orm";

import {
  assertSafeDashboardBinding,
  DEFAULT_LUNA_SERVICE_HOST,
  DEFAULT_LUNA_SERVICE_PORT,
} from "@luna/host-runtime/defaults";
import {
  createDashboardAuthMiddleware,
  dashboardAuthSessionFromContext,
  DashboardAuthService,
} from "./auth";
import { hashAccessToken } from "./auth/access-token-service";
import {
  agentRoutes,
  artifactsRoutes,
  createArtifactsRoutes,
  authorizationRulesRoutes,
  createOperationGrantsRoutes,
  operationsRoutes,
  createOperationsRoutes,
  groupsRoutes,
  createGroupsRoutes,
  healthRoutes,
  createMcpRoutes,
  mcpRoutes,
  createPluginsRoutes,
  pluginsRoutes,
  runtimeRoutes,
  createSessionsRoutes,
  sessionsRoutes,
  skillsRoutes,
  tasksRoutes,
  createTasksRoutes,
  usersRoutes,
  createUsersRoutes,
  createAuthRoutes,
  createAgentConfigRoutes,
  workspaceRoutes,
  createWorkspaceRoutes,
} from "./routes";

/**
 * Creates the Hono app with all API routes mounted.
 *
 * Extracted as a standalone function so TypeScript can infer the full
 * chained route type, which is then exported as {@link AppType} for
 * use with Hono's RPC client (`hc<AppType>`).
 */
function createApp(
  auth = new DashboardAuthService(),
  db?: DrizzleDB,
  pluginRegistry?: PluginRegistry,
  resumeChannels?: (job: AgentLifecycleJob) => Promise<void>,
) {
  return (
    new Hono()
      // CORS middleware
      .use("/api/*", cors({ origin: "*" }))
      .use(
        "*",
        createDashboardAuthMiddleware(auth, db === undefined ? {} : { db }),
      )
      // Routes
      .route("/api", healthRoutes)
      .route("/api/auth", createAuthRoutes(auth, db === undefined ? {} : { db }))
      .route(
        "/api/artifacts",
        db === undefined ? artifactsRoutes : createArtifactsRoutes({ db }),
      )
      .route("/api/runtime", runtimeRoutes)
      .route("/api/runner", createRunnerGroupRoutes(db === undefined ? {} : { db }))
      .route("/api/runner", createRunnerUserRoutes(db === undefined ? {} : { db }))
      .route("/api/runner", createRunnerOperationRoutes())
      .route("/api/runner/task-reports", createTaskReportRoutes())
      .route("/api/runner", createRunnerMessageRoutes(db === undefined ? {} : { db }))
      .route("/api/session-commands", createSessionCommandAdminRoutes(db === undefined ? {} : { db }))
      .route(
        "/api/tasks",
        db === undefined ? tasksRoutes : createTasksRoutes({ db }),
      )
      .route(
        "/api/sessions",
        db === undefined ? sessionsRoutes : createSessionsRoutes({ db }),
      )
      .route("/api/skills", skillsRoutes)
      .route(
        "/api/users",
        db === undefined ? usersRoutes : createUsersRoutes({ db }),
      )
      .route(
        "/api/groups",
        db === undefined ? groupsRoutes : createGroupsRoutes({ db }),
      )
      .route(
        "/api/authorization-rules",
        db === undefined
          ? authorizationRulesRoutes
          : createOperationGrantsRoutes({ db }),
      )
      .route(
        "/api/operations",
        db === undefined
          ? operationsRoutes
          : createOperationsRoutes({
            db,
            ...(pluginRegistry === undefined ? {} : { pluginRegistry }),
          }),
      )
      .route(
        "/api/plugins",
        db === undefined
          ? pluginsRoutes
          : createPluginsRoutes({
            db,
            ...(pluginRegistry === undefined ? {} : { registry: pluginRegistry }),
          }),
      )
      .route(
        "/api/workspaces",
        db === undefined ? workspaceRoutes : createWorkspaceRoutes({ db }),
      )
      .route("/mcp", db === undefined ? mcpRoutes : createMcpRoutes({ db }))
      .route("/api/channel-config", db === undefined ? new Hono() : createChannelConfigRoutes({db}))
      .route("/api/agent", agentRoutes)
      .route("/api/agents",db === undefined ? new Hono() : createPlatformAgentRoutes(db,pluginRegistry,resumeChannels))
      .route(
        "/api/agent-config",
        db === undefined
          ? new Hono()
          : createAgentConfigRoutes({
            db,
            cipher: AgentSecretCipher.tryFromEnvironment(),
          }),
      )
  );
}

/**
 * The fully-typed Hono app, including all mounted route signatures.
 *
 * Use with `hc<AppType>` on the client side for end-to-end type safety.
 */
export type AppType = ReturnType<typeof createApp>;

/**
 * The HTTP server wrapping Hono, started and stopped by the Kernel.
 *
 * Serves RESTful API routes under `/api` and static files from the built
 * React SPA at `apps/dashboard/dist/` when the dashboard has been built.
 */
export class HonoServer {
  private _app: AppType;
  private _server: Server<WorkerSocketData> | undefined;
  private _logger: Logger;

  constructor(input: {
    readonly db?: DrizzleDB;
    readonly pluginRegistry?: PluginRegistry;
    readonly resumeChannels?: (job: AgentLifecycleJob) => Promise<void>;
  } = {}) {
    this._logger = createLogger("hono-server");
    const auth = new DashboardAuthService();
    if (auth.usesLocalDefaultToken) {
      this._logger.warn(
        "LUNA_DASHBOARD_TOKEN is not configured; using the local development dashboard login token",
      );
    }
    this._app = createApp(auth, input.db, input.pluginRegistry, input.resumeChannels);
    this._setupStaticServing();
    this._setupLoginPage();
    this._setupCliAuthPage(input.db, auth);
  }

  get app(): AppType {
    return this._app;
  }

  /**
   * Start listening on the configured host and port.
   *
   * Uses `LUNA_SERVICE_PORT` (default 8090) and
   * `LUNA_SERVICE_HOST` (default 127.0.0.1).
   */
  async start(): Promise<void> {
    const port = parseInt(
      Bun.env.LUNA_SERVICE_PORT ?? String(DEFAULT_LUNA_SERVICE_PORT),
      10,
    );
    const hostname = Bun.env.LUNA_SERVICE_HOST ?? DEFAULT_LUNA_SERVICE_HOST;

    assertSafeDashboardBinding(hostname, Bun.env.LUNA_DASHBOARD_TOKEN);

    this._server = Bun.serve({
      fetch: (request, server) => {
        if (new URL(request.url).pathname.startsWith("/api/worker/")) {
          const gateway = getKernel().executionRuntime?.gateway;
          if (!gateway) return Response.json({ code: "runtime_not_ready" }, { status: 503 });
          if (new URL(request.url).pathname === "/api/worker/connect") {
            try {
              const workerId = gateway.authenticate(request);
              if (server.upgrade(request, { data: { workerId, gateway } })) return;
              return new Response("WebSocket required", { status: 400 });
            } catch { return new Response("Unauthorized", { status: 401 }); }
          }
          return gateway.http(request);
        }
        return this._app.fetch(request, server);
      },
      websocket: {
        maxPayloadLength: 16 * 1024 * 1024,
        idleTimeout: 40,
        open: (ws: import("bun").ServerWebSocket<WorkerSocketData>) => ws.data.gateway.open(ws),
        message: (ws: import("bun").ServerWebSocket<WorkerSocketData>, message: string | Buffer) => ws.data.gateway.message(ws, message),
        close: (ws: import("bun").ServerWebSocket<WorkerSocketData>) => ws.data.gateway.closed(ws),
      },
      port,
      hostname,
      // Agent Profile connection tests may legitimately run for up to 60s.
      // Keep the HTTP request alive longer than that route-level timeout.
      idleTimeout: 70,
    });

    this._logger.info(
      "HTTP server is running on http://" +
        hostname +
        (port === 80 ? "" : ":" + port),
    );
  }

  /**
   * Gracefully shut down the server.
   */
  async stop(): Promise<void> {
    if (this._server) {
      await this._server.stop(true);
      this._logger.info("HTTP server stopped");
    }
  }

  private _setupStaticServing(): void {
    const webRoot = resolveWebDistPath();
    if (webRoot !== undefined) {
      const agentShellPath = join(webRoot, "index.html");
      const artifactPreviewShellPath = join(webRoot, "artifact-preview.html");
      const serveAgentShell = () =>
        new Response(Bun.file(agentShellPath), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      const serveArtifactPreviewShell = () =>
        new Response(
          Bun.file(
            existsSync(artifactPreviewShellPath)
              ? artifactPreviewShellPath
              : agentShellPath,
          ),
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );

      this._app.get("/", serveAgentShell);
      this._app.get("/artifacts/:id/preview", serveArtifactPreviewShell);
      const serveAgentAsset = serveStatic({
        root: webRoot,
        rewriteRequestPath: (path) => path.slice("/agent".length),
      });
      this._app.use("/agent/*", async (c, next) => {
        const pathname = new URL(c.req.url).pathname;
        if (!pathname.startsWith("/agent/") || pathname === "/agent/") {
          return next();
        }
        if (
          (c.req.method === "GET" || c.req.method === "HEAD") &&
          extname(pathname) === ""
        ) {
          return serveAgentShell();
        }
        return serveAgentAsset(c, next);
      });
    }
  }

  private _setupLoginPage(): void {
    this._app.get("/login", (c) =>
      c.html(renderLoginPage(new URL(c.req.url).searchParams.get("next"))),
    );
  }

  private _setupCliAuthPage(
    db: DrizzleDB | undefined,
    auth: DashboardAuthService,
  ): void {
    this._app.get("/auth/cli", (c) => {
      const session = dashboardAuthSessionFromContext(c) ??
        auth.sessionFromRequest(c);
      const userCode = new URL(c.req.url).searchParams.get("user_code") ?? "";
      const authSession = db === undefined || userCode.trim().length === 0
        ? undefined
        : db
            .select()
            .from(cliAuthSessions)
            .where(eq(cliAuthSessions.userCodeHash, hashAccessToken(userCode)))
            .get();
      return c.html(renderCliAuthPage({
        userCode,
        authenticated: session?.authenticated === true,
        userName: session?.user?.name ?? "",
        status: authSession?.status ?? "unknown",
      }));
    });
  }
}

export function resolveWebDistPath(input: {
  readonly moduleDir?: string;
  readonly cwd?: string;
  readonly env?: {
    readonly LUNA_WEB_DIST_PATH?: string;
  };
} = {}): string | undefined {
  const moduleDir = input.moduleDir ?? import.meta.dir;
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const candidates = uniquePaths([
    env.LUNA_WEB_DIST_PATH,
    join(cwd, "apps", "dashboard", "dist"),
    join(cwd, "luna", "apps", "dashboard", "dist"),
    join(moduleDir, "..", "apps", "dashboard", "dist"),
    join(moduleDir, "..", "..", "..", "..", "apps", "dashboard", "dist"),
    join(moduleDir, "..", "..", "..", "apps", "dashboard", "dist"),
  ]);
  return candidates.find((candidate) =>
    existsSync(join(candidate, "index.html"))
  );
}

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (path === undefined || path.trim().length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }
  return result;
}

function renderLoginPage(next: string | null): string {
  const safeNext = normalizeNextPath(next);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Luna Login</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
        --background: #fff;
        --foreground: #1c1917;
        --muted: #57534e;
        --border: #ddded8;
        --subtle: #f5f5f3;
        --ink: #1c1917;
        --ink-text: #fafaf9;
        --dots: #83877e;
        --danger: #b24739;
        --field-bg: rgb(28 25 23 / .025);
        --field-focus-bg: #fff;
        --field-border: rgb(28 25 23 / .12);
        --field-hover-border: rgb(28 25 23 / .24);
        --field-focus-border: rgb(28 25 23 / .55);
        --field-focus-ring: rgb(28 25 23 / .07);
        --placeholder: #8a847e;
        --readout-bg: rgb(28 25 23 / .045);
        background: var(--background);
        color: var(--foreground);
      }
      :root[data-theme="dark"] {
          color-scheme: dark;
          --background: #191a18;
          --foreground: #f0f1ec;
          --muted: #a4a99c;
          --border: #454b3d;
          --subtle: #262923;
          --ink: #e1e4d9;
          --ink-text: #252720;
          --dots: #929c83;
          --danger: #f1b0a6;
          --field-bg: rgb(255 255 255 / .03);
          --field-focus-bg: rgb(255 255 255 / .05);
          --field-border: rgb(255 255 255 / .1);
          --field-hover-border: rgb(255 255 255 / .22);
          --field-focus-border: rgb(255 255 255 / .5);
          --field-focus-ring: rgb(255 255 255 / .06);
          --placeholder: #a4a99c;
          --readout-bg: rgb(255 255 255 / .045);
      }
      * { box-sizing: border-box; }
      body { margin: 0; }
      .login-shell {
        position: relative;
        min-height: 100vh;
        min-height: 100dvh;
        display: flex;
        --hero-band: clamp(200px, 38dvh, 340px);
      }
      .login-hero {
        position: relative;
        flex: 1.15 1 0;
        min-width: 0;
        isolation: isolate;
        overflow: hidden;
      }
      .login-dots {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        mask-image: linear-gradient(to right, black calc(100% - 120px), transparent);
        pointer-events: none;
      }
      .welcome {
        position: absolute;
        right: clamp(32px, 7%, 96px);
        bottom: clamp(40px, 11%, 120px);
        max-width: calc(100% - 64px);
        text-align: right;
        margin: 0;
        font-size: clamp(26px, 2.6vw, 46px);
        font-weight: 700;
        letter-spacing: -.035em;
        text-shadow: 0 0 16px var(--background), 0 0 6px var(--background);
      }
      @media (prefers-reduced-motion: no-preference) {
        .welcome { animation: welcome-in .6s ease-out .35s both; }
        @keyframes welcome-in {
          from { opacity: 0; transform: translateY(14px); }
        }
      }
      .login-panel {
        flex: 1 1 0;
        min-width: min(400px, 100%);
        max-width: 640px;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto 1fr;
        padding: clamp(20px, 3.5vh, 36px) clamp(24px, 4vw, 56px);
      }
      .login-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        font-weight: 650;
      }
      .brand svg {
        flex: none;
        padding: 4px;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        color: #334155;
        background: linear-gradient(135deg, #fef3c7, #d1fae5, #7dd3fc);
      }
      .language { position: relative; flex: none; z-index: 1; font-size: 13px; }
      .language summary {
        display: flex;
        min-height: 34px;
        align-items: center;
        gap: 10px;
        padding: 0 10px;
        border: 1px solid transparent;
        border-radius: 9px;
        list-style: none;
        cursor: pointer;
      }
      .language summary::-webkit-details-marker { display: none; }
      .language summary:hover, .language[open] summary {
        border-color: var(--border);
        background: var(--subtle);
      }
      .language summary svg { width: 12px; height: 12px; }
      .language[open] summary svg { transform: rotate(180deg); }
      .language-options {
        position: absolute;
        top: calc(100% + 5px);
        right: 0;
        display: grid;
        width: 178px;
        gap: 3px;
        padding: 6px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--background);
        box-shadow: 0 12px 30px #0002;
      }
      .language-options button {
        min-height: 36px;
        padding: 8px 12px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--foreground);
        font-size: 13px;
        font-weight: 400;
        text-align: left;
      }
      .language-options button:hover, .language-options button[aria-pressed="true"] {
        background: var(--subtle);
        opacity: 1;
      }
      main {
        align-self: center;
        justify-self: center;
        width: min(360px, 100%);
        padding: 24px 0 32px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(26px, 2.2vw, 32px);
        font-weight: 600;
        line-height: 1.15;
        letter-spacing: -.02em;
      }
      .description {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.5;
      }
      form {
        margin-top: 28px;
        display: grid;
        gap: 20px;
      }
      .form-field {
        display: grid;
        gap: 8px;
      }
      .field-label {
        color: var(--muted);
        font-size: 13px;
        font-weight: 500;
        line-height: 1.4;
      }
      .server-url {
        display: flex;
        min-height: 44px;
        align-items: center;
        padding: 0 14px;
        border-radius: 10px;
        background: var(--readout-bg);
        color: var(--muted);
        font: 13px ui-monospace, monospace;
        overflow-wrap: anywhere;
      }
      #token, button[type="submit"], a.sso {
        width: 100%;
        min-height: 44px;
        border-radius: 10px;
        padding: 10px 14px;
        font: inherit;
        font-size: 14px;
      }
      .token-field { position: relative; }
      #token {
        height: 44px;
        padding: 0 48px 0 14px;
        border: 1px solid var(--field-border);
        background: var(--field-bg);
        color: var(--foreground);
        transition: background-color .15s, border-color .15s, box-shadow .15s;
      }
      #token::placeholder { color: var(--placeholder); }
      #token:hover { border-color: var(--field-hover-border); }
      #token:focus {
        outline: none;
        border-color: var(--field-focus-border);
        background: var(--field-focus-bg);
        box-shadow: 0 0 0 4px var(--field-focus-ring);
      }
      #token[aria-invalid="true"] { border-color: var(--danger); }
      .token-visibility {
        position: absolute;
        inset: 5px 6px 5px auto;
        display: grid;
        width: 34px;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--placeholder);
        cursor: pointer;
      }
      .token-visibility:hover { background: var(--subtle); color: var(--foreground); }
      .token-visibility svg { width: 16px; height: 16px; }
      .token-visibility[aria-pressed="false"] .eye-slash { display: none; }
      :is(button, summary, a.sso):focus-visible {
        outline: 2px solid var(--dots);
        outline-offset: 2px;
      }
      button[type="submit"], a.sso {
        font-weight: 600;
        letter-spacing: .01em;
        text-align: center;
        text-decoration: none;
      }
      button[type="submit"] {
        border: 1px solid var(--ink);
        background: var(--ink);
        color: var(--ink-text);
        cursor: pointer;
      }
      button[type="submit"]:hover { opacity: .88; }
      a.sso {
        display: block;
        margin-top: 12px;
        border: 1px solid var(--border);
        color: var(--foreground);
      }
      a.sso:hover { background: var(--subtle); }
      #error {
        margin: 0;
        color: var(--danger);
        font-size: 13px;
      }
      #error:empty { display: none; }
      @media (max-width: 768px) {
        .login-shell { display: block; }
        .login-hero {
          position: absolute;
          inset: 0 0 auto;
          height: var(--hero-band);
          pointer-events: none;
        }
        .login-panel {
          position: relative;
          min-width: 0;
          max-width: none;
          padding: 20px 24px;
        }
        .login-dots {
          mask-image: linear-gradient(to bottom, #0005, black 42%, transparent);
        }
        .welcome { display: none; }
        main { align-self: start; }
      }
      @media (max-width: 768px) and (min-height: 560px) {
        main { padding-top: calc(var(--hero-band) - 128px); }
      }
    </style>
    <script>
      try {
        const theme = localStorage.getItem("agentara-ui-theme");
        if (theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)) {
          document.documentElement.dataset.theme = "dark";
        }
      } catch {}
    </script>
  </head>
  <body>
    <div class="login-shell" data-testid="service-login-page">
      <aside class="login-hero" aria-hidden="true">
        <canvas class="login-dots"></canvas>
        <p class="welcome" lang="en">Welcome to Luna.</p>
      </aside>
      <div class="login-panel">
        <header class="login-header">
          <div class="brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20.9 13.4A9 9 0 0 1 10.6 3.1 9 9 0 1 0 20.9 13.4Z" />
            </svg>
            <span data-i18n="Luna Management Console">Luna Management Console</span>
          </div>
          <details class="language" id="language">
            <summary aria-label="Language">
              <span id="current-language">English</span>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
            </summary>
            <div class="language-options">
              <button type="button" lang="zh-CN" data-language="zh-CN" aria-pressed="false">简体中文</button>
              <button type="button" lang="en" data-language="en" aria-pressed="false">English</button>
            </div>
          </details>
        </header>
        <main>
          <h1 data-i18n="Dashboard Login">Dashboard Login</h1>
          <p class="description" data-i18n="Sign in to manage your Luna workspace.">Sign in to manage your Luna workspace.</p>
          <form id="login-form">
            <div class="form-field">
              <span class="field-label" id="server-label" data-i18n="Current URL">Current URL</span>
              <output id="server-url" class="server-url" aria-labelledby="server-label"></output>
            </div>
            <div class="form-field">
              <label for="token" class="field-label" data-i18n="Access token">Access token</label>
              <div class="token-field">
                <input id="token" name="token" type="password" placeholder="Enter your access token" autocomplete="current-password" autofocus />
                <button class="token-visibility" id="token-visibility" type="button" aria-controls="token" aria-label="Show access token" aria-pressed="false">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/>
                    <circle cx="12" cy="12" r="2.5"/>
                    <path class="eye-slash" d="m3 3 18 18"/>
                  </svg>
                </button>
              </div>
            </div>
            <p id="error" role="alert"></p>
            <button type="submit" data-i18n="Login">Login</button>
          </form>
          <a class="sso" href="/api/auth/sso/start?next=${encodeURIComponent(safeNext)}" data-i18n="SSO Login">SSO Login</a>
        </main>
      </div>
    </div>
    <script>${loginDotMatrixScript}</script>
    <script>
      const translations = {"Dashboard Login": "登录控制台", "Sign in to manage your Luna workspace.": "登录以管理你的 Luna 工作空间。", "SSO Login": "SSO 登录", "Luna Management Console": "Luna 管理控制台", "Current URL": "当前地址", "Access token": "访问令牌", "Login": "登录", "Enter your access token": "输入访问令牌", "Show access token": "显示访问令牌", "Invalid token": "访问令牌无效"};
      let language = navigator.language.startsWith("zh") ? "zh-CN" : "en";
      try {
        const savedLanguage = localStorage.getItem("luna-ui-language");
        if (savedLanguage === "en" || savedLanguage === "zh-CN") language = savedLanguage;
      } catch {}
      const translate = text => language === "zh-CN" ? translations[text] || text : text;
      const languageMenu = document.getElementById("language");
      const languageTrigger = languageMenu.querySelector("summary");
      const languageOptions = languageMenu.querySelectorAll("[data-language]");
      const tokenInput = document.getElementById("token");
      const tokenVisibility = document.getElementById("token-visibility");
      document.getElementById("server-url").textContent = window.location.origin;
      tokenVisibility.addEventListener("click", () => {
        const show = tokenInput.type === "password";
        tokenInput.type = show ? "text" : "password";
        tokenVisibility.setAttribute("aria-pressed", String(show));
      });
      function applyLanguage() {
        document.documentElement.lang = language;
        languageOptions.forEach(option => {
          const selected = option.dataset.language === language;
          option.setAttribute("aria-pressed", String(selected));
          if (selected) document.getElementById("current-language").textContent = option.textContent;
        });
        document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = translate(el.dataset.i18n); });
        tokenInput.placeholder = translate("Enter your access token");
        tokenVisibility.setAttribute("aria-label", translate("Show access token"));
        if (document.getElementById("error").textContent) document.getElementById("error").textContent = translate("Invalid token");
      }
      languageOptions.forEach(option => option.addEventListener("click", () => {
        language = option.dataset.language;
        try { localStorage.setItem("luna-ui-language", language); } catch {}
        applyLanguage();
        languageMenu.open = false;
        languageTrigger.focus();
      }));
      document.addEventListener("click", event => {
        if (!languageMenu.contains(event.target)) languageMenu.open = false;
      });
      languageMenu.addEventListener("keydown", event => {
        if (event.key === "Escape" && languageMenu.open) {
          languageMenu.open = false;
          languageTrigger.focus();
        }
      });
      applyLanguage();
      const form = document.getElementById("login-form");
      const error = document.getElementById("error");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.textContent = "";
        tokenInput.removeAttribute("aria-invalid");
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: tokenInput.value }),
        });
        if (!response.ok) {
          tokenInput.setAttribute("aria-invalid", "true");
          error.textContent = translate("Invalid token");
          return;
        }
        window.location.assign(${JSON.stringify(safeNext)});
      });
    </script>
  </body>
</html>`;
}

function renderCliAuthPage(input: {
  readonly authenticated: boolean;
  readonly userCode: string;
  readonly userName: string;
  readonly status: string;
}): string {
  const safeUserCode = escapeHtml(input.userCode);
  const safeUserName = escapeHtml(input.userName);
  const safeStatus = escapeHtml(input.status);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Luna CLI Authorization</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --background: oklch(0.2679 0.0036 106.64);
        --foreground: oklch(0.985 0 0);
        --card: oklch(0.2884 0.0036 106.64);
        --muted: oklch(0.3008 0.0018 106.51);
        --muted-foreground: oklch(0.708 0 0);
        --primary: white;
        --primary-foreground: oklch(0.205 0 0);
        --border: oklch(0.3161 0.0052 106.7);
        background: var(--background);
        color: var(--foreground);
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 2rem;
      }
      main {
        width: min(100%, 34rem);
        border: 1px solid var(--border);
        border-radius: 1rem;
        background: var(--card);
        padding: 1.5rem;
      }
      h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
      p { color: var(--muted-foreground); line-height: 1.6; }
      code {
        display: inline-flex;
        border-radius: 0.5rem;
        background: var(--muted);
        padding: 0.2rem 0.45rem;
      }
      ul { margin: 0.5rem 0 1rem; padding-left: 1.2rem; color: var(--muted-foreground); }
      .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
      .form { display: grid; gap: 0.75rem; margin-top: 1.5rem; }
      label { display: grid; gap: 0.4rem; color: var(--muted-foreground); }
      input {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 0.625rem;
        background: var(--muted);
        color: var(--foreground);
        padding: 0.75rem 0.85rem;
        font: inherit;
      }
      button {
        border: 1px solid var(--border);
        border-radius: 0.625rem;
        padding: 0.7rem 1rem;
        font: inherit;
        cursor: pointer;
      }
      .approve { background: var(--primary); color: var(--primary-foreground); }
      .deny { background: transparent; color: var(--foreground); }
    </style>
  </head>
  <body>
    <main>
      <h1>Luna CLI Authorization</h1>
      <p>User code <code>${safeUserCode}</code> is currently <code>${safeStatus}</code>.</p>
      <p>This will identify Luna CLI requests as your Luna user. Runtime permissions are evaluated from your current user and group operation grants.</p>
      ${input.authenticated
        ? `<p>Signed in as <strong>${safeUserName}</strong>.</p>
      <div class="actions">
        <button class="approve" data-action="approve">Approve</button>
        <button class="deny" data-action="deny">Deny</button>
      </div>`
        : `<p>Send <code>#auth</code> to the Feishu bot in a private chat. Paste the returned one-time token below to approve this CLI login.</p>
      <div class="form">
        <label>
          One-time token
          <input data-role="channel-token" autocomplete="one-time-code" />
        </label>
        <button class="approve" data-action="approve-channel-token">Approve with Feishu token</button>
      </div>`}
    </main>
    <script>
      const userCode = ${JSON.stringify(input.userCode)};
      async function submit(path) {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userCode }),
        });
        const payload = await response.json();
        document.querySelector("main").insertAdjacentHTML(
          "beforeend",
          "<p><code>" + payload.status + "</code></p>",
        );
      }
      document.querySelector('[data-action="approve"]')?.addEventListener("click", () => submit("/api/auth/cli/confirm"));
      document.querySelector('[data-action="deny"]')?.addEventListener("click", () => submit("/api/auth/cli/deny"));
      document.querySelector('[data-action="approve-channel-token"]')?.addEventListener("click", async () => {
        const token = document.querySelector('[data-role="channel-token"]').value;
        const response = await fetch("/api/auth/cli/confirm-channel-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userCode, token }),
        });
        const payload = await response.json();
        document.querySelector("main").insertAdjacentHTML(
          "beforeend",
          "<p><code>" + payload.status + "</code></p>",
        );
      });
    </script>
  </body>
</html>`;
}

function normalizeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
