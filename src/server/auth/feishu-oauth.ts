import { eq } from "drizzle-orm";
import { z } from "zod";

import type { AgentSecretCipher } from "@/agent-config/secret-cipher";
import { channelSecretCipher } from "@/channels/config-store";
import type { DrizzleDB } from "@/data";
import { platformAuthSettings } from "@/data/schema";
import type { AccountIdentityClaimInput } from "@/identity/account-store";
import { cleanDisplayName } from "@/identity/display-name";
import { feishuEnvironmentFromHost, feishuIdentityMetadata } from "@/identity/feishu-identity-scopes";
import { resolvePublicBaseUrl } from "@/platform/platform-settings-store";
import { createLogger } from "@/shared";
import type { DashboardAccount } from "../auth";

export const DEFAULT_FEISHU_HOST = "https://open.feishu.cn";
export const FEISHU_OAUTH_PROVIDER = "feishu";
export const FEISHU_OAUTH_STATE_COOKIE = "luna_feishu_oauth_state";
export const FEISHU_OAUTH_STATE_TTL_SECONDS = 600;
export const FEISHU_CALLBACK_PATH = "/api/auth/feishu/callback";

const SECRET_BINDING = {
  profileId: "platform-auth:feishu",
  revisionId: "feishu-login-v1",
  key: "app_secret",
} as const;

const FEISHU_TIMEOUT_MS = 10_000;
const logger = createLogger("feishu-oauth");

export type FeishuFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FeishuAppCredentials {
  readonly appId: string;
  readonly appSecret: string;
  readonly feishuHost: string;
  readonly publicBaseUrl: string;
}

export interface FeishuAuthPublicSettings {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly source: "database" | "environment" | "none";
  readonly appId: string;
  readonly hasSecret: boolean;
  readonly secretUnreadable: boolean;
  readonly feishuHost: string;
  readonly publicBaseUrl: string;
}

export type FeishuCredentialVerifier = (input: {
  readonly appId: string;
  readonly appSecret: string;
  readonly feishuHost: string;
}) => Promise<void>;

export class FeishuAuthConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "FeishuAuthConfigError";
  }
}

export const feishuAuthSettingsInput = z.object({
  enabled: z.boolean().default(true),
  appId: z.string().trim().min(1, "请输入飞书应用 App ID。").max(150),
  appSecret: z.string().max(1000).optional(),
  feishuHost: z.string().trim().default(DEFAULT_FEISHU_HOST),
  publicBaseUrl: z.string().trim().default(""),
}).strict();

type EnvMap = Readonly<Record<string, string | undefined>>;

/**
 * Resolves and persists platform-wide Feishu Dashboard OAuth configuration.
 * Database settings managed in Dashboard Platform Settings take precedence over
 * environment variables (`LUNA_FEISHU_APP_ID` / `FEISHU_APP_ID`, etc.).
 */
export class FeishuAuthConfigStore {
  private readonly db: DrizzleDB | undefined;
  private readonly env: EnvMap;
  private readonly cipherFactory: () => AgentSecretCipher;
  private readonly verify: FeishuCredentialVerifier;

  constructor(options: {
    readonly db?: DrizzleDB;
    readonly env?: EnvMap;
    readonly cipher?: AgentSecretCipher;
    readonly verify?: FeishuCredentialVerifier;
  } = {}) {
    this.db = options.db;
    this.env = options.env ?? process.env;
    this.cipherFactory = options.cipher ? () => options.cipher! : channelSecretCipher;
    this.verify = options.verify ?? (async (creds) => {
      await fetchFeishuAppAccessToken(creds);
    });
  }

  getPublicSettings(): FeishuAuthPublicSettings {
    const row = this.readDbRow();
    if (row !== undefined) {
      const decrypted = this.tryDecrypt(row);
      const secretUnreadable = decrypted === undefined;
      const configured = !secretUnreadable && row.appId.trim().length > 0;
      return {
        enabled: row.enabled && configured,
        configured,
        source: "database",
        appId: row.appId,
        hasSecret: !secretUnreadable,
        secretUnreadable,
        feishuHost: row.feishuHost || DEFAULT_FEISHU_HOST,
        publicBaseUrl: resolvePublicBaseUrl(this.db, this.env),
      };
    }

    const envConfig = readEnvFeishuConfig(this.env);
    const configured = envConfig.appId.length > 0 && envConfig.appSecret.length > 0;
    return {
      enabled: configured,
      configured,
      source: configured ? "environment" : "none",
      appId: envConfig.appId,
      hasSecret: envConfig.appSecret.length > 0,
      secretUnreadable: false,
      feishuHost: envConfig.feishuHost,
      publicBaseUrl: resolvePublicBaseUrl(this.db, this.env),
    };
  }

  isEnabled(): boolean {
    return this.resolveActiveCredentials() !== null;
  }

  resolveActiveCredentials(): FeishuAppCredentials | null {
    const row = this.readDbRow();
    if (row !== undefined) {
      if (!row.enabled || row.appId.trim().length === 0) {
        return null;
      }
      const secret = this.tryDecrypt(row);
      if (!secret) {
        return null;
      }
      return {
        appId: row.appId,
        appSecret: secret,
        feishuHost: normalizeOriginUrl(row.feishuHost || DEFAULT_FEISHU_HOST, DEFAULT_FEISHU_HOST),
        publicBaseUrl: resolvePublicBaseUrl(this.db, this.env),
      };
    }

    const envConfig = readEnvFeishuConfig(this.env);
    if (!envConfig.appId || !envConfig.appSecret) {
      return null;
    }
    return {
      ...envConfig,
      publicBaseUrl: resolvePublicBaseUrl(this.db, this.env),
    };
  }

  async save(raw: unknown, accountId: string): Promise<FeishuAuthPublicSettings> {
    if (!this.db) {
      throw new FeishuAuthConfigError("database_unavailable", "数据库不可用。", 409);
    }
    const parsed = feishuAuthSettingsInput.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FeishuAuthConfigError("invalid_settings", issue?.message ?? "飞书登录配置无效。", 400);
    }
    const input = parsed.data;
    const feishuHost = validateOriginOption(input.feishuHost || DEFAULT_FEISHU_HOST, "飞书开放平台地址");
    const publicBaseUrl = input.publicBaseUrl
      ? validateOriginOption(input.publicBaseUrl, "对外访问地址")
      : "";

    const existing = this.readDbRow();
    const enteredSecret = input.appSecret?.trim() ?? "";
    let secret = enteredSecret;
    if (!secret && existing && existing.appId === input.appId) {
      const existingSecret = this.tryDecrypt(existing);
      if (existingSecret === undefined) {
        throw new FeishuAuthConfigError(
          "feishu_secret_unreadable",
          "已保存的 App Secret 无法解密，请重新输入 App Secret。",
          409,
        );
      }
      secret = existingSecret;
    }
    if (!secret) {
      throw new FeishuAuthConfigError("app_secret_required", "请输入飞书应用 App Secret。", 400);
    }

    if (input.enabled) {
      try {
        await this.verify({ appId: input.appId, appSecret: secret, feishuHost });
      } catch (error) {
        const detail = error instanceof Error && error.message ? `（${error.message}）` : "";
        throw new FeishuAuthConfigError(
          "feishu_credentials_invalid",
          `无法验证飞书应用凭据，请检查 App ID、App Secret 与开放平台地址${detail}。`,
          400,
        );
      }
    }

    const encrypted = this.cipherFactory().encrypt({
      ...SECRET_BINDING,
      plaintext: secret,
    });
    const values = {
      provider: FEISHU_OAUTH_PROVIDER,
      enabled: input.enabled,
      appId: input.appId,
      secret: encrypted,
      feishuHost,
      publicBaseUrl,
      updatedByAccountId: accountId,
      updatedAt: Date.now(),
    };
    this.db
      .insert(platformAuthSettings)
      .values(values)
      .onConflictDoUpdate({ target: platformAuthSettings.provider, set: values })
      .run();
    return this.getPublicSettings();
  }

  clear(): FeishuAuthPublicSettings {
    if (!this.db) {
      throw new FeishuAuthConfigError("database_unavailable", "数据库不可用。", 409);
    }
    this.db
      .delete(platformAuthSettings)
      .where(eq(platformAuthSettings.provider, FEISHU_OAUTH_PROVIDER))
      .run();
    return this.getPublicSettings();
  }

  private readDbRow(): typeof platformAuthSettings.$inferSelect | undefined {
    if (!this.db) return undefined;
    try {
      return this.db
        .select()
        .from(platformAuthSettings)
        .where(eq(platformAuthSettings.provider, FEISHU_OAUTH_PROVIDER))
        .get();
    } catch {
      return undefined;
    }
  }

  private tryDecrypt(row: typeof platformAuthSettings.$inferSelect): string | undefined {
    try {
      return this.cipherFactory().decrypt({
        ...row.secret,
        ...SECRET_BINDING,
      });
    } catch {
      return undefined;
    }
  }
}

/**
 * Builds the Feishu OAuth authorize redirect URL.
 * Like botmux-platform, plain login requests no extra scopes so Feishu skips
 * sensitive-permission confirmation prompts while still returning union_id/open_id/name/avatar.
 */
export function buildFeishuAuthorizeUrl(input: {
  readonly appId: string;
  readonly feishuHost: string;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const host = normalizeOriginUrl(input.feishuHost, DEFAULT_FEISHU_HOST);
  const query = new URLSearchParams({
    app_id: input.appId,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${host}/open-apis/authen/v1/authorize?${query.toString()}`;
}

export function resolveFeishuCallbackUrl(requestUrl: string, publicBaseUrl?: string): string {
  const origin = publicBaseUrl?.trim()
    ? normalizeOriginUrl(publicBaseUrl, new URL(requestUrl).origin)
    : new URL(requestUrl).origin;
  return `${origin}${FEISHU_CALLBACK_PATH}`;
}

export async function fetchFeishuAppAccessToken(
  input: {
    readonly appId: string;
    readonly appSecret: string;
    readonly feishuHost: string;
  },
  fetchImpl: FeishuFetch = fetch,
): Promise<string> {
  const host = normalizeOriginUrl(input.feishuHost, DEFAULT_FEISHU_HOST);
  const envelope = await callFeishuJson(
    fetchImpl,
    `${host}/open-apis/auth/v3/app_access_token/internal`,
    {
      method: "POST",
      body: { app_id: input.appId, app_secret: input.appSecret },
    },
  );
  const token = nonEmptyString(envelope.fields.app_access_token);
  if (envelope.code !== 0 || !token) {
    throw new Error(`app_access_token code=${envelope.codeText} msg=${envelope.msg}`);
  }
  return token;
}

export interface FeishuOAuthExchangeResult {
  readonly account: DashboardAccount;
  readonly identityClaims: readonly AccountIdentityClaimInput[];
}

/**
 * Exchanges a Feishu OAuth `code` via v1 OIDC (`app_access_token/internal` ->
 * `authen/v1/oidc/access_token` -> `authen/v1/user_info`) and resolves the
 * Dashboard account (`union_id` preferred, `open_id` fallback) along with
 * normalized `IdentityClaim`s for channel-agnostic owner association.
 */
export async function exchangeFeishuAuthorizationCode(
  input: {
    readonly code: string;
    readonly appId: string;
    readonly appSecret: string;
    readonly feishuHost: string;
  },
  fetchImpl: FeishuFetch = fetch,
): Promise<FeishuOAuthExchangeResult> {
  const host = normalizeOriginUrl(input.feishuHost, DEFAULT_FEISHU_HOST);
  const appToken = await fetchFeishuAppAccessToken(
    { appId: input.appId, appSecret: input.appSecret, feishuHost: host },
    fetchImpl,
  );

  const tokenEnvelope = await callFeishuJson(
    fetchImpl,
    `${host}/open-apis/authen/v1/oidc/access_token`,
    {
      method: "POST",
      bearer: appToken,
      body: { grant_type: "authorization_code", code: input.code },
    },
  );
  const tokenData = tokenEnvelope.dataOrSelf;
  const userAccessToken = nonEmptyString(tokenData.access_token);
  if (tokenEnvelope.code !== 0 || !userAccessToken) {
    throw new Error(`user_access_token code=${tokenEnvelope.codeText} msg=${tokenEnvelope.msg}`);
  }

  const userEnvelope = await callFeishuJson(
    fetchImpl,
    `${host}/open-apis/authen/v1/user_info`,
    {
      method: "GET",
      bearer: userAccessToken,
    },
  );
  if (userEnvelope.code !== 0) {
    throw new Error(`user_info code=${userEnvelope.codeText} msg=${userEnvelope.msg}`);
  }
  const userData = userEnvelope.dataOrSelf;
  const unionId = nonEmptyString(userData.union_id);
  const openId = nonEmptyString(userData.open_id);
  const userId = nonEmptyString(userData.user_id);
  const tenantKey = nonEmptyString(userData.tenant_key);
  const identity = unionId ?? openId;
  if (!identity) {
    throw new Error("飞书 user_info 未返回 union_id 或 open_id");
  }
  const rawName = nonEmptyString(userData.name) ?? nonEmptyString(userData.en_name) ?? "";
  const name = cleanDisplayName(rawName) || "飞书用户";
  const avatarUrl = nonEmptyString(userData.avatar_url) ?? nonEmptyString(userData.avatar_thumb) ?? null;

  const { identityClaims: rawClaims } = feishuIdentityMetadata(
    {
      environment: feishuEnvironmentFromHost(host),
      appId: input.appId,
      ...(tenantKey ? { tenantKey } : {}),
    },
    {
      ...(openId ? { open_id: openId } : {}),
      ...(userId ? { user_id: userId } : {}),
      ...(unionId ? { union_id: unionId } : {}),
    },
  );
  const identityClaims: AccountIdentityClaimInput[] = rawClaims
    .filter((claim): claim is typeof claim & { scope: string } => typeof claim.scope === "string" && claim.scope.length > 0)
    .map((claim) => ({
      namespace: claim.namespace,
      kind: claim.kind,
      value: claim.value,
      scope: claim.scope,
      confidence: claim.confidence ?? "verified",
    }));

  return {
    account: {
      id: `${FEISHU_OAUTH_PROVIDER}:${identity}`,
      name,
      provider: FEISHU_OAUTH_PROVIDER,
      avatarUrl,
    },
    identityClaims,
  };
}

interface FeishuEnvelope {
  readonly code: number;
  readonly codeText: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
  readonly dataOrSelf: Record<string, unknown>;
}

async function callFeishuJson(
  fetchImpl: FeishuFetch,
  url: string,
  options: {
    readonly method: "GET" | "POST";
    readonly bearer?: string;
    readonly body?: Record<string, unknown>;
  },
): Promise<FeishuEnvelope> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (options.bearer) {
    headers.authorization = `Bearer ${options.bearer}`;
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ url, error: error instanceof Error ? error.message : String(error) }, "Feishu OAuth request failed");
    throw error;
  }

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    logger.warn({ url, status: response.status }, "Feishu OAuth returned non-JSON response");
    throw new Error(`feishu HTTP ${response.status}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`feishu invalid response (${response.status})`);
  }
  const code = typeof parsed.code === "number" && Number.isInteger(parsed.code) ? parsed.code : -1;
  const codeText = parsed.code === undefined ? "undefined" : String(parsed.code);
  const msg = typeof parsed.msg === "string" ? parsed.msg : "";
  const dataOrSelf = isPlainObject(parsed.data) ? parsed.data : parsed;
  if (code !== 0) {
    logger.warn({ url, status: response.status, apiCode: code }, "Feishu OAuth API error");
  }
  return { code, codeText, msg, fields: parsed, dataOrSelf };
}

function readEnvFeishuConfig(env: EnvMap): FeishuAppCredentials {
  const appId = firstNonEmpty(env.LUNA_FEISHU_APP_ID, env.FEISHU_APP_ID);
  const appSecret = firstNonEmpty(env.LUNA_FEISHU_APP_SECRET, env.FEISHU_APP_SECRET);
  const rawHost = firstNonEmpty(env.LUNA_FEISHU_HOST, env.FEISHU_HOST, DEFAULT_FEISHU_HOST);
  return {
    appId,
    appSecret,
    feishuHost: normalizeOriginUrl(rawHost, DEFAULT_FEISHU_HOST),
    publicBaseUrl: readEnvPublicBaseUrl(env),
  };
}

function readEnvPublicBaseUrl(env: EnvMap): string {
  const candidate = firstNonEmpty(
    env.LUNA_FEISHU_PUBLIC_BASE_URL,
    env.LUNA_SERVICE_URL,
    env.PUBLIC_BASE_URL,
  );
  return candidate ? normalizeOriginUrl(candidate, "") : "";
}

function validateOriginOption(raw: string, label: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new FeishuAuthConfigError("invalid_url", `${label}必须是合法的 http(s) 地址。`, 400);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new FeishuAuthConfigError(
      "invalid_url",
      `${label}必须是形如 https://example.com 的纯域名地址（不含路径或查询参数）。`,
      400,
    );
  }
  return parsed.origin;
}

function normalizeOriginUrl(raw: string, fallback: string): string {
  try {
    return validateOriginOption(raw, "URL");
  } catch {
    return fallback;
  }
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
