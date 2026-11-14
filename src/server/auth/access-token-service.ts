import {resolveInvocationScope} from "@/runners/invocation-scope";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { and, eq, inArray, isNull, lt } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  accessTokens,
  channelAuthTokens,
  cliAuthSessions,
  users,
} from "@/data/schema";
import { uuid } from "@/shared";

export type LunaAccessTokenSource = "cli" | "mcp" | "runner";
export type LunaAccessTokenRole = "user" | "runner";

export interface LunaAccessTokenClaims {
  readonly agentId?:string;
  readonly shadowId?:string;
  readonly tokenId: string;
  readonly actorUserId: string;
  readonly source: LunaAccessTokenSource;
  readonly role: LunaAccessTokenRole;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly runnerKind?: "main" | "work" | "task";
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly taskRunId?: string;
  readonly runnerJobId?: string;
}

export interface IssueLunaAccessTokenInput {
  readonly userId: string;
  readonly name: string;
  readonly source: LunaAccessTokenSource;
  readonly role: LunaAccessTokenRole;
  readonly ttlMs: number;
  readonly now: number;
  readonly runnerKind?: "main" | "work" | "task";
  readonly sourceRunnerJobId?: string;
  readonly sourceSessionId?: string;
  readonly sourceTurnId?: string;
  readonly sourceTaskId?: string;
  readonly sourceTaskRunId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AccessTokenServiceInput {
  readonly db: DrizzleDB;
  readonly signingSecret: string;
}

export interface StartCliAuthSessionInput {
  readonly now: number;
  readonly ttlMs?: number;
}

export interface IssueChannelAuthTokenInput {
  readonly userId: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly channelIdentityId?: string;
  readonly purpose: "cli_login";
  readonly ttlMs: number;
  readonly now: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ConfirmCliAuthSessionWithChannelTokenInput {
  readonly userCode: string;
  readonly token: string;
  readonly now: number;
}

export type CliAuthSessionPollResult =
  | { readonly status: "authorization_pending" }
  | { readonly status: "authorization_denied" }
  | { readonly status: "authorization_expired" }
  | { readonly status: "consumed" }
  | {
    readonly status: "approved";
    readonly accessToken: string;
    readonly expiresAt: number;
    readonly user: { readonly id: string; readonly displayName: string };
  };

const CLI_ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CLI_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const CLI_AUTH_POLL_INTERVAL_SECONDS = 2;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type AccessTokenRow = typeof accessTokens.$inferSelect;
type ChannelAuthTokenRow = typeof channelAuthTokens.$inferSelect;
type UserRow = typeof users.$inferSelect;
type AccessTokenDb = Pick<DrizzleDB, "insert" | "select" | "update">;

export class AccessTokenService {
  constructor(private readonly _input: AccessTokenServiceInput) {}

  issueToken(input: IssueLunaAccessTokenInput): {
    readonly token: string;
    readonly record: AccessTokenRow;
    readonly claims: LunaAccessTokenClaims;
  } {
    if (input.ttlMs <= 0) {
      throw new Error("invalid_access_token");
    }
    return this._issueTokenWithDb(this._input.db, input);
  }

  private _issueTokenWithDb(
    db: AccessTokenDb,
    input: IssueLunaAccessTokenInput,
  ): {
    readonly token: string;
    readonly record: AccessTokenRow;
    readonly claims: LunaAccessTokenClaims;
  } {
    if (input.ttlMs <= 0) {
      throw new Error("invalid_access_token");
    }
    const user = this._requireActiveUser(db, input.userId);
    const tokenId = uuid();
    const issuedAt = input.now;
    const expiresAt = input.now + input.ttlMs;
    if (input.source === "runner" && (!input.runnerKind || input.role !== "runner")) throw new Error("runner_scope_required");
    const scope=input.source==="runner"?resolveInvocationScope(this._input.db,{
      actorUserId:input.userId,runnerKind:input.runnerKind!,runnerContextId:input.sourceRunnerJobId??"",
      sessionId:input.sourceSessionId??null,taskId:input.sourceTaskId??null,taskRunId:input.sourceTaskRunId??null,contextPackIds:[],
    }):undefined;
    const claims = normalizeLunaAccessTokenClaims({
      ...scope,
      tokenId,
      actorUserId: user.id,
      source: input.source,
      role: input.role,
      issuedAt,
      expiresAt,
      ...(input.runnerKind === undefined
        ? {}
        : { runnerKind: input.runnerKind }),
      ...(input.sourceSessionId === undefined
        ? {}
        : { sessionId: input.sourceSessionId }),
      ...(input.sourceTurnId === undefined
        ? {}
        : { turnId: input.sourceTurnId }),
      ...(input.sourceTaskId === undefined ? {} : { taskId: input.sourceTaskId }),
      ...(input.sourceTaskRunId === undefined
        ? {}
        : { taskRunId: input.sourceTaskRunId }),
      ...(input.sourceRunnerJobId === undefined
        ? {}
        : { runnerJobId: input.sourceRunnerJobId }),
    });
    const token = signLunaAccessToken(claims, this._input.signingSecret);
    const tokenHash = hashAccessToken(token);
    db
      .insert(accessTokens)
      .values({
        id: tokenId,
        tokenHash,
        agentId:scope?.agentId??null,shadowId:scope?.shadowId??null,
        userId: user.id,
        source: input.source,
        name: input.name,
        role: input.role,
        sourceRunnerJobId: input.sourceRunnerJobId ?? null,
        sourceSessionId: input.sourceSessionId ?? null,
        sourceTurnId: input.sourceTurnId ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        sourceTaskRunId: input.sourceTaskRunId ?? null,
        issuedAt,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: input.now,
        metadataJson: input.metadata ?? null,
      })
      .run();
    const record = this._getTokenRecord(db, tokenId);
    return {
      token,
      record,
      claims,
    };
  }

  verifyBearer(token: string, options: { readonly now: number }): {
    readonly user: { readonly id: string; readonly displayName: string };
    readonly claims: LunaAccessTokenClaims;
  } {
    const signedClaims = verifyLunaAccessToken(token, {
      secret: this._input.signingSecret,
      now: options.now,
    });
    const record = this._input.db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.tokenHash, hashAccessToken(token)))
      .get();
    if (record === undefined || !recordMatchesClaims(record, signedClaims)) {
      throw new Error("invalid_access_token");
    }
    if (options.now >= record.expiresAt) {
      throw new Error("expired_access_token");
    }
    if (record.revokedAt !== null) {
      throw new Error("revoked_access_token");
    }
    const user = this._activeUser(this._input.db, record.userId);
    if (user === undefined) {
      throw new Error("invalid_access_token");
    }
    this._input.db
      .update(accessTokens)
      .set({ lastUsedAt: options.now })
      .where(eq(accessTokens.id, record.id))
      .run();
    return {
      user: { id: user.id, displayName: user.displayName },
      claims: signedClaims,
    };
  }

  revokeToken(tokenId: string, userId: string, now: number): void {
    this._input.db
      .update(accessTokens)
      .set({ revokedAt: now })
      .where(and(eq(accessTokens.id, tokenId), eq(accessTokens.userId, userId)))
      .run();
  }

  cleanupExpiredRunnerTokens(input: {
    readonly now: number;
    readonly retentionMs: number;
  }): number {
    const cutoff = input.now - input.retentionMs;
    const rows = this._input.db
      .select({ id: accessTokens.id })
      .from(accessTokens)
      .where(
        and(
          eq(accessTokens.source, "runner"),
          lt(accessTokens.expiresAt, cutoff),
        ),
      )
      .all();
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return 0;
    }
    this._input.db
      .delete(accessTokens)
      .where(inArray(accessTokens.id, ids))
      .run();
    return ids.length;
  }

  issueChannelAuthToken(input: IssueChannelAuthTokenInput): {
    readonly token: string;
    readonly record: ChannelAuthTokenRow;
  } {
    if (input.ttlMs <= 0) {
      throw new Error("invalid_channel_auth_token");
    }
    const user = this._requireActiveUser(this._input.db, input.userId);
    const token = randomOpaqueCode();
    const tokenId = uuid();
    this._input.db
      .insert(channelAuthTokens)
      .values({
        id: tokenId,
        tokenHash: hashAccessToken(token),
        userId: user.id,
        channelType: input.channelType,
        channelId: input.channelId,
        channelIdentityId: input.channelIdentityId ?? null,
        purpose: input.purpose,
        issuedAt: input.now,
        expiresAt: input.now + input.ttlMs,
        consumedAt: null,
        createdAt: input.now,
        metadataJson: input.metadata ?? null,
      })
      .run();
    const record = this._input.db
      .select()
      .from(channelAuthTokens)
      .where(eq(channelAuthTokens.id, tokenId))
      .get();
    if (record === undefined) {
      throw new Error(`Channel auth token was not persisted: ${tokenId}`);
    }
    return { token, record };
  }

  startCliAuthSession(input: StartCliAuthSessionInput): {
    readonly deviceCode: string;
    readonly userCode: string;
    readonly expiresAt: number;
    readonly intervalSeconds: number;
  } {
    const ttlMs = input.ttlMs ?? DEFAULT_CLI_AUTH_SESSION_TTL_MS;
    const deviceCode = randomOpaqueCode();
    const userCode = randomUserCode();
    const expiresAt = input.now + ttlMs;
    this._input.db
      .insert(cliAuthSessions)
      .values({
        id: uuid(),
        deviceCodeHash: hashAccessToken(deviceCode),
        userCodeHash: hashAccessToken(userCode),
        status: "pending",
        approvedByUserId: null,
        createdAt: input.now,
        expiresAt,
        approvedAt: null,
        consumedAt: null,
        metadataJson: null,
      })
      .run();
    return {
      deviceCode,
      userCode,
      expiresAt,
      intervalSeconds: CLI_AUTH_POLL_INTERVAL_SECONDS,
    };
  }

  approveCliAuthSession(userCode: string, userId: string, now: number): void {
    this._requireActiveUser(this._input.db, userId);
    const session = this._input.db
      .select()
      .from(cliAuthSessions)
      .where(eq(cliAuthSessions.userCodeHash, hashAccessToken(userCode)))
      .get();
    if (session === undefined || now >= session.expiresAt) {
      if (session !== undefined) {
        this._expireCliAuthSession(session.id);
      }
      throw new Error("authorization_expired");
    }
    if (session.status !== "pending") {
      return;
    }
    this._input.db
      .update(cliAuthSessions)
      .set({
        status: "approved",
        approvedByUserId: userId,
        approvedAt: now,
      })
      .where(eq(cliAuthSessions.id, session.id))
      .run();
  }

  confirmCliAuthSessionWithChannelToken(
    input: ConfirmCliAuthSessionWithChannelTokenInput,
  ): void {
    this._input.db.transaction((tx) => {
      const session = tx
        .select()
        .from(cliAuthSessions)
        .where(eq(cliAuthSessions.userCodeHash, hashAccessToken(input.userCode)))
        .get();
      if (session === undefined || input.now >= session.expiresAt) {
        if (session !== undefined) {
          tx
            .update(cliAuthSessions)
            .set({ status: "expired" })
            .where(eq(cliAuthSessions.id, session.id))
            .run();
        }
        throw new Error("authorization_expired");
      }
      const proof = tx
        .select()
        .from(channelAuthTokens)
        .where(eq(channelAuthTokens.tokenHash, hashAccessToken(input.token)))
        .get();
      if (
        proof === undefined ||
        proof.consumedAt !== null ||
        proof.purpose !== "cli_login"
      ) {
        throw new Error("invalid_channel_auth_token");
      }
      if (input.now >= proof.expiresAt) {
        throw new Error("expired_channel_auth_token");
      }
      const user = this._requireActiveUser(tx, proof.userId);
      if (session.status !== "pending") {
        return;
      }
      const consumed = tx
        .update(channelAuthTokens)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(channelAuthTokens.id, proof.id),
            isNull(channelAuthTokens.consumedAt),
          ),
        )
        .returning({ id: channelAuthTokens.id })
        .get();
      if (consumed === undefined) {
        throw new Error("invalid_channel_auth_token");
      }
      tx
        .update(cliAuthSessions)
        .set({
          status: "approved",
          approvedByUserId: user.id,
          approvedAt: input.now,
        })
        .where(
          and(
            eq(cliAuthSessions.id, session.id),
            eq(cliAuthSessions.status, "pending"),
          ),
        )
        .run();
    });
  }

  denyCliAuthSession(userCode: string, now: number): void {
    const session = this._input.db
      .select()
      .from(cliAuthSessions)
      .where(eq(cliAuthSessions.userCodeHash, hashAccessToken(userCode)))
      .get();
    if (session === undefined || now >= session.expiresAt) {
      if (session !== undefined) {
        this._expireCliAuthSession(session.id);
      }
      throw new Error("authorization_expired");
    }
    if (session.status !== "pending") {
      return;
    }
    this._input.db
      .update(cliAuthSessions)
      .set({
        status: "denied",
        consumedAt: now,
      })
      .where(eq(cliAuthSessions.id, session.id))
      .run();
  }

  pollCliAuthSession(
    deviceCode: string,
    options: { readonly now: number },
  ): CliAuthSessionPollResult {
    const session = this._input.db
      .select()
      .from(cliAuthSessions)
      .where(eq(cliAuthSessions.deviceCodeHash, hashAccessToken(deviceCode)))
      .get();
    if (session === undefined) {
      return { status: "authorization_expired" };
    }
    if (options.now >= session.expiresAt) {
      this._expireCliAuthSession(session.id);
      return { status: "authorization_expired" };
    }
    if (session.status === "pending") {
      return { status: "authorization_pending" };
    }
    if (session.status === "denied") {
      return { status: "authorization_denied" };
    }
    if (session.status === "consumed") {
      return { status: "consumed" };
    }
    if (session.status !== "approved" || session.approvedByUserId === null) {
      return { status: "authorization_expired" };
    }
    return this._input.db.transaction((tx) => {
      const freshSession = tx
        .select()
        .from(cliAuthSessions)
        .where(eq(cliAuthSessions.id, session.id))
        .get();
      if (freshSession === undefined || freshSession.status === "consumed") {
        return { status: "consumed" };
      }
      if (
        freshSession.status !== "approved" ||
        freshSession.approvedByUserId === null
      ) {
        return { status: "authorization_expired" };
      }
      const user = this._requireActiveUser(tx, freshSession.approvedByUserId);
      const consumed = tx
        .update(cliAuthSessions)
        .set({ status: "consumed", consumedAt: options.now })
        .where(
          and(
            eq(cliAuthSessions.id, freshSession.id),
            eq(cliAuthSessions.status, "approved"),
          ),
        )
        .returning({ id: cliAuthSessions.id })
        .get();
      if (consumed === undefined) {
        return { status: "consumed" };
      }
      const issued = this._issueTokenWithDb(tx, {
        userId: user.id,
        name: "Luna CLI",
        source: "cli",
        role: "user",
        ttlMs: CLI_ACCESS_TOKEN_TTL_MS,
        now: options.now,
        metadata: { cliAuthSessionId: freshSession.id },
      });
      return {
        status: "approved",
        accessToken: issued.token,
        expiresAt: issued.record.expiresAt,
        user: { id: user.id, displayName: user.displayName },
      };
    });
  }

  private _getTokenRecord(db: AccessTokenDb, tokenId: string): AccessTokenRow {
    const record = db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.id, tokenId))
      .get();
    if (record === undefined) {
      throw new Error(`Access token was not persisted: ${tokenId}`);
    }
    return record;
  }

  private _activeUser(db: AccessTokenDb, userId: string): UserRow | undefined {
    const user = db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();
    return user === undefined || user.status !== "active" ? undefined : user;
  }

  private _requireActiveUser(db: AccessTokenDb, userId: string): UserRow {
    const user = this._activeUser(db, userId);
    if (user === undefined) {
      throw new Error("invalid_access_token");
    }
    return user;
  }

  private _expireCliAuthSession(sessionId: string): void {
    this._input.db
      .update(cliAuthSessions)
      .set({ status: "expired" })
      .where(eq(cliAuthSessions.id, sessionId))
      .run();
  }
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomOpaqueCode(): string {
  return randomBytes(32).toString("base64url");
}

function randomUserCode(): string {
  const chars = Array.from({ length: 8 }, () =>
    USER_CODE_ALPHABET[
      randomBytes(1).readUInt8(0) % USER_CODE_ALPHABET.length
    ]
  );
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function signLunaAccessToken(
  claims: LunaAccessTokenClaims,
  secret: string,
): string {
  const payload = JSON.stringify(claims);
  const encodedPayload = Buffer.from(payload).toString("base64url");
  const signature = signEncodedPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function verifyLunaAccessToken(
  token: string,
  options: { readonly secret: string; readonly now: number },
): LunaAccessTokenClaims {
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    !isCanonicalBase64Url(parts[0]) ||
    !isCanonicalBase64Url(parts[1])
  ) {
    throw new Error("invalid_access_token");
  }
  const [encodedPayload, signature] = parts as [string, string];
  const expectedSignature = signEncodedPayload(encodedPayload, options.secret);
  if (!timingSafeEqualString(signature, expectedSignature)) {
    throw new Error("invalid_access_token");
  }

  const payload = decodePayload(encodedPayload);
  if (Buffer.from(payload).toString("base64url") !== encodedPayload) {
    throw new Error("invalid_access_token");
  }
  const claims = parseLunaAccessTokenClaims(payload);
  if (options.now >= claims.expiresAt) {
    throw new Error("expired_access_token");
  }
  return claims;
}

function signEncodedPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function decodePayload(encodedPayload: string): string {
  try {
    return Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    throw new Error("invalid_access_token");
  }
}

function parseLunaAccessTokenClaims(payload: string): LunaAccessTokenClaims {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("invalid_access_token");
  }
  if (!isRecord(parsed)) {
    throw new Error("invalid_access_token");
  }
  return normalizeLunaAccessTokenClaims({
    tokenId: requiredString(parsed.tokenId),
    actorUserId: requiredString(parsed.actorUserId),
    source: requiredSource(parsed.source),
    role: requiredRole(parsed.role),
    issuedAt: requiredNumber(parsed.issuedAt),
    expiresAt: requiredNumber(parsed.expiresAt),
    ...optionalStringClaim("agentId",parsed.agentId),
    ...optionalStringClaim("shadowId",parsed.shadowId),
    ...optionalRunnerKind(parsed.runnerKind),
    ...optionalStringClaim("sessionId", parsed.sessionId),
    ...optionalStringClaim("turnId", parsed.turnId),
    ...optionalStringClaim("taskId", parsed.taskId),
    ...optionalStringClaim("taskRunId", parsed.taskRunId),
    ...optionalStringClaim("runnerJobId", parsed.runnerJobId),
  });
}

function normalizeLunaAccessTokenClaims(
  input: LunaAccessTokenClaims,
): LunaAccessTokenClaims {
  const claims: LunaAccessTokenClaims = {
    tokenId: requiredString(input.tokenId),
    actorUserId: requiredString(input.actorUserId),
    source: requiredSource(input.source),
    role: requiredRole(input.role),
    issuedAt: requiredNumber(input.issuedAt),
    expiresAt: requiredNumber(input.expiresAt),
    ...optionalStringClaim("agentId",input.agentId),
    ...optionalStringClaim("shadowId",input.shadowId),
    ...optionalRunnerKind(input.runnerKind),
    ...optionalStringClaim("sessionId", input.sessionId),
    ...optionalStringClaim("turnId", input.turnId),
    ...optionalStringClaim("taskId", input.taskId),
    ...optionalStringClaim("taskRunId", input.taskRunId),
    ...optionalStringClaim("runnerJobId", input.runnerJobId),
  };
  if (claims.source === "runner" && (!claims.agentId || !claims.shadowId || !claims.runnerKind || claims.role !== "runner")) {
    throw new Error("runner_scope_required");
  }
  if (claims.expiresAt <= claims.issuedAt) {
    throw new Error("invalid_access_token");
  }
  return claims;
}

function recordMatchesClaims(
  record: AccessTokenRow,
  claims: LunaAccessTokenClaims,
): boolean {
  return (
    optionalRecordString(record.agentId)===claims.agentId && optionalRecordString(record.shadowId)===claims.shadowId &&
    record.id === claims.tokenId &&
    record.userId === claims.actorUserId &&
    record.source === claims.source &&
    record.role === claims.role &&
    record.issuedAt === claims.issuedAt &&
    record.expiresAt === claims.expiresAt &&
    optionalRecordString(record.sourceSessionId) === claims.sessionId &&
    optionalRecordString(record.sourceTurnId) === claims.turnId &&
    optionalRecordString(record.sourceTaskId) === claims.taskId &&
    optionalRecordString(record.sourceTaskRunId) === claims.taskRunId &&
    optionalRecordString(record.sourceRunnerJobId) === claims.runnerJobId
  );
}

function optionalRecordString(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function optionalStringClaim<
  TKey extends "agentId" | "shadowId" | "sessionId" | "turnId" | "taskId" | "taskRunId" | "runnerJobId",
>(key: TKey, value: unknown): Partial<Pick<LunaAccessTokenClaims, TKey>> {
  if (value === undefined) {
    return {};
  }
  return { [key]: requiredString(value) } as Partial<
    Pick<LunaAccessTokenClaims, TKey>
  >;
}

function optionalRunnerKind(
  value: unknown,
): Pick<LunaAccessTokenClaims, "runnerKind"> | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  if (value !== "main" && value !== "work" && value !== "task") {
    throw new Error("invalid_access_token");
  }
  return { runnerKind: value };
}

function requiredSource(value: unknown): LunaAccessTokenSource {
  if (value !== "cli" && value !== "mcp" && value !== "runner") {
    throw new Error("invalid_access_token");
  }
  return value;
}

function requiredRole(value: unknown): LunaAccessTokenRole {
  if (value !== "user" && value !== "runner") {
    throw new Error("invalid_access_token");
  }
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid_access_token");
  }
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("invalid_access_token");
  }
  return value;
}

function isCanonicalBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
