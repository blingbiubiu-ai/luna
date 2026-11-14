import {requireKnowledgeAgent} from "../policy/knowledge-access";
import {config} from "@/shared";
import { Hono, type Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { DrizzleDB } from "@/data";
import type { WorkspaceGrepRequest } from "@luna/service-client/workspace-client";
import type { WorkspaceClient } from "@luna/service-client/workspace-client";
import {
  createKnowledgeWorkspaceRepository,
  KNOWLEDGE_WORKSPACE_ID,
  knowledgeWorkspaceOperation,
  type KnowledgeWorkspaceOperation,
} from "../../../extensions/workspace/knowledge/definition";
import { GatewayError } from "../gateway-error";
import { WorkspaceRepository } from "../../workspace/repository";
import { createKnowledgeMcpServer } from "../../mcp/knowledge-server";
import { getKernel } from "./kernel";

export interface McpRouteOptions {
  readonly serviceHome?: string;
  readonly db?: DrizzleDB;
}

export function createMcpRoutes(options: McpRouteOptions = {}) {
  const getHome = () => options.serviceHome ?? config.paths.home;
  const getDb = () => options.db ?? getKernel().database.db;

  return new Hono().all("/", async (c) => {
    const requestServer = createKnowledgeMcpServer(
      new RequestScopedWorkspaceClient(c, getDb(), getHome()),
    );
    const requestTransport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await requestServer.connect(requestTransport);
    return requestTransport.handleRequest(c.req.raw);
  });
}

class RequestScopedWorkspaceClient implements WorkspaceClient {
  constructor(
    private readonly _context: Context,
    private readonly _db: DrizzleDB,
    private readonly _repoRoot: string,
  ) {}

  glob(workspaceId: string, pattern: string): Promise<unknown> {
    return Promise.resolve(
      this._workspace(workspaceId, "read").glob(pattern),
    );
  }

  grep(
    workspaceId: string,
    query: string | WorkspaceGrepRequest,
    glob?: string | undefined,
  ): Promise<unknown> {
    return Promise.resolve(
      this._workspace(workspaceId, "read").grep(
        query,
        typeof query === "string" ? glob ?? "**/*" : query.glob ?? glob ?? "**/*",
      ),
    );
  }

  read(workspaceId: string, path: string): Promise<unknown> {
    return Promise.resolve(
      this._workspace(workspaceId, "read").readFile(path),
    );
  }

  write(workspaceId: string, path: string, content: string): Promise<unknown> {
    return Promise.resolve(
      this._workspace(workspaceId, "write").writeFile(path, content),
    );
  }

  gitStatus(workspaceId: string): Promise<unknown> {
    return Promise.resolve(
      this._workspace(workspaceId, "read").gitStatus(),
    );
  }

  gitDiff(workspaceId: string): Promise<unknown> {
    return Promise.resolve(
      this._workspace(workspaceId, "read").gitDiff(),
    );
  }

  gitCommit(workspaceId: string, message: string): Promise<unknown> {
    return Promise.resolve(
      this._workspace(workspaceId, "git.commit").gitCommit(message),
    );
  }

  private _workspace(
    workspaceId: string,
    operation: KnowledgeWorkspaceOperation,
  ): WorkspaceRepository {
    if (workspaceId !== KNOWLEDGE_WORKSPACE_ID) {
      throw new GatewayError(
        "404_workspace_not_found",
        `workspace not found: ${workspaceId}`,
        404,
      );
    }
    const agentId=requireKnowledgeAgent(this._context,this._db,knowledgeWorkspaceOperation(operation));
    return createKnowledgeWorkspaceRepository(this._repoRoot,agentId);
  }
}


export const mcpRoutes = createMcpRoutes();
