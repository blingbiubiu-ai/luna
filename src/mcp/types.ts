/**
 * Defines the supported Luna roles exposed through the MCP gateway.
 */
export const LUNA_ROLES = [
  "USER",
  "SUPPORT",
  "OPS",
  "DEV",
  "ADMIN",
] as const;

/**
 * Represents Luna Role values used by MCP gateway integration.
 */
export type LunaRole = (typeof LUNA_ROLES)[number];

/**
 * Describes the MCP Actor contract used by MCP gateway integration.
 */
export interface McpActor {
  readonly userId: string;
  readonly role: LunaRole;
}

/**
 * Represents MCP Tool Name values used by MCP gateway integration.
 */
export type McpToolName =
  | "queryUserProfile"
  | "queryClientLogs"
  | "queryServerLogs"
  | "queryEvents"
  | "queryCrashReports"
  | "queryConfig"
  | "queryFeatureFlags"
  | "searchKnowledgeBase"
  | "searchCode"
  | "createTicket"
  | "createPullRequest";

/**
 * Describes the MCP Tool Call Context contract used by MCP gateway integration.
 */
export interface McpToolCallContext {
  readonly actor?: McpActor;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly messageId?: string;
  readonly approvalGranted?: boolean;
}

/**
 * Describes the Permission Decision contract used by MCP gateway integration.
 */
export interface PermissionDecision {
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reason: string;
  readonly redactions?: readonly string[];
}

/**
 * Input contract for gateway integration query user profile operations in MCP.
 */
export interface QueryUserProfileInput {
  readonly userId: string;
  readonly view: "summary" | "full";
}

/**
 * Input contract for gateway integration query client logs operations in MCP.
 */
export interface QueryClientLogsInput {
  readonly userId: string;
  readonly appId: string;
  readonly limit?: number;
  readonly severity?: "debug" | "info" | "warn" | "error";
}

/**
 * Input contract for gateway integration query server logs operations in MCP.
 */
export interface QueryServerLogsInput {
  readonly service: string;
  readonly region: string;
  readonly limit?: number;
  readonly severity?: "debug" | "info" | "warn" | "error";
}

/**
 * Input contract for gateway integration query events operations in MCP.
 */
export interface QueryEventsInput {
  readonly userId: string;
  readonly eventName: string;
  readonly limit?: number;
}

/**
 * Input contract for gateway integration query crash reports operations in MCP.
 */
export interface QueryCrashReportsInput {
  readonly userId: string;
  readonly appVersion?: string;
}

/**
 * Input contract for gateway integration query config operations in MCP.
 */
export interface QueryConfigInput {
  readonly appId: string;
  readonly environment: "dev" | "staging" | "prod";
}

/**
 * Input contract for gateway integration query feature flags operations in MCP.
 */
export interface QueryFeatureFlagsInput {
  readonly appId: string;
  readonly userId: string;
}

/**
 * Input contract for gateway integration search knowledge base operations in MCP.
 */
export interface SearchKnowledgeBaseInput {
  readonly query: string;
  readonly limit?: number;
}

/**
 * Input contract for gateway integration search code operations in MCP.
 */
export interface SearchCodeInput {
  readonly query: string;
  readonly repo: string;
  readonly limit?: number;
}

/**
 * Input contract for gateway integration create ticket operations in MCP.
 */
export interface CreateTicketInput {
  readonly title: string;
  readonly body: string;
  readonly severity: "low" | "medium" | "high" | "critical";
}

/**
 * Input contract for gateway integration create pull request operations in MCP.
 */
export interface CreatePullRequestInput {
  readonly repo: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Represents Stable JSON values used by MCP gateway integration.
 */
export type StableJson = Record<string, unknown>;
