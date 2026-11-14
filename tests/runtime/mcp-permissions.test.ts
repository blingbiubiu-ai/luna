import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import { tasks, timelineEvents } from "../../src/data/schema";
import * as lunaSchema from "../../src/data/schema";
import { MockMcpGateway } from "../../src/mcp/mock-mcp-gateway";
import { PermissionEngine } from "../../src/permissions/permission-engine";
import { setLunaHome } from "../../src/shared";
import { TimelineStore } from "../../src/timeline/timeline-store";

let testHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-mcp-permissions-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("mock MCP gateway and permissions", () => {
  test("mock gateway returns stable JSON for supported read tools", async () => {
    const gateway = new MockMcpGateway({
      actor: { userId: "support-1", role: "SUPPORT" },
    });

    const result = {
      userProfile: await gateway.queryUserProfile({
        userId: "user-123",
        view: "summary",
      }),
      clientLogs: await gateway.queryClientLogs({
        userId: "user-123",
        appId: "reader",
        limit: 2,
      }),
      serverLogs: await gateway.queryServerLogs({
        service: "reader-api",
        region: "iad",
        limit: 2,
      }),
      events: await gateway.queryEvents({
        userId: "user-123",
        eventName: "reader.open",
        limit: 2,
      }),
      crash: await gateway.queryCrashReports({
        userId: "user-123",
        appVersion: "1.2.3",
      }),
      config: await gateway.queryConfig({
        appId: "reader",
        environment: "prod",
      }),
      featureFlags: await gateway.queryFeatureFlags({
        appId: "reader",
        userId: "user-123",
      }),
      knowledgeBase: await gateway.searchKnowledgeBase({
        query: "reader crash",
        limit: 2,
      }),
      codeSearch: await gateway.searchCode({
        query: "ReaderCrashHandler",
        repo: "reader-service",
        limit: 2,
      }),
    };

    expect(result).toEqual({
      userProfile: {
        tool: "queryUserProfile",
        userId: "user-123",
        view: "summary",
        profile: {
          displayName: "Mock User user-123",
          locale: "en-US",
          region: "NA",
          tier: "standard",
        },
        redactions: ["email", "phone", "deviceIds"],
      },
      clientLogs: {
        tool: "queryClientLogs",
        appId: "reader",
        userId: "user-123",
        limit: 2,
        entries: [
          {
            timestamp: "2026-05-30T10:00:00.000Z",
            level: "info",
            message: "reader app launched",
            sessionId: "session-user-123-1",
          },
          {
            timestamp: "2026-05-30T10:00:05.000Z",
            level: "warn",
            message: "retrying feed request",
            sessionId: "session-user-123-1",
          },
        ],
      },
      serverLogs: {
        tool: "queryServerLogs",
        service: "reader-api",
        region: "iad",
        limit: 2,
        entries: [
          {
            timestamp: "2026-05-30T10:00:01.000Z",
            level: "info",
            message: "GET /feed 200",
            traceId: "trace-reader-api-iad-1",
          },
          {
            timestamp: "2026-05-30T10:00:06.000Z",
            level: "error",
            message: "upstream timeout",
            traceId: "trace-reader-api-iad-2",
          },
        ],
      },
      events: {
        tool: "queryEvents",
        userId: "user-123",
        eventName: "reader.open",
        limit: 2,
        events: [
          {
            timestamp: "2026-05-30T10:00:02.000Z",
            eventName: "reader.open",
            properties: { surface: "home", userId: "user-123" },
          },
          {
            timestamp: "2026-05-30T10:00:07.000Z",
            eventName: "reader.open",
            properties: { surface: "detail", userId: "user-123" },
          },
        ],
      },
      crash: {
        tool: "queryCrashReports",
        userId: "user-123",
        appVersion: "1.2.3",
        reports: [
          {
            crashId: "crash-user-123-1",
            appVersion: "1.2.3",
            signature: "ReaderCrashHandler.handleNullState",
            timestamp: "2026-05-30T10:00:03.000Z",
          },
        ],
      },
      config: {
        tool: "queryConfig",
        appId: "reader",
        environment: "prod",
        values: {
          apiBaseUrl: "https://mock.reader.example",
          cacheTtlSeconds: 300,
          diagnosticsEnabled: true,
        },
      },
      featureFlags: {
        tool: "queryFeatureFlags",
        appId: "reader",
        userId: "user-123",
        flags: {
          diagnosticsPanel: true,
          feedPrefetch: false,
          newReaderShell: true,
        },
      },
      knowledgeBase: {
        tool: "searchKnowledgeBase",
        query: "reader crash",
        limit: 2,
        results: [
          {
            id: "kb-reader-crash-1",
            title: "Reader crash triage checklist",
            snippet: "Collect client logs, crash signature, and feature flags.",
          },
          {
            id: "kb-reader-crash-2",
            title: "Known reader crash signatures",
            snippet: "ReaderCrashHandler.handleNullState maps to empty feed payloads.",
          },
        ],
      },
      codeSearch: {
        tool: "searchCode",
        repo: "reader-service",
        query: "ReaderCrashHandler",
        limit: 2,
        results: [
          {
            file: "src/reader/ReaderCrashHandler.ts",
            line: 42,
            snippet: "export class ReaderCrashHandler {",
          },
          {
            file: "tests/reader-crash-handler.test.ts",
            line: 17,
            snippet: "describe(\"ReaderCrashHandler\", () => {",
          },
        ],
      },
    });
  });

  test("permission engine allows USER own-summary reads", () => {
    const decision = new PermissionEngine().check({
      actor: { userId: "user-123", role: "USER" },
      tool: "queryUserProfile",
      action: "read",
      resource: {
        kind: "user_profile",
        userId: "user-123",
        view: "summary",
      },
    });

    expect(decision).toEqual({
      allowed: true,
      requiresApproval: false,
      reason: "USER can read their own summary profile.",
      redactions: ["email", "phone", "deviceIds"],
    });
  });

  test("permission engine marks large log queries approval-required", () => {
    const decision = new PermissionEngine().check({
      actor: { userId: "support-1", role: "SUPPORT" },
      tool: "queryClientLogs",
      action: "read",
      resource: { kind: "client_logs", userId: "user-123" },
      query: { limit: 5001 },
    });

    expect(decision).toEqual({
      allowed: true,
      requiresApproval: true,
      reason: "Log query exceeds the approval threshold.",
      redactions: ["accessToken", "cookie", "password"],
    });
  });

  test("permission engine blocks USER from server log reads", () => {
    const decision = new PermissionEngine().check({
      actor: { userId: "user-123", role: "USER" },
      tool: "queryServerLogs",
      action: "read",
      resource: { kind: "server_logs", service: "reader-api" },
      query: { limit: 50 },
    });

    expect(decision).toEqual({
      allowed: false,
      requiresApproval: false,
      reason: "USER cannot read server logs.",
      redactions: ["serverIp", "hostname", "accessToken", "cookie"],
    });
  });

  test("missing caller context cannot use write tools through implicit admin", async () => {
    const gateway = new MockMcpGateway();

    await expect(
      gateway.createPullRequest(
        {
          repo: "reader-service",
          branch: "fix/reader-crash",
          title: "Fix reader crash",
          body: "Mock PR body",
        },
        { approvalGranted: true },
      ),
    ).rejects.toThrow("Missing MCP actor context.");
  });

  test("approval cannot bypass base denial for large USER log reads", async () => {
    const engineDecision = new PermissionEngine().check({
      actor: { userId: "user-123", role: "USER" },
      tool: "queryClientLogs",
      action: "read",
      resource: {
        kind: "client_logs",
        userId: "user-456",
        appId: "reader",
      },
      query: { limit: 5001 },
    });
    const gateway = new MockMcpGateway({
      actor: { userId: "user-123", role: "USER" },
    });

    expect(engineDecision).toEqual({
      allowed: false,
      requiresApproval: false,
      reason: "USER cannot read another user's client logs.",
      redactions: ["accessToken", "cookie", "password"],
    });
    await expect(
      gateway.queryClientLogs(
        {
          userId: "user-456",
          appId: "reader",
          limit: 5001,
        },
        { approvalGranted: true },
      ),
    ).rejects.toThrow("USER cannot read another user's client logs.");
  });

  test("ticket and pull request writes require approval for otherwise allowed roles", async () => {
    const engine = new PermissionEngine();

    expect(
      engine.check({
        actor: { userId: "user-123", role: "USER" },
        tool: "createTicket",
        action: "write",
        resource: { kind: "ticket" },
      }),
    ).toEqual({
      allowed: true,
      requiresApproval: true,
      reason: "Write tool createTicket requires approval.",
    });
    expect(
      engine.check({
        actor: { userId: "support-1", role: "SUPPORT" },
        tool: "createTicket",
        action: "write",
        resource: { kind: "ticket" },
      }),
    ).toEqual({
      allowed: true,
      requiresApproval: true,
      reason: "Write tool createTicket requires approval.",
    });
    expect(
      engine.check({
        actor: { userId: "dev-1", role: "DEV" },
        tool: "createPullRequest",
        action: "write",
        resource: { kind: "pull_request", repo: "reader-service" },
      }),
    ).toEqual({
      allowed: true,
      requiresApproval: true,
      reason: "Write tool createPullRequest requires approval.",
    });
    expect(
      engine.check({
        actor: { userId: "admin-1", role: "ADMIN" },
        tool: "createPullRequest",
        action: "write",
        resource: { kind: "pull_request", repo: "reader-service" },
      }),
    ).toEqual({
      allowed: true,
      requiresApproval: true,
      reason: "Write tool createPullRequest requires approval.",
    });
    expect(
      engine.check({
        actor: { userId: "support-1", role: "SUPPORT" },
        tool: "createPullRequest",
        action: "write",
        resource: { kind: "pull_request", repo: "reader-service" },
      }),
    ).toEqual({
      allowed: false,
      requiresApproval: false,
      reason: "SUPPORT cannot use createPullRequest.",
    });

    const userGateway = new MockMcpGateway({
      actor: { userId: "user-123", role: "USER" },
    });
    const devGateway = new MockMcpGateway({
      actor: { userId: "dev-1", role: "DEV" },
    });

    await expect(
      userGateway.createTicket({
        title: "Reader issue",
        body: "Mock ticket body",
        severity: "medium",
      }),
    ).rejects.toThrow("Approval required: Write tool createTicket requires approval.");
    await expect(
      devGateway.createPullRequest({
        repo: "reader-service",
        branch: "fix/reader-crash",
        title: "Fix reader crash",
        body: "Mock PR body",
      }),
    ).rejects.toThrow(
      "Approval required: Write tool createPullRequest requires approval.",
    );
    await expect(
      devGateway.createPullRequest(
        {
          repo: "reader-service",
          branch: "fix/reader-crash",
          title: "Fix reader crash",
          body: "Mock PR body",
        },
        { approvalGranted: true },
      ),
    ).resolves.toMatchObject({
      tool: "createPullRequest",
      pullRequest: {
        id: "mock-pr-0001",
        repo: "reader-service",
        status: "created",
      },
    });
  });

  test("tool calls append MCP and permission timeline events for completion and failure", async () => {
    _createTask("task-mcp-timeline");
    const timeline = new TimelineStore(database.db);
    const gateway = new MockMcpGateway({
      timeline,
      taskId: "task-mcp-timeline",
      actor: { userId: "user-123", role: "USER" },
    });

    await gateway.queryUserProfile({ userId: "user-123", view: "summary" });
    await expect(
      gateway.queryServerLogs({
        service: "reader-api",
        region: "iad",
        limit: 2,
      }),
    ).rejects.toThrow("USER cannot read server logs.");

    const timelineRows = database.db
      .select()
      .from(timelineEvents)
      .orderBy(timelineEvents.created_at)
      .all();

    expect(timelineRows.map((row) => row.type)).toEqual([
      "mcp.tool_requested",
      "permission.checked",
      "mcp.tool_completed",
      "mcp.tool_requested",
      "permission.checked",
      "mcp.tool_failed",
    ]);
    expect(timelineRows.map((row) => row.summary)).toEqual([
      "Requested MCP tool queryUserProfile.",
      "Permission allowed for MCP tool queryUserProfile.",
      "Completed MCP tool queryUserProfile.",
      "Requested MCP tool queryServerLogs.",
      "Permission blocked for MCP tool queryServerLogs.",
      "Failed MCP tool queryServerLogs.",
    ]);
  });

  test("tool audit events are not deduped when multiple calls share one source message", async () => {
    _createTask("task-mcp-message-dedupe");
    const timeline = new TimelineStore(database.db);
    const gateway = new MockMcpGateway({
      timeline,
      taskId: "task-mcp-message-dedupe",
      actor: { userId: "support-1", role: "SUPPORT" },
    });
    const context = { messageId: "message-source-1" };

    await gateway.queryUserProfile(
      { userId: "user-123", view: "summary" },
      context,
    );
    await gateway.queryClientLogs(
      {
        userId: "user-123",
        appId: "reader",
        limit: 1,
      },
      context,
    );

    const timelineRows = database.db
      .select()
      .from(timelineEvents)
      .orderBy(timelineEvents.created_at)
      .all();

    expect(
      timelineRows.filter((row) => row.type === "mcp.tool_requested"),
    ).toHaveLength(2);
    expect(
      timelineRows.filter((row) => row.type === "permission.checked"),
    ).toHaveLength(2);
    expect(
      timelineRows.filter((row) => row.type === "mcp.tool_completed"),
    ).toHaveLength(2);
    expect(timelineRows.map((row) => row.summary)).toEqual([
      "Requested MCP tool queryUserProfile.",
      "Permission allowed for MCP tool queryUserProfile.",
      "Completed MCP tool queryUserProfile.",
      "Requested MCP tool queryClientLogs.",
      "Permission allowed for MCP tool queryClientLogs.",
      "Completed MCP tool queryClientLogs.",
    ]);
  });

});

function _createTask(taskId: string): void {
  const now = Date.now();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      type: "task",
      status: "new",
      priority: "medium",
      severity: null,
      title: taskId,
      summary: null,
      created_at: now,
      updated_at: now,
      last_activity_at: now, ...fixtureTaskOwnership(database.db)})
    .run();
}
