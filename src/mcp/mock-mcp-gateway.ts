import type {
  CreatePullRequestInput,
  CreateTicketInput,
  McpActor,
  McpToolCallContext,
  McpToolName,
  QueryClientLogsInput,
  QueryConfigInput,
  QueryCrashReportsInput,
  QueryEventsInput,
  QueryFeatureFlagsInput,
  QueryServerLogsInput,
  QueryUserProfileInput,
  SearchCodeInput,
  SearchKnowledgeBaseInput,
  StableJson,
} from "@/mcp/types";
import {
  PermissionEngine,
  type PermissionCheckInput,
  type PermissionResource,
} from "@/permissions/permission-engine";
import type { TimelineStore } from "@/timeline/timeline-store";

/**
 * Configuration options for gateway integration mock mcp gateway behavior in MCP.
 */
export interface MockMcpGatewayOptions {
  readonly actor?: McpActor;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly timeline?: TimelineStore;
  readonly permissionEngine?: PermissionEngine;
}

/**
 * Bridges Mock MCP Gateway calls for MCP gateway integration.
 */
export class MockMcpGateway {
  private readonly _actor: McpActor | undefined;
  private readonly _taskId: string | undefined;
  private readonly _sessionId: string | undefined;
  private readonly _timeline: TimelineStore | undefined;
  private readonly _permissionEngine: PermissionEngine;

  constructor(options: MockMcpGatewayOptions = {}) {
    this._actor = options.actor;
    this._taskId = options.taskId;
    this._sessionId = options.sessionId;
    this._timeline = options.timeline;
    this._permissionEngine = options.permissionEngine ?? new PermissionEngine();
  }

  async queryUserProfile(
    input: QueryUserProfileInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    return this._runTool(
      "queryUserProfile",
      input,
      {
        kind: "user_profile",
        userId: input.userId,
        view: input.view,
      },
      {},
      () => ({
        tool: "queryUserProfile",
        userId: input.userId,
        view: input.view,
        profile: {
          displayName: `Mock User ${input.userId}`,
          locale: "en-US",
          region: "NA",
          tier: "standard",
        },
        redactions: ["email", "phone", "deviceIds"],
      }),
      context,
    );
  }

  async queryClientLogs(
    input: QueryClientLogsInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    const limit = _limit(input.limit);
    return this._runTool(
      "queryClientLogs",
      input,
      {
        kind: "client_logs",
        userId: input.userId,
        appId: input.appId,
      },
      { limit },
      () => ({
        tool: "queryClientLogs",
        appId: input.appId,
        userId: input.userId,
        limit,
        entries: [
          {
            timestamp: "2026-05-30T10:00:00.000Z",
            level: "info",
            message: "reader app launched",
            sessionId: `session-${input.userId}-1`,
          },
          {
            timestamp: "2026-05-30T10:00:05.000Z",
            level: "warn",
            message: "retrying feed request",
            sessionId: `session-${input.userId}-1`,
          },
        ].slice(0, limit),
      }),
      context,
    );
  }

  async queryServerLogs(
    input: QueryServerLogsInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    const limit = _limit(input.limit);
    return this._runTool(
      "queryServerLogs",
      input,
      {
        kind: "server_logs",
        service: input.service,
      },
      { limit },
      () => ({
        tool: "queryServerLogs",
        service: input.service,
        region: input.region,
        limit,
        entries: [
          {
            timestamp: "2026-05-30T10:00:01.000Z",
            level: "info",
            message: "GET /feed 200",
            traceId: `trace-${input.service}-${input.region}-1`,
          },
          {
            timestamp: "2026-05-30T10:00:06.000Z",
            level: "error",
            message: "upstream timeout",
            traceId: `trace-${input.service}-${input.region}-2`,
          },
        ].slice(0, limit),
      }),
      context,
    );
  }

  async queryEvents(
    input: QueryEventsInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    const limit = _limit(input.limit);
    return this._runTool(
      "queryEvents",
      input,
      {
        kind: "events",
        userId: input.userId,
      },
      { limit },
      () => ({
        tool: "queryEvents",
        userId: input.userId,
        eventName: input.eventName,
        limit,
        events: [
          {
            timestamp: "2026-05-30T10:00:02.000Z",
            eventName: input.eventName,
            properties: { surface: "home", userId: input.userId },
          },
          {
            timestamp: "2026-05-30T10:00:07.000Z",
            eventName: input.eventName,
            properties: { surface: "detail", userId: input.userId },
          },
        ].slice(0, limit),
      }),
      context,
    );
  }

  async queryCrashReports(
    input: QueryCrashReportsInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    const appVersion = input.appVersion ?? "unknown";
    return this._runTool(
      "queryCrashReports",
      input,
      {
        kind: "crash_reports",
        userId: input.userId,
      },
      {},
      () => ({
        tool: "queryCrashReports",
        userId: input.userId,
        appVersion,
        reports: [
          {
            crashId: `crash-${input.userId}-1`,
            appVersion,
            signature: "ReaderCrashHandler.handleNullState",
            timestamp: "2026-05-30T10:00:03.000Z",
          },
        ],
      }),
      context,
    );
  }

  async queryConfig(
    input: QueryConfigInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    return this._runTool(
      "queryConfig",
      input,
      {
        kind: "config",
        appId: input.appId,
      },
      {},
      () => ({
        tool: "queryConfig",
        appId: input.appId,
        environment: input.environment,
        values: {
          apiBaseUrl: "https://mock.reader.example",
          cacheTtlSeconds: 300,
          diagnosticsEnabled: true,
        },
      }),
      context,
    );
  }

  async queryFeatureFlags(
    input: QueryFeatureFlagsInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    return this._runTool(
      "queryFeatureFlags",
      input,
      {
        kind: "feature_flags",
        userId: input.userId,
        appId: input.appId,
      },
      {},
      () => ({
        tool: "queryFeatureFlags",
        appId: input.appId,
        userId: input.userId,
        flags: {
          diagnosticsPanel: true,
          feedPrefetch: false,
          newReaderShell: true,
        },
      }),
      context,
    );
  }

  async searchKnowledgeBase(
    input: SearchKnowledgeBaseInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    const limit = _limit(input.limit);
    return this._runTool(
      "searchKnowledgeBase",
      input,
      { kind: "knowledge_base" },
      { limit },
      () => ({
        tool: "searchKnowledgeBase",
        query: input.query,
        limit,
        results: [
          {
            id: "kb-reader-crash-1",
            title: "Reader crash triage checklist",
            snippet: "Collect client logs, crash signature, and feature flags.",
          },
          {
            id: "kb-reader-crash-2",
            title: "Known reader crash signatures",
            snippet:
              "ReaderCrashHandler.handleNullState maps to empty feed payloads.",
          },
        ].slice(0, limit),
      }),
      context,
    );
  }

  async searchCode(
    input: SearchCodeInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    const limit = _limit(input.limit);
    return this._runTool(
      "searchCode",
      input,
      {
        kind: "code",
        repo: input.repo,
      },
      { limit },
      () => ({
        tool: "searchCode",
        repo: input.repo,
        query: input.query,
        limit,
        results: [
          {
            file: "src/reader/ReaderCrashHandler.ts",
            line: 42,
            snippet: "export class ReaderCrashHandler {",
          },
          {
            file: "tests/reader-crash-handler.test.ts",
            line: 17,
            snippet: 'describe("ReaderCrashHandler", () => {',
          },
        ].slice(0, limit),
      }),
      context,
    );
  }

  async createTicket(
    input: CreateTicketInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    return this._runTool(
      "createTicket",
      input,
      { kind: "ticket" },
      {},
      () => ({
        tool: "createTicket",
        ticket: {
          id: "mock-ticket-0001",
          title: input.title,
          severity: input.severity,
          status: "created",
          url: "https://mock.luna.example/tickets/mock-ticket-0001",
        },
      }),
      context,
      "write",
    );
  }

  async createPullRequest(
    input: CreatePullRequestInput,
    context?: McpToolCallContext,
  ): Promise<StableJson> {
    return this._runTool(
      "createPullRequest",
      input,
      {
        kind: "pull_request",
        repo: input.repo,
      },
      {},
      () => ({
        tool: "createPullRequest",
        pullRequest: {
          id: "mock-pr-0001",
          repo: input.repo,
          branch: input.branch,
          title: input.title,
          status: "created",
          url: "https://mock.luna.example/pulls/mock-pr-0001",
        },
      }),
      context,
      "write",
    );
  }

  private async _runTool<TResult extends StableJson>(
    tool: McpToolName,
    params: unknown,
    resource: PermissionResource,
    query: PermissionCheckInput["query"],
    produce: () => TResult,
    context?: McpToolCallContext,
    action: PermissionCheckInput["action"] = "read",
  ): Promise<TResult> {
    const callContext = this._resolveContext(context);
    this._appendTimeline(callContext, {
      type: "mcp.tool_requested",
      summary: `Requested MCP tool ${tool}.`,
      data: { tool, params },
    });

    if (callContext.actor === undefined) {
      const error = new Error("Missing MCP actor context.");
      const decision = {
        allowed: false,
        requiresApproval: false,
        reason: error.message,
      };
      this._appendTimeline(callContext, {
        type: "permission.checked",
        summary: `Permission blocked for MCP tool ${tool}.`,
        data: { tool, decision },
      });
      this._appendFailure(callContext, tool, error);
      throw error;
    }

    const decision = this._permissionEngine.check({
      actor: callContext.actor,
      tool,
      action,
      resource,
      ...(query !== undefined ? { query } : {}),
    });
    this._appendTimeline(callContext, {
      type: "permission.checked",
      summary: `Permission ${decision.allowed ? "allowed" : "blocked"} for MCP tool ${tool}.`,
      data: { tool, decision },
    });

    if (!decision.allowed) {
      const error = new Error(decision.reason);
      this._appendFailure(callContext, tool, error);
      throw error;
    }

    if (decision.requiresApproval && callContext.approvalGranted !== true) {
      const error = new Error(`Approval required: ${decision.reason}`);
      this._appendFailure(callContext, tool, error);
      throw error;
    }

    try {
      const result = produce();
      this._appendTimeline(callContext, {
        type: "mcp.tool_completed",
        summary: `Completed MCP tool ${tool}.`,
        data: { tool },
      });
      return result;
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      this._appendFailure(callContext, tool, normalizedError);
      throw normalizedError;
    }
  }

  private _resolveContext(context?: McpToolCallContext): RequiredContext {
    return {
      actor: context?.actor ?? this._actor,
      taskId: context?.taskId ?? this._taskId,
      sessionId: context?.sessionId ?? this._sessionId,
      messageId: context?.messageId,
      approvalGranted: context?.approvalGranted,
    };
  }

  private _appendFailure(
    context: RequiredContext,
    tool: McpToolName,
    error: Error,
  ): void {
    this._appendTimeline(context, {
      type: "mcp.tool_failed",
      summary: `Failed MCP tool ${tool}.`,
      data: { tool, error: error.message },
    });
  }

  private _appendTimeline(
    context: RequiredContext,
    event: {
      readonly type: string;
      readonly summary: string;
      readonly data: Record<string, unknown>;
    },
  ): void {
    if (this._timeline === undefined || context.taskId === undefined) {
      return;
    }

    this._timeline.append({
      taskId: context.taskId,
      ...(context.sessionId !== undefined
        ? { sessionId: context.sessionId }
        : {}),
      type: event.type,
      summary: event.summary,
      data: {
        ...(context.actor !== undefined ? { actor: context.actor } : {}),
        ...(context.messageId !== undefined
          ? { sourceMessageId: context.messageId }
          : {}),
        ...event.data,
      },
    });
  }
}

interface RequiredContext {
  readonly actor: McpActor | undefined;
  readonly taskId: string | undefined;
  readonly sessionId: string | undefined;
  readonly messageId: string | undefined;
  readonly approvalGranted: boolean | undefined;
}

function _limit(limit: number | undefined): number {
  if (limit === undefined) {
    return 10;
  }

  return Math.max(0, Math.floor(limit));
}
