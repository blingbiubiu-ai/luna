import type {
  McpActor,
  McpToolName,
  PermissionDecision,
  LunaRole,
} from "@/mcp/types";
import { LUNA_ROLES } from "@/mcp/types";

export type { PermissionDecision, LunaRole };
export { LUNA_ROLES };

/**
 * Represents Permission Action values used by permission evaluation.
 */
export type PermissionAction = "read" | "write";

/**
 * Describes the Permission Resource contract used by permission evaluation.
 */
export interface PermissionResource {
  readonly kind:
    | "user_profile"
    | "client_logs"
    | "server_logs"
    | "events"
    | "crash_reports"
    | "config"
    | "feature_flags"
    | "knowledge_base"
    | "code"
    | "ticket"
    | "pull_request";
  readonly userId?: string;
  readonly view?: "summary" | "full";
  readonly service?: string;
  readonly appId?: string;
  readonly repo?: string;
}

/**
 * Describes the Permission Query contract used by permission evaluation.
 */
export interface PermissionQuery {
  readonly limit?: number;
  readonly bytes?: number;
  readonly timeRangeMinutes?: number;
}

/**
 * Input contract for evaluation permission check operations in permission.
 */
export interface PermissionCheckInput {
  readonly actor: McpActor;
  readonly tool: McpToolName;
  readonly action: PermissionAction;
  readonly resource: PermissionResource;
  readonly query?: PermissionQuery;
}

const LOG_APPROVAL_LIMIT = 5_000;
const LOG_APPROVAL_BYTES = 10 * 1024 * 1024;
const LOG_APPROVAL_TIME_RANGE_MINUTES = 24 * 60;

const LOG_REDACTIONS = ["accessToken", "cookie", "password"] as const;
const SERVER_LOG_REDACTIONS = [
  "serverIp",
  "hostname",
  "accessToken",
  "cookie",
] as const;
const PROFILE_SUMMARY_REDACTIONS = ["email", "phone", "deviceIds"] as const;

/**
 * Coordinates Permission Engine responsibilities in permission evaluation.
 */
export class PermissionEngine {
  check(input: PermissionCheckInput): PermissionDecision {
    const baseDecision = this._checkBaseAuthorization(input);
    if (!baseDecision.allowed) {
      return baseDecision;
    }

    if (this._isApprovalRequired(input)) {
      return {
        ...baseDecision,
        requiresApproval: true,
        reason: this._approvalReason(input),
        ...(baseDecision.redactions === undefined && this._isLargeLogQuery(input)
          ? { redactions: LOG_REDACTIONS }
          : {}),
      };
    }

    return baseDecision;
  }

  private _checkBaseAuthorization(
    input: PermissionCheckInput,
  ): PermissionDecision {
    if (!this._isKnownRole(input.actor.role)) {
      return this._deny(`Unknown role ${input.actor.role}.`);
    }

    if (input.actor.role === "ADMIN") {
      return this._allow("ADMIN can access all mock MCP tools.");
    }

    if (this._isBlockedUserServerLogRead(input)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "USER cannot read server logs.",
        redactions: SERVER_LOG_REDACTIONS,
      };
    }

    if (this._isUserOwnSummaryRead(input)) {
      return {
        allowed: true,
        requiresApproval: false,
        reason: "USER can read their own summary profile.",
        redactions: PROFILE_SUMMARY_REDACTIONS,
      };
    }

    if (input.actor.role === "USER") {
      return this._checkUser(input);
    }

    if (input.actor.role === "SUPPORT") {
      return this._checkSupport(input);
    }

    if (input.actor.role === "OPS") {
      return this._checkOps(input);
    }

    return this._checkDev(input);
  }

  private _checkUser(input: PermissionCheckInput): PermissionDecision {
    if (
      input.tool === "queryClientLogs" &&
      input.resource.userId === input.actor.userId
    ) {
      return this._allow("USER can read their own client logs.", LOG_REDACTIONS);
    }

    if (
      input.tool === "queryClientLogs" &&
      input.resource.userId !== input.actor.userId
    ) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "USER cannot read another user's client logs.",
        redactions: LOG_REDACTIONS,
      };
    }

    if (
      input.tool === "queryEvents" &&
      input.resource.userId === input.actor.userId
    ) {
      return this._allow("USER can read their own events.");
    }

    if (
      input.tool === "searchKnowledgeBase" ||
      input.tool === "createTicket"
    ) {
      return this._allow("USER can use self-service support tools.");
    }

    return this._deny(`USER cannot use ${input.tool}.`);
  }

  private _checkSupport(input: PermissionCheckInput): PermissionDecision {
    if (input.tool === "createPullRequest") {
      return this._deny(`SUPPORT cannot use ${input.tool}.`);
    }

    return this._allow("SUPPORT can access support diagnostics tools.");
  }

  private _checkOps(input: PermissionCheckInput): PermissionDecision {
    if (input.tool === "createPullRequest") {
      return this._deny("OPS cannot create pull requests.");
    }

    return this._allow("OPS can access operational diagnostics tools.");
  }

  private _checkDev(input: PermissionCheckInput): PermissionDecision {
    if (
      input.tool === "queryUserProfile" ||
      input.tool === "queryClientLogs" ||
      input.tool === "queryEvents"
    ) {
      return this._deny(`DEV cannot use ${input.tool}.`);
    }

    return this._allow("DEV can access code and engineering diagnostics tools.");
  }

  private _isKnownRole(role: LunaRole): boolean {
    return (LUNA_ROLES as readonly string[]).includes(role);
  }

  private _isBlockedUserServerLogRead(input: PermissionCheckInput): boolean {
    return input.actor.role === "USER" && input.tool === "queryServerLogs";
  }

  private _isUserOwnSummaryRead(input: PermissionCheckInput): boolean {
    return (
      input.actor.role === "USER" &&
      input.tool === "queryUserProfile" &&
      input.resource.userId === input.actor.userId &&
      input.resource.view === "summary"
    );
  }

  private _isLargeLogQuery(input: PermissionCheckInput): boolean {
    if (!["queryClientLogs", "queryServerLogs"].includes(input.tool)) {
      return false;
    }

    const query = input.query;
    return (
      (query?.limit ?? 0) > LOG_APPROVAL_LIMIT ||
      (query?.bytes ?? 0) > LOG_APPROVAL_BYTES ||
      (query?.timeRangeMinutes ?? 0) > LOG_APPROVAL_TIME_RANGE_MINUTES
    );
  }

  private _isApprovalRequired(input: PermissionCheckInput): boolean {
    return this._isLargeLogQuery(input) || this._isSensitiveWrite(input);
  }

  private _isSensitiveWrite(input: PermissionCheckInput): boolean {
    return (
      input.action === "write" &&
      (input.tool === "createTicket" || input.tool === "createPullRequest")
    );
  }

  private _approvalReason(input: PermissionCheckInput): string {
    if (this._isSensitiveWrite(input)) {
      return `Write tool ${input.tool} requires approval.`;
    }

    return "Log query exceeds the approval threshold.";
  }

  private _allow(
    reason: string,
    redactions?: readonly string[],
  ): PermissionDecision {
    return {
      allowed: true,
      requiresApproval: false,
      reason,
      ...(redactions !== undefined ? { redactions } : {}),
    };
  }

  private _deny(reason: string): PermissionDecision {
    return {
      allowed: false,
      requiresApproval: false,
      reason,
    };
  }
}
