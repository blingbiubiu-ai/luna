import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  type WorkspaceClient,
  type WorkspaceGrepRequest,
} from "@luna/service-client/workspace-client";
import { KNOWLEDGE_WORKSPACE_ID } from "../../extensions/workspace/knowledge/definition";

export interface KnowledgeToolHandlers {
  luna_knowledge_read(args: { path: string }): Promise<CallToolResult>;
  luna_workspace_glob(args: { workspaceId: string; pattern: string }): Promise<CallToolResult>;
  luna_workspace_grep(args: { workspaceId: string } & WorkspaceGrepRequest): Promise<CallToolResult>;
  luna_workspace_read(args: { workspaceId: string; path: string }): Promise<CallToolResult>;
  luna_workspace_write(args: { workspaceId: string; path: string; content: string }): Promise<CallToolResult>;
  luna_workspace_git_status(args: { workspaceId: string }): Promise<CallToolResult>;
  luna_workspace_git_diff(args: { workspaceId: string }): Promise<CallToolResult>;
  luna_workspace_git_commit(args: { workspaceId: string; message: string }): Promise<CallToolResult>;
  luna_knowledge_glob(args: { pattern: string }): Promise<CallToolResult>;
  luna_knowledge_grep(args: WorkspaceGrepRequest): Promise<CallToolResult>;
  luna_knowledge_write(args: { path: string; content: string }): Promise<CallToolResult>;
  luna_knowledge_git_status(args: Record<string, never>): Promise<CallToolResult>;
  luna_knowledge_git_diff(args: Record<string, never>): Promise<CallToolResult>;
  luna_knowledge_git_commit(args: { message: string }): Promise<CallToolResult>;
}

const emptySchema = z.object({});
const knowledgeReadSchema = z.object({ path: z.string() });
const workspaceIdSchema = { workspaceId: z.string() };
const workspaceGlobSchema = z.object({ ...workspaceIdSchema, pattern: z.string() });
const workspaceGrepSchema = z.object({
  ...workspaceIdSchema,
  query: z.string().optional(),
  queries: z.array(z.string()).optional(),
  glob: z.string().optional(),
  mode: z.enum(["literal", "regex"]).optional(),
  match: z.enum(["any", "all"]).optional(),
});
const workspaceReadSchema = z.object({ ...workspaceIdSchema, path: z.string() });
const workspaceWriteSchema = z.object({
  ...workspaceIdSchema,
  path: z.string(),
  content: z.string(),
});
const workspaceCommitSchema = z.object({ ...workspaceIdSchema, message: z.string() });
const knowledgeGlobSchema = z.object({ pattern: z.string() });
const knowledgeGrepSchema = z.object({
  query: z.string().optional(),
  queries: z.array(z.string()).optional(),
  glob: z.string().optional(),
  mode: z.enum(["literal", "regex"]).optional(),
  match: z.enum(["any", "all"]).optional(),
});
const knowledgeWriteSchema = z.object({ path: z.string(), content: z.string() });
const knowledgeCommitSchema = z.object({ message: z.string() });

export function createKnowledgeToolHandlers(
  workspaceClient: WorkspaceClient,
): KnowledgeToolHandlers {
  return {
    async luna_knowledge_read(args) {
      return textResult(await workspaceClient.read(KNOWLEDGE_WORKSPACE_ID, args.path));
    },
    async luna_workspace_glob(args) {
      return textResult(await workspaceClient.glob(args.workspaceId, args.pattern));
    },
    async luna_workspace_grep(args) {
      const { workspaceId, ...request } = args;
      return textResult(await workspaceClient.grep(workspaceId, request));
    },
    async luna_workspace_read(args) {
      return textResult(await workspaceClient.read(args.workspaceId, args.path));
    },
    async luna_workspace_write(args) {
      return textResult(await workspaceClient.write(args.workspaceId, args.path, args.content));
    },
    async luna_workspace_git_status(args) {
      return textResult(await workspaceClient.gitStatus(args.workspaceId));
    },
    async luna_workspace_git_diff(args) {
      return textResult(await workspaceClient.gitDiff(args.workspaceId));
    },
    async luna_workspace_git_commit(args) {
      return textResult(await workspaceClient.gitCommit(args.workspaceId, args.message));
    },
    async luna_knowledge_glob(args) {
      return textResult(await workspaceClient.glob(KNOWLEDGE_WORKSPACE_ID, args.pattern));
    },
    async luna_knowledge_grep(args) {
      return textResult(await workspaceClient.grep(KNOWLEDGE_WORKSPACE_ID, args));
    },
    async luna_knowledge_write(args) {
      return textResult(await workspaceClient.write(KNOWLEDGE_WORKSPACE_ID, args.path, args.content));
    },
    async luna_knowledge_git_status() {
      return textResult(await workspaceClient.gitStatus(KNOWLEDGE_WORKSPACE_ID));
    },
    async luna_knowledge_git_diff() {
      return textResult(await workspaceClient.gitDiff(KNOWLEDGE_WORKSPACE_ID));
    },
    async luna_knowledge_git_commit(args) {
      return textResult(await workspaceClient.gitCommit(KNOWLEDGE_WORKSPACE_ID, args.message));
    },
  };
}

export function createKnowledgeMcpServer(
  workspaceClient: WorkspaceClient,
): McpServer {
  const server = new McpServer({ name: "luna-knowledge", version: "0.1.0" });
  const handlers = createKnowledgeToolHandlers(workspaceClient);
  server.registerTool(
    "luna_knowledge_read",
    { title: "Read Luna knowledge", description: "Read a permitted Luna knowledge page", inputSchema: knowledgeReadSchema },
    async (args) => handlers.luna_knowledge_read(args),
  );
  server.registerTool(
    "luna_workspace_glob",
    { title: "Glob Luna workspace", description: "List files in a managed Luna workspace", inputSchema: workspaceGlobSchema },
    async (args) => handlers.luna_workspace_glob(args),
  );
  server.registerTool(
    "luna_workspace_grep",
    { title: "Grep Luna workspace", description: "Search text in a managed Luna workspace", inputSchema: workspaceGrepSchema },
    async (args) => handlers.luna_workspace_grep(args),
  );
  server.registerTool(
    "luna_workspace_read",
    { title: "Read Luna workspace file", description: "Read a file from a managed Luna workspace", inputSchema: workspaceReadSchema },
    async (args) => handlers.luna_workspace_read(args),
  );
  server.registerTool(
    "luna_workspace_write",
    { title: "Write Luna workspace file", description: "Write a full file in a managed Luna workspace", inputSchema: workspaceWriteSchema },
    async (args) => handlers.luna_workspace_write(args),
  );
  server.registerTool(
    "luna_workspace_git_status",
    { title: "Luna workspace git status", description: "Show git status for a managed Luna workspace", inputSchema: z.object(workspaceIdSchema) },
    async (args) => handlers.luna_workspace_git_status(args),
  );
  server.registerTool(
    "luna_workspace_git_diff",
    { title: "Luna workspace git diff", description: "Show git diff for a managed Luna workspace", inputSchema: z.object(workspaceIdSchema) },
    async (args) => handlers.luna_workspace_git_diff(args),
  );
  server.registerTool(
    "luna_workspace_git_commit",
    { title: "Commit Luna workspace changes", description: "Commit changes for a managed Luna workspace", inputSchema: workspaceCommitSchema },
    async (args) => handlers.luna_workspace_git_commit(args),
  );
  server.registerTool(
    "luna_knowledge_glob",
    { title: "Glob Luna knowledge workspace", description: "List files in the knowledge workspace", inputSchema: knowledgeGlobSchema },
    async (args) => handlers.luna_knowledge_glob(args),
  );
  server.registerTool(
    "luna_knowledge_grep",
    { title: "Grep Luna knowledge workspace", description: "Search text in the knowledge workspace", inputSchema: knowledgeGrepSchema },
    async (args) => handlers.luna_knowledge_grep(args),
  );
  server.registerTool(
    "luna_knowledge_write",
    { title: "Write Luna knowledge file", description: "Write a full file in the knowledge workspace", inputSchema: knowledgeWriteSchema },
    async (args) => handlers.luna_knowledge_write(args),
  );
  server.registerTool(
    "luna_knowledge_git_status",
    { title: "Luna knowledge git status", description: "Show git status for the knowledge workspace", inputSchema: emptySchema },
    async () => handlers.luna_knowledge_git_status({}),
  );
  server.registerTool(
    "luna_knowledge_git_diff",
    { title: "Luna knowledge git diff", description: "Show git diff for the knowledge workspace", inputSchema: emptySchema },
    async () => handlers.luna_knowledge_git_diff({}),
  );
  server.registerTool(
    "luna_knowledge_git_commit",
    { title: "Commit Luna knowledge changes", description: "Commit changes for the knowledge workspace", inputSchema: knowledgeCommitSchema },
    async (args) => handlers.luna_knowledge_git_commit(args),
  );

  return server;
}

export async function connectKnowledgeMcpStdio(
  workspaceClient: WorkspaceClient,
): Promise<McpServer> {
  const server = createKnowledgeMcpServer(workspaceClient);
  await server.connect(new StdioServerTransport());
  return server;
}

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
