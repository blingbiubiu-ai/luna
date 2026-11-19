import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { CliResult, Env, UnifiedServiceRequest } from "./types";
import { readCredentials, resolveAccessToken, resolveTurnLunaEnv } from "./env";
import { setTimeout as sleep } from "node:timers/promises";
import { isPlainRecord, readIdentityOption } from "./options";
import {
  DEFAULT_LUNA_SERVICE_HOST,
  DEFAULT_LUNA_SERVICE_PORT,
} from "@luna/host-runtime/defaults";
import { artifactRef, parseArtifactRef } from "@luna/service-client/artifact-ref";
import { inferMimeType } from "@luna/service-client/mime";

export async function callUnifiedService(env: Env, request: UnifiedServiceRequest): Promise<CliResult> {
  let headers: Headers;
  try {
    headers = unifiedServiceHeaders(env);
  } catch (error) {
    return {
      status: "error",
      code: "invalid_identity_env",
      message: error instanceof Error ? error.message : "invalid identity env",
    };
  }
  if (request.idempotencyKey) headers.set("Idempotency-Key", request.idempotencyKey);
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.body !== undefined) {
    headers.set("content-type", "application/json; charset=utf-8");
    init.body = JSON.stringify(request.body);
  }

  let response: Response;
  try {
    response = await fetch(resolveUnifiedServiceUrl(env, request.path), init);
  } catch (error) {
    return {
      status: "error",
      code: "unified_service_unreachable",
      message: error instanceof Error ? error.message : "failed to call Luna Service",
    };
  }

  const text = await response.text();
  const payload = parseJsonPayload(text);
  if (!response.ok) {
    const code = serviceErrorCode(payload, response.status);
    const enrichedPayload = addServiceErrorHint(payload, code);
    return {
      status: "error",
      code,
      message: serviceErrorMessage(enrichedPayload, response.status),
      output: JSON.stringify(enrichedPayload),
    };
  }
  return { status: "ok", output: JSON.stringify(payload) };
}

export async function downloadArtifactsFromOutput(
  env: Env,
  output: string | undefined,
): Promise<CliResult> {
  const payload = parseJsonPayload(output ?? "{}");
  if (!isPlainRecord(payload) || !Array.isArray(payload.artifacts)) {
    return output === undefined ? { status: "ok" } : { status: "ok", output };
  }

  const artifacts = [];
  for (const artifact of payload.artifacts) {
    if (!isPlainRecord(artifact)) {
      artifacts.push(artifact);
      continue;
    }
    const downloadUrl = stringValue(artifact.downloadUrl);
    const name = stringValue(artifact.name) ?? "artifact";
    const id = stringValue(artifact.id) ?? "artifact";
    if (downloadUrl === undefined) {
      artifacts.push(artifact);
      continue;
    }
    const localPath = await downloadArtifact(env, {
      id,
      name,
      downloadUrl,
    });
    artifacts.push({ ...artifact, localPath });
  }

  return {
    status: "ok",
    output: JSON.stringify({ ...payload, artifacts }),
  };
}

export interface ArtifactMaterializeResult {
  readonly artifactId: string;
  readonly path: string;
  readonly mimeType?: string;
  readonly sizeBytes: number;
  readonly cached: boolean;
}

export async function materializeArtifact(
  env: Env,
  input: {
    readonly ref: string;
    readonly outputDir?: string;
  },
): Promise<ArtifactMaterializeResult> {
  const artifactId = requireArtifactId(input.ref);
  const directory = input.outputDir === undefined
    ? artifactCacheDirectory(env)
    : resolve(input.outputDir);
  const manifest = readArtifactCacheManifest(directory);
  const cached = manifest[artifactId];
  if (cached !== undefined && existsSync(cached.path)) {
    const stats = statSync(cached.path);
    const cachedHashMatches = cached.sha256 === undefined ||
      sha256File(cached.path) === cached.sha256;
    if (stats.isFile() && stats.size === cached.sizeBytes && cachedHashMatches) {
      return {
        artifactId,
        path: cached.path,
        ...(cached.mimeType === undefined ? {} : { mimeType: cached.mimeType }),
        sizeBytes: cached.sizeBytes,
        cached: true,
      };
    }
  }

  const response = await fetch(
    resolveUnifiedServiceUrl(
      env,
      `/api/artifacts/${encodeURIComponent(artifactId)}/content`,
    ),
    {
      method: "GET",
      headers: unifiedServiceHeaders(env),
    },
  );
  if (!response.ok) {
    throw new Error(`failed to materialize artifact ${artifactId}: HTTP ${response.status}`);
  }
  mkdirSync(directory, { recursive: true });
  const mimeType = response.headers.get("content-type") ?? undefined;
  const name = fileNameFromContentDisposition(response.headers.get("content-disposition")) ??
    `${artifactId}.artifact`;
  const path = join(directory, safeFileName(`${artifactId}-${basename(name)}`));
  const bytes = await response.arrayBuffer();
  await Bun.write(path, bytes);
  const sha256 = sha256Bytes(bytes);
  const result = {
    artifactId,
    path,
    ...(mimeType === undefined ? {} : { mimeType }),
    sizeBytes: bytes.byteLength,
    cached: false,
  } satisfies ArtifactMaterializeResult;
  writeArtifactCacheManifest(directory, {
    ...manifest,
    [artifactId]: {
      path,
      sizeBytes: result.sizeBytes,
      sha256,
      ...(mimeType === undefined ? {} : { mimeType }),
    },
  });
  return result;
}

export async function registerArtifactFile(
  env: Env,
  input: {
    readonly path: string;
    readonly scopeType?: string;
    readonly scopeId?: string;
    readonly kind?: string;
    readonly name?: string;
  },
): Promise<{
  readonly artifactId: string;
  readonly ref: string;
  readonly name: string;
  readonly downloadUrl?: string;
}> {
  const path = isAbsolute(input.path) ? resolve(input.path) : resolve(input.path);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`artifact source file not found: ${input.path}`);
  }
  const scope = resolveArtifactRegisterScope(env, input);
  const name = input.name ?? basename(path);
  const mimeType = inferMimeType(name);
  const response = await fetch(resolveUnifiedServiceUrl(env, "/api/artifacts"), {
    method: "POST",
    headers: jsonUnifiedServiceHeaders(env),
    body: JSON.stringify({
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      producer: "runner",
      kind: input.kind ?? defaultArtifactKind(name, mimeType),
      name,
      mimeType,
      contentBase64: readFileSync(path).toString("base64"),
    }),
  });
  if (!response.ok) {
    throw new Error(`failed to register artifact ${name}: HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!isPlainRecord(payload) || !isPlainRecord(payload.artifact)) {
    throw new Error("artifact registration response is invalid");
  }
  const artifactId = typeof payload.artifact.id === "string"
    ? payload.artifact.id
    : undefined;
  if (artifactId === undefined) {
    throw new Error("artifact registration response is missing artifact id");
  }
  const downloadUrl = typeof payload.artifact.downloadUrl === "string"
    ? payload.artifact.downloadUrl
    : undefined;
  return {
    artifactId,
    ref: artifactRef(artifactId),
    name,
    ...(downloadUrl === undefined ? {} : { downloadUrl }),
  };
}

export async function downloadArtifactToPath(
  env: Env,
  input: { readonly ref: string; readonly output: string },
): Promise<string> {
  const artifactId = requireArtifactId(input.ref);
  const response = await fetch(
    resolveUnifiedServiceUrl(
      env,
      `/api/artifacts/${encodeURIComponent(artifactId)}/content`,
    ),
    {
      method: "GET",
      headers: unifiedServiceHeaders(env),
    },
  );
  if (!response.ok) {
    throw new Error(`failed to download artifact ${artifactId}: HTTP ${response.status}`);
  }
  const output = isAbsolute(input.output) ? input.output : resolve(input.output);
  mkdirSync(dirname(output), { recursive: true });
  await Bun.write(output, await response.arrayBuffer());
  return output;
}

function jsonUnifiedServiceHeaders(env: Env): Headers {
  const headers = unifiedServiceHeaders(env);
  headers.set("content-type", "application/json; charset=utf-8");
  return headers;
}

function resolveArtifactRegisterScope(
  rawEnv: Env,
  input: { readonly scopeType?: string; readonly scopeId?: string },
): { readonly scopeType: string; readonly scopeId: string } {
  const env = resolveTurnLunaEnv(rawEnv);
  if (input.scopeType !== undefined && input.scopeId !== undefined) {
    return { scopeType: input.scopeType, scopeId: input.scopeId };
  }
  if (env.LUNA_TASK_ID !== undefined && env.LUNA_TASK_ID.trim().length > 0) {
    return { scopeType: "task", scopeId: env.LUNA_TASK_ID.trim() };
  }
  if (env.LUNA_SESSION_ID !== undefined && env.LUNA_SESSION_ID.trim().length > 0) {
    return { scopeType: "session", scopeId: env.LUNA_SESSION_ID.trim() };
  }
  throw new Error(
    "artifact register requires LUNA_TASK_ID, LUNA_SESSION_ID, or --scope-type/--scope-id",
  );
}

function defaultArtifactKind(name: string, mimeType: string): string {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (name === "final-report.md" || mimeType.startsWith("text/markdown")) {
    return "report";
  }
  return "file";
}

export async function catArtifact(
  env: Env,
  input: { readonly ref: string },
): Promise<string> {
  const artifactId = requireArtifactId(input.ref);
  const response = await fetch(
    resolveUnifiedServiceUrl(
      env,
      `/api/artifacts/${encodeURIComponent(artifactId)}/content`,
    ),
    {
      method: "GET",
      headers: unifiedServiceHeaders(env),
    },
  );
  if (!response.ok) {
    throw new Error(`failed to read artifact ${artifactId}: HTTP ${response.status}`);
  }
  return await response.text();
}

async function downloadArtifact(
  env: Env,
  artifact: {
    readonly id: string;
    readonly name: string;
    readonly downloadUrl: string;
  },
): Promise<string> {
  const response = await fetch(resolveArtifactDownloadUrl(env, artifact.downloadUrl), {
    method: "GET",
    headers: unifiedServiceHeaders(env),
  });
  if (!response.ok) {
    throw new Error(`failed to download artifact ${artifact.id}: HTTP ${response.status}`);
  }
  const directory = artifactDownloadDirectory(env);
  mkdirSync(directory, { recursive: true });
  const fileName = safeFileName(`${artifact.id}-${basename(artifact.name)}`);
  const path = join(directory, fileName);
  await Bun.write(path, await response.arrayBuffer());
  return path;
}

function resolveArtifactDownloadUrl(env: Env, downloadUrl: string): string {
  if (/^https?:\/\//i.test(downloadUrl)) {
    return downloadUrl;
  }
  return resolveUnifiedServiceUrl(env, downloadUrl);
}

function artifactDownloadDirectory(env: Env): string {
  return join(
    env.LUNA_ARTIFACTS_DIR ??
      join(env.LUNA_HOME ?? join(homedir(), ".luna"), "artifacts"),
    "downloads",
  );
}

function artifactCacheDirectory(env: Env): string {
  return join(
    env.LUNA_ARTIFACTS_DIR ??
      join(env.LUNA_HOME ?? join(homedir(), ".luna"), "artifacts"),
    "cache",
  );
}

type ArtifactCacheManifest = Record<
  string,
  {
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256?: string;
    readonly mimeType?: string;
  }
>;

function readArtifactCacheManifest(directory: string): ArtifactCacheManifest {
  const path = join(directory, "manifest.json");
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as ArtifactCacheManifest;
  } catch {
    return {};
  }
}

function writeArtifactCacheManifest(
  directory: string,
  manifest: ArtifactCacheManifest,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Bytes(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function requireArtifactId(ref: string): string {
  const id = parseArtifactRef(ref);
  if (id === undefined) {
    throw new Error(`invalid artifact ref: ${ref}`);
  }
  return id;
}

function fileNameFromContentDisposition(value: string | null): string | undefined {
  const match = value?.match(/filename="([^"]+)"/i);
  return match?.[1];
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") ||
    "artifact";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveUnifiedServiceUrl(env: Env, path: string): string {
  const base = resolveServiceBaseUrl(env);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export function resolveServiceBaseUrl(rawEnv: Env): string {
  const env = resolveTurnLunaEnv(rawEnv);
  const configured = env.LUNA_SERVICE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const credentials = readCredentials(env);
  if (credentials !== undefined) {
    return credentials.serviceUrl.replace(/\/+$/, "");
  }
  const host = env.LUNA_SERVICE_HOST?.trim() || DEFAULT_LUNA_SERVICE_HOST;
  const port = env.LUNA_SERVICE_PORT?.trim() ||
    String(DEFAULT_LUNA_SERVICE_PORT);
  const clientHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${clientHost}:${port}`;
}

export function unifiedServiceHeaders(rawEnv: Env): Headers {
  const env = resolveTurnLunaEnv(rawEnv);
  const headers = new Headers({ accept: "application/json" });
  const token = resolveAccessToken(env);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  setHeader(headers, "x-luna-actor-kind", env.LUNA_ACTOR_KIND);
  setHeader(headers, "x-luna-actor-id", env.LUNA_ACTOR_ID);
  setHeader(headers, "x-luna-runner-kind", env.LUNA_RUNNER_KIND);
  setHeader(headers, "x-luna-runner-context-id", env.LUNA_RUNNER_CONTEXT_ID);
  setHeader(headers, "x-luna-session-id", env.LUNA_SESSION_ID);
  setHeader(headers, "x-luna-task-id", env.LUNA_TASK_ID);
  setHeader(headers, "x-luna-task-run-id", env.LUNA_TASK_RUN_ID);
  return headers;
}

export function setHeader(headers: Headers, name: string, value: string | undefined): void {
  const trimmed = readIdentityOption(value);
  if (trimmed) {
    headers.set(name, trimmed);
  }
}

export function parseJsonPayload(text: string): unknown {
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { status: "error", message: text.trim() };
  }
}

export function serviceErrorCode(payload: unknown, status: number): string {
  if (isPlainRecord(payload)) {
    if (typeof payload.code === "string") {
      return payload.code;
    }
    if (typeof payload.errorCode === "string") {
      return payload.errorCode;
    }
    const error = payload.error;
    if (isPlainRecord(error) && typeof error.code === "string") {
      return error.code;
    }
  }
  return `http_${status}`;
}

function addServiceErrorHint(payload: unknown, code: string): unknown {
  const hint = serviceErrorHint(code);
  if (hint === undefined || !isPlainRecord(payload) || typeof payload.hint === "string") {
    return payload;
  }
  return {
    ...payload,
    hint,
  };
}

function serviceErrorHint(code: string): string | undefined {
  switch (code) {
    case "unauthorized":
    case "missing_access_token":
    case "invalid_access_token":
    case "expired_access_token":
      return "Luna CLI is not logged in or the access token is invalid. Run `luna auth login` and retry.";
    case "operation_not_granted":
      return "Current Luna account does not have this operation grant. Contact an administrator to enable the required operation permission.";
    default:
      return undefined;
  }
}

export function serviceErrorMessage(payload: unknown, status: number): string {
  if (isPlainRecord(payload)) {
    if (typeof payload.message === "string") {
      return payload.message;
    }
    const error = payload.error;
    if (isPlainRecord(error) && typeof error.message === "string") {
      return error.message;
    }
  }
  return `Luna Service returned HTTP ${status}`;
}

export function queryString(values: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    params.set(key, value);
  }
  return params.toString();
}

export function servicePathWithQuery(
  path: string,
  values: Record<string, string | undefined>,
): string {
  const definedValues = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  const query = queryString(definedValues);
  return query.length === 0 ? path : `${path}?${query}`;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchWithTimeout(url, init);
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
