import {requireKnowledgeAgent} from "../policy/knowledge-access";
import {AgentError} from "@/agents/agent-store";
import {config} from "@/shared";
import { Hono, type Context } from "hono";

import type { DrizzleDB } from "@/data";
import type { WorkspaceGrepRequest } from "@luna/service-client/workspace-client";
import {
  createKnowledgeWorkspaceRepository,
  KNOWLEDGE_WORKSPACE_ID,
  knowledgeWorkspaceOperation,
  type KnowledgeWorkspaceOperation,
} from "../../../extensions/workspace/knowledge/definition";
import { GatewayError } from "../gateway-error";
import { WorkspaceRepository } from "../../workspace/repository";
import { getKernel } from "./kernel";

export interface WorkspaceRouteOptions {
  readonly serviceHome?: string;
  readonly db?: DrizzleDB;
}

export function createWorkspaceRoutes(options: WorkspaceRouteOptions = {}) {
  const getHome = () => options.serviceHome ?? config.paths.home;
  const getDb = () => options.db ?? getKernel().database.db;

  return new Hono()
    .get("/:workspaceId/glob", (c) =>
      handleWorkspace(c, () => {
        const context = workspaceContext(c, getDb(), getHome(), "read");
        return c.json(context.repository.glob(requiredQuery(c.req.query("pattern"), "pattern")));
      })
    )
    .get("/:workspaceId/grep", (c) =>
      handleWorkspace(c, () => {
        const context = workspaceContext(c, getDb(), getHome(), "read");
        return c.json(
          context.repository.grep(
            grepRequestFromQuery(c),
            c.req.query("glob") ?? "**/*",
          ),
        );
      })
    )
    .get("/:workspaceId/file", (c) =>
      handleWorkspace(c, () => {
        const context = workspaceContext(c, getDb(), getHome(), "read");
        return c.json(context.repository.readFile(requiredQuery(c.req.query("path"), "path")));
      })
    )
    .put("/:workspaceId/file", async (c) =>
      handleWorkspace(c, async () => {
        const body = await readBody(c.req.raw);
        const context = workspaceContext(c, getDb(), getHome(), "write");
        return c.json(
          context.repository.writeFile(
            requiredBodyString(body.path, "path"),
            requiredBodyText(body.content, "content"),
          ),
        );
      })
    )
    .get("/:workspaceId/git/status", (c) =>
      handleWorkspace(c, () => {
        const context = workspaceContext(c, getDb(), getHome(), "read");
        return c.json(context.repository.gitStatus());
      })
    )
    .get("/:workspaceId/git/diff", (c) =>
      handleWorkspace(c, () => {
        const context = workspaceContext(c, getDb(), getHome(), "read");
        return c.json(context.repository.gitDiff());
      })
    )
    .post("/:workspaceId/git/commit", async (c) =>
      handleWorkspace(c, async () => {
        const body = await readBody(c.req.raw);
        const context = workspaceContext(c, getDb(), getHome(), "git.commit");
        return c.json(
          context.repository.gitCommit(requiredBodyString(body.message, "message")),
        );
      })
    );
}

export const workspaceRoutes = createWorkspaceRoutes();

function workspaceContext(
  c: Context,
  db: DrizzleDB,
  repoRoot: string,
  operation: KnowledgeWorkspaceOperation,
): { readonly repository: WorkspaceRepository } {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId !== KNOWLEDGE_WORKSPACE_ID) {
    throw new GatewayError(
      "404_workspace_not_found",
      `workspace not found: ${workspaceId}`,
      404,
    );
  }
  const agentId=requireKnowledgeAgent(c,db,knowledgeWorkspaceOperation(operation));
  return {repository:createKnowledgeWorkspaceRepository(repoRoot,agentId)};
}

async function handleWorkspace(
  c: Context,
  fn: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if(error instanceof AgentError) return c.json({status:"error",code:error.code},error.status);
    if (error instanceof GatewayError) {
      return c.json(workspaceErrorBody(error), error.status as 400 | 401 | 403 | 404 | 500);
    }
    return c.json(
      {
        status: "error",
        code: "internal_error",
        message: error instanceof Error ? error.message : "unknown error",
      },
      500,
    );
  }
}

function workspaceErrorBody(error: GatewayError): Record<string, string | number> {
  return {
    status: "error",
    code: normalizeWorkspaceErrorCode(error.code),
    message: error.message,
  };
}

function normalizeWorkspaceErrorCode(code: string): string {
  switch (code) {
    case "400_bad_request":
      return "invalid_request";
    case "401_unauthorized":
      return "unauthorized";
    case "403_forbidden":
      return "forbidden";
    case "404_workspace_not_found":
      return "workspace_not_found";
    default:
      return code;
  }
}

function requiredQuery(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new GatewayError("400_bad_request", `missing ${name}`, 400);
  }
  return value;
}

function grepRequestFromQuery(c: Context): WorkspaceGrepRequest {
  const params = new URL(c.req.url).searchParams;
  const query = c.req.query("query");
  const queries = params.getAll("queries");
  if (
    (query === undefined || query.trim().length === 0) &&
    queries.every((item) => item.trim().length === 0)
  ) {
    throw new GatewayError("400_bad_request", "missing query", 400);
  }
  return {
    ...(query === undefined ? {} : { query }),
    ...(queries.length === 0 ? {} : { queries }),
    ...(c.req.query("glob") === undefined ? {} : { glob: c.req.query("glob") }),
    ...optionalGrepMode(c.req.query("mode")),
    ...optionalGrepMatch(c.req.query("match")),
  };
}

function optionalGrepMode(
  value: string | undefined,
): Pick<WorkspaceGrepRequest, "mode"> | Record<string, never> {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }
  if (value === "literal" || value === "regex") {
    return { mode: value };
  }
  throw new GatewayError("400_bad_request", "mode must be literal or regex", 400);
}

function optionalGrepMatch(
  value: string | undefined,
): Pick<WorkspaceGrepRequest, "match"> | Record<string, never> {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }
  if (value === "any" || value === "all") {
    return { match: value };
  }
  throw new GatewayError("400_bad_request", "match must be any or all", 400);
}

function requiredBodyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GatewayError("400_bad_request", `missing ${name}`, 400);
  }
  return value.trim();
}

function requiredBodyText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new GatewayError("400_bad_request", `missing ${name}`, 400);
  }
  return value;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
