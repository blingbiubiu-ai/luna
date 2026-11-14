import { type KnowledgeConfig } from "./config";
import { serviceAuthHeaders } from "./service-auth";

export type WorkspaceGrepMode = "literal" | "regex";
export type WorkspaceGrepMatchMode = "any" | "all";

export interface WorkspaceGrepRequest {
  readonly query?: string | undefined;
  readonly queries?: readonly string[] | undefined;
  readonly glob?: string | undefined;
  readonly mode?: WorkspaceGrepMode | undefined;
  readonly match?: WorkspaceGrepMatchMode | undefined;
}

export interface WorkspaceClient {
  glob(workspaceId: string, pattern: string): Promise<unknown>;
  grep(workspaceId: string, query: string | WorkspaceGrepRequest, glob?: string | undefined): Promise<unknown>;
  read(workspaceId: string, path: string): Promise<unknown>;
  write(workspaceId: string, path: string, content: string): Promise<unknown>;
  gitStatus(workspaceId: string): Promise<unknown>;
  gitDiff(workspaceId: string): Promise<unknown>;
  gitCommit(workspaceId: string, message: string): Promise<unknown>;
}

export interface WorkspaceClientOptions {
  readonly fetch?: typeof fetch;
}

export function createWorkspaceClient(
  config: Pick<KnowledgeConfig, "serviceUrl" | "accessToken" | "agentId">,
  options: WorkspaceClientOptions = {},
): WorkspaceClient {
  if (!config.serviceUrl) {
    throw new Error("Luna Service URL is required for workspace access");
  }
  return new UnifiedServiceWorkspaceClient(
    config.serviceUrl,
    config.accessToken,
    options.fetch ?? fetch,
    config.agentId,
  );
}

class UnifiedServiceWorkspaceClient implements WorkspaceClient {
  constructor(
    private readonly serviceUrl: string,
    private readonly accessToken: string | undefined,
    private readonly fetchImpl: typeof fetch,
    private readonly agentId:string|undefined,
  ) {}

  glob(workspaceId: string, pattern: string): Promise<unknown> {
    const url = this._url(`/api/workspaces/${workspaceId}/glob`);
    url.searchParams.set("pattern", pattern);
    return this._json(url, { method: "GET" });
  }

  grep(workspaceId: string, query: string | WorkspaceGrepRequest, glob?: string | undefined): Promise<unknown> {
    const url = this._url(`/api/workspaces/${workspaceId}/grep`);
    if (typeof query === "string") {
      url.searchParams.set("query", query);
      if (glob !== undefined) {
        url.searchParams.set("glob", glob);
      }
    } else {
      if (query.query !== undefined) {
        url.searchParams.set("query", query.query);
      }
      for (const item of query.queries ?? []) {
        url.searchParams.append("queries", item);
      }
      if (query.glob !== undefined || glob !== undefined) {
        url.searchParams.set("glob", query.glob ?? glob ?? "");
      }
      if (query.mode !== undefined) {
        url.searchParams.set("mode", query.mode);
      }
      if (query.match !== undefined) {
        url.searchParams.set("match", query.match);
      }
    }
    return this._json(url, { method: "GET" });
  }

  read(workspaceId: string, path: string): Promise<unknown> {
    const url = this._url(`/api/workspaces/${workspaceId}/file`);
    url.searchParams.set("path", path);
    return this._json(url, { method: "GET" });
  }

  write(workspaceId: string, path: string, content: string): Promise<unknown> {
    return this._json(this._url(`/api/workspaces/${workspaceId}/file`), {
      method: "PUT",
      body: { path, content },
    });
  }

  gitStatus(workspaceId: string): Promise<unknown> {
    return this._json(this._url(`/api/workspaces/${workspaceId}/git/status`), {
      method: "GET",
    });
  }

  gitDiff(workspaceId: string): Promise<unknown> {
    return this._json(this._url(`/api/workspaces/${workspaceId}/git/diff`), {
      method: "GET",
    });
  }

  gitCommit(workspaceId: string, message: string): Promise<unknown> {
    return this._json(this._url(`/api/workspaces/${workspaceId}/git/commit`), {
      method: "POST",
      body: { message },
    });
  }

  private _url(path: string): URL {
    const url=new URL(path,this.serviceUrl);
    if(this.agentId) url.searchParams.set("agentId",this.agentId);
    return url;
  }

  private async _json(
    url: URL,
    input: { readonly method: "GET" | "POST" | "PUT"; readonly body?: Record<string, unknown> },
  ): Promise<unknown> {
    const headers = serviceAuthHeaders({ accessToken: this.accessToken });
    const init: RequestInit = {
      method: input.method,
      headers,
    };
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      throw new Error(`Luna Service workspace request failed: ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }
}
