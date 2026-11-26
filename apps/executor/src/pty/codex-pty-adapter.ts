import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runnerAssetPaths, runnerResourcesPath } from "@luna/runner-protocol/runner-assets";
import type { ProviderOutput } from "@luna/runner-protocol";
import { CODEX_PROJECT_DOC_MAX_BYTES } from "../providers/codex";
import { prepareCodexSkills } from "../providers/codex-skills";
import { normalizeProviderFailure } from "../providers/failure-normalizer";
import { toolResultText, toolTitle } from "../providers/tool-progress";
import { currentRegularFileSize, drainJsonlLines, writePrivateJsonAtomic } from "./jsonl-cursor";
import { writeCodexHooksJson } from "../task-hooks";
import { chunkTextByUtf8Bytes } from "./viewport";
import type { PtyCliAdapter, PtySpawnSpec, PtyTurnBridge, PtyTurnDrainResult, PtyWriteTarget } from "./types";

const CODEX_ACTIVE_BUSY_RE = /Working[^\r\n]{0,160}esc to interrupt|Queued for capacity/i;
const CODEX_STARTUP_PENDING_RE = /(?:│[ \t]+(?:model|directory):[ \t]+loading\b|OpenAI Codex\s*\([^)]+\)[ \t]+loading\b)/;
const CODEX_STARTUP_READY_RE = /(?:│[ \t]+model:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│[ \t\r\n]*│[ \t]+directory:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│|permissions:[ \t]+YOLO mode)/;
const CODEX_ROLLOUT_SESSION_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl$/i;

function parseCodexErrorCode(message: string): string | undefined {
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid_encrypted_content")) return "runner_session_not_found";
  if (
    (normalized.includes("thread/resume failed") || normalized.includes("resume")) &&
    (normalized.includes("no rollout found") || normalized.includes("no thread found") || normalized.includes("not found"))
  ) {
    return "runner_session_not_found";
  }
  return undefined;
}

function normalizeCodexFailure(message: string) {
  const code = parseCodexErrorCode(message);
  return normalizeProviderFailure("codex", message, {
    ...(code ? { providerCode: code } : {}),
    fallbackKind: code === "runner_session_not_found" ? "session_unusable" : "unknown",
  });
}

export function resolveCodexHome(home: string, env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || join(home, ".codex");
}

/** Ensure `CODEX_HOME` exists and pre-seed `auth.json` so interactive Codex skips the first-run login wizard. */
export function seedCodexAuthState(codexHome: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(codexHome, { recursive: true });
  const apiKey = env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim();
  if (!apiKey || env.CODEX_PROVIDER_MODE === "gateway") return;
  const authPath = join(codexHome, "auth.json");
  let data: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch { /* replace unreadable auth state */ }
  }
  if (data.auth_mode !== "apikey" || data.OPENAI_API_KEY !== apiKey) {
    data.auth_mode = "apikey";
    data.OPENAI_API_KEY = apiKey;
    writePrivateJsonAtomic(authPath, data);
  }
}

function extractRolloutSessionId(filePath: string): string | undefined {
  return CODEX_ROLLOUT_SESSION_RE.exec(basename(filePath))?.[1];
}

/**
 * Inspect `/proc/<pid>/fd` on Linux to locate the rollout `.jsonl` files held open by `codex`.
 * On Docker Desktop VirtioFS bind mounts, `/proc/<pid>/fd/<n>` may resolve to a mount-root path
 * such as `/run/host_virtiofs/...` that is not directly addressable inside the container namespace;
 * in that case `sessionId` is still authoritative and `path` falls back to `<codexHome>/sessions`.
 */
export function findOpenCodexRolloutsByPid(
  pid: number,
  codexHome?: string,
): Array<{ path?: string | undefined; sessionId: string }> {
  if (pid <= 0) return [];
  const fdDir = `/proc/${pid}/fd`;
  if (!existsSync(fdDir)) return [];
  const matches: Array<{ path?: string | undefined; sessionId: string }> = [];
  const seen = new Set<string>();
  try {
    for (const entry of readdirSync(fdDir)) {
      try {
        const target = readlinkSync(join(fdDir, entry));
        if (target.endsWith(" (deleted)") || !target.endsWith(".jsonl")) continue;
        const sid = extractRolloutSessionId(target);
        if (!sid) continue;
        const key = sid.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const usablePath = existsSync(target)
          ? target
          : (codexHome ? findCodexRolloutBySessionId(codexHome, sid) : undefined);
        matches.push({ path: usablePath, sessionId: sid });
      } catch { /* fd closed concurrently */ }
    }
  } catch { /* /proc unavailable */ }
  return matches;
}

/** Locate a rollout file under `<codexHome>/sessions/YYYY/MM/DD/` by `sessionId` (newest mtime wins on resumed generations). */
export function findCodexRolloutBySessionId(codexHome: string, sessionId: string): string | undefined {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return undefined;
  const targetLower = sessionId.toLowerCase();
  let best: { path: string; mtimeMs: number } | undefined;

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (st.isFile() && name.endsWith(".jsonl")) {
          const sid = extractRolloutSessionId(name);
          if (sid && sid.toLowerCase() === targetLower) {
            if (!best || st.mtimeMs >= best.mtimeMs) {
              best = { path: full, mtimeMs: st.mtimeMs };
            }
          }
        }
      } catch { /* ignore transient entry */ }
    }
  };
  walk(root, 0);
  return best?.path;
}

function isCodexViewportReady(screen: string): boolean {
  if (/(?:model|directory):\s*loading\b|OpenAI Codex\s*\([^)]+\)\s+loading\b|Resuming session|esc to interrupt|Queued for capacity/i.test(screen)) {
    return false;
  }
  const lines = screen.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i -= 1) {
    const line = lines[i] ?? "";
    if (/^\s*[›»](?:\s|$)/.test(line) && !/^\s*[›»]\s*\d+\./.test(line)) {
      return true;
    }
  }
  return false;
}

function normaliseText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function parseArgsObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      const cmdMatch = /exec_command\(\{\s*cmd:\s*("(?:\\.|[^"\\])*")/.exec(raw);
      if (cmdMatch?.[1]) {
        try {
          return { command: JSON.parse(cmdMatch[1]) as string };
        } catch { /* fall back to raw */ }
      }
      return { command: raw };
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function extractFailureMessage(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
    try { return JSON.stringify(err); } catch { /* ignore */ }
  }
  return "Codex turn failed";
}

function toolOutputIndicatesFailure(rawOutput: unknown): boolean {
  const text = typeof rawOutput === "string"
    ? rawOutput
    : Array.isArray(rawOutput)
      ? rawOutput
          .map((item) => (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string"
            ? (item as Record<string, unknown>).text as string
            : ""))
          .filter(Boolean)
          .join("\n")
      : "";
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.exit_code === "number" && parsed.exit_code !== 0) return true;
    if (parsed.metadata && typeof parsed.metadata === "object") {
      const code = (parsed.metadata as Record<string, unknown>).exit_code;
      if (typeof code === "number" && code !== 0) return true;
    }
  } catch { /* plain text output */ }
  return /^Process exited with code [1-9]\d*/m.test(text);
}

interface RolloutInspection {
  readonly sessionId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly hasPriorTurnActivity: boolean;
}

function lineIndicatesTurnActivity(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (!trimmed) return false;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const payload = obj.payload && typeof obj.payload === "object"
      ? (obj.payload as Record<string, unknown>)
      : undefined;
    if (!payload) return false;
    if (obj.type === "event_msg") {
      return (
        payload.type === "task_started" ||
        payload.type === "task_complete" ||
        payload.type === "turn_aborted" ||
        payload.type === "agent_message"
      );
    }
    if (obj.type === "response_item") {
      return payload.type === "message" && payload.role === "user";
    }
    return false;
  } catch {
    return false;
  }
}

export function inspectCodexRolloutFile(filePath: string): RolloutInspection {
  let fd: number | undefined;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0) {
      return { hasPriorTurnActivity: false };
    }
    fd = openSync(filePath, "r");
    const headLen = Math.min(st.size, 128 * 1024);
    const headBuf = Buffer.allocUnsafe(headLen);
    const bytesRead = readSync(fd, headBuf, 0, headLen, 0);
    const headText = headBuf.subarray(0, bytesRead).toString("utf8");

    let sessionId: string | undefined;
    let cwd: string | undefined;
    const headLines = headText.split("\n");
    const firstComplete = headLines.length > 1 ? headLines[0]!.trim() : "";
    if (firstComplete) {
      try {
        const meta = JSON.parse(firstComplete) as Record<string, unknown>;
        if (meta.type === "session_meta" && meta.payload && typeof meta.payload === "object") {
          const payload = meta.payload as Record<string, unknown>;
          const rawId = typeof payload.id === "string" && payload.id.trim()
            ? payload.id.trim()
            : typeof payload.session_id === "string" && payload.session_id.trim()
              ? payload.session_id.trim()
              : undefined;
          sessionId = rawId;
          if (typeof payload.cwd === "string" && payload.cwd.trim()) {
            cwd = payload.cwd.trim();
          }
        }
      } catch { /* ignore malformed head */ }
    }

    let hasPriorTurnActivity = false;
    const completeHeadCount = headLines.length - 1;
    for (let i = 1; i < completeHeadCount; i += 1) {
      if (lineIndicatesTurnActivity(headLines[i]!)) {
        hasPriorTurnActivity = true;
        break;
      }
    }
    if (!hasPriorTurnActivity && st.size > headLen) {
      const tailLen = Math.min(st.size - headLen, 64 * 1024);
      const tailBuf = Buffer.allocUnsafe(tailLen);
      const tailRead = readSync(fd, tailBuf, 0, tailLen, st.size - tailLen);
      const tailLines = tailBuf.subarray(0, tailRead).toString("utf8").split("\n");
      for (let i = 1; i < tailLines.length - 1; i += 1) {
        if (lineIndicatesTurnActivity(tailLines[i]!)) {
          hasPriorTurnActivity = true;
          break;
        }
      }
    }

    return { sessionId, cwd, hasPriorTurnActivity };
  } catch {
    return { hasPriorTurnActivity: false };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function collectExcludedColdRolloutSessions(codexHome: string, expectedCwd?: string): Set<string> {
  const excluded = new Set<string>();
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return excluded;

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (st.isFile() && name.endsWith(".jsonl")) {
          const sid = extractRolloutSessionId(name);
          if (!sid) continue;
          const info = inspectCodexRolloutFile(full);
          const cwdMismatch = Boolean(expectedCwd && info.cwd && info.cwd !== expectedCwd);
          if (cwdMismatch || info.hasPriorTurnActivity) {
            excluded.add(sid.toLowerCase());
          }
        }
      } catch { /* ignore transient entry */ }
    }
  };
  walk(root, 0);
  return excluded;
}

function isSameRegularFile(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

export class CodexRolloutTurnBridge implements PtyTurnBridge {
  private readonly historyPath: string;
  private historyOffset: number;
  private rolloutPath: string | undefined;
  private rolloutOffset = 0;
  private sessionId: string | undefined;
  private submitConfirmed = false;
  private initEmitted = false;
  private pendingOutputs: ProviderOutput[] = [];
  private terminalResult?: PtyTurnDrainResult["terminal"];
  private readonly expectedPromptTrimmed: string;
  private readonly excludedColdSessionIds: Set<string>;

  constructor(
    private readonly options: {
      readonly prompt: string;
      readonly codexHome: string;
      readonly cwd?: string | undefined;
      readonly cliPid: number;
      readonly initialSessionId?: string | undefined;
    },
  ) {
    this.historyPath = join(options.codexHome, "history.jsonl");
    this.historyOffset = currentRegularFileSize(this.historyPath);
    this.sessionId = options.initialSessionId;
    this.expectedPromptTrimmed = normaliseText(options.prompt);
    this.excludedColdSessionIds = this.sessionId
      ? new Set()
      : collectExcludedColdRolloutSessions(options.codexHome, options.cwd);

    if (this.sessionId) {
      const existing = findCodexRolloutBySessionId(options.codexHome, this.sessionId);
      if (existing) {
        this.rolloutPath = existing;
        this.rolloutOffset = currentRegularFileSize(existing);
      }
    }
  }

  private resolveRolloutPath(): void {
    const openRollouts = findOpenCodexRolloutsByPid(this.options.cliPid, this.options.codexHome);
    if (this.sessionId) {
      const exactOpen = openRollouts.find(r => r.sessionId.toLowerCase() === this.sessionId!.toLowerCase());
      const resolvedPath = exactOpen?.path ?? findCodexRolloutBySessionId(this.options.codexHome, this.sessionId);
      if (resolvedPath && (!this.rolloutPath || !isSameRegularFile(resolvedPath, this.rolloutPath))) {
        this.rolloutPath = resolvedPath;
        this.rolloutOffset = 0;
      }
      return;
    }

    const eligible: Array<{ sessionId: string; path: string }> = [];
    for (const candidate of openRollouts) {
      const key = candidate.sessionId.toLowerCase();
      if (this.excludedColdSessionIds.has(key)) continue;
      const resolvedPath = candidate.path ?? findCodexRolloutBySessionId(this.options.codexHome, candidate.sessionId);
      if (!resolvedPath) continue;
      const info = inspectCodexRolloutFile(resolvedPath);
      if (!info.sessionId) continue;
      if (this.options.cwd && info.cwd && info.cwd !== this.options.cwd) {
        this.excludedColdSessionIds.add(key);
        continue;
      }
      eligible.push({ sessionId: candidate.sessionId, path: resolvedPath });
    }

    if (eligible.length === 1 && eligible[0]) {
      this.sessionId = eligible[0].sessionId;
      this.rolloutPath = eligible[0].path;
      this.rolloutOffset = 0;
    }
  }

  private checkHistorySubmission(): void {
    if (this.submitConfirmed && this.sessionId) return;
    const { lines, newOffset } = drainJsonlLines(this.historyPath, this.historyOffset);
    this.historyOffset = newOffset;

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const text = typeof parsed.text === "string" ? normaliseText(parsed.text) : "";
      if (!text || text !== this.expectedPromptTrimmed) continue;
      const sid = typeof parsed.session_id === "string" && parsed.session_id.trim()
        ? parsed.session_id.trim()
        : undefined;
      if (sid && this.excludedColdSessionIds.has(sid.toLowerCase())) {
        continue;
      }
      if (this.sessionId && sid && sid.toLowerCase() !== this.sessionId.toLowerCase()) {
        continue;
      }
      if (!this.sessionId && sid && this.options.cwd) {
        const existingRollout = findCodexRolloutBySessionId(this.options.codexHome, sid);
        if (existingRollout) {
          const info = inspectCodexRolloutFile(existingRollout);
          if (info.cwd && info.cwd !== this.options.cwd) {
            this.excludedColdSessionIds.add(sid.toLowerCase());
            continue;
          }
        }
      }
      this.submitConfirmed = true;
      if (sid && !this.sessionId) {
        this.sessionId = sid;
      }
    }
  }

  ingest(): void {
    this.checkHistorySubmission();
    this.resolveRolloutPath();

    if (this.sessionId && !this.initEmitted) {
      this.initEmitted = true;
      this.pendingOutputs.push({ status: "init", sessionId: this.sessionId });
    }

    if (!this.rolloutPath) return;

    const { lines, newOffset } = drainJsonlLines(this.rolloutPath, this.rolloutOffset);
    this.rolloutOffset = newOffset;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

      const payload = obj.payload && typeof obj.payload === "object"
        ? (obj.payload as Record<string, unknown>)
        : undefined;
      if (!payload) continue;

      if (obj.type === "session_meta" && typeof payload.id === "string" && payload.id.trim()) {
        this.sessionId = payload.id.trim();
        if (!this.initEmitted) {
          this.initEmitted = true;
          this.pendingOutputs.push({ status: "init", sessionId: this.sessionId });
        }
        continue;
      }

      if (obj.type === "event_msg") {
        if (payload.type === "task_started") {
          this.submitConfirmed = true;
          continue;
        }
        if (payload.type === "agent_message" && typeof payload.message === "string" && payload.message.length > 0) {
          this.submitConfirmed = true;
          this.pendingOutputs.push({ status: "stream", text: payload.message });
          continue;
        }
        if (payload.type === "error") {
          const message = extractFailureMessage(payload.message ?? payload);
          const failure = normalizeCodexFailure(message);
          this.terminalResult = {
            kind: "error",
            output: {
              status: "error",
              error: message,
              failure,
              ...(failure.providerCode ? { code: failure.providerCode } : {}),
            },
          };
          continue;
        }
        if (payload.type === "task_complete") {
          this.submitConfirmed = true;
          if (payload.error !== undefined && payload.error !== null) {
            const message = extractFailureMessage(payload.error);
            const failure = normalizeCodexFailure(message);
            this.terminalResult = {
              kind: "error",
              output: {
                status: "error",
                error: message,
                failure,
                ...(failure.providerCode ? { code: failure.providerCode } : {}),
              },
            };
          } else {
            const finalText = typeof payload.last_agent_message === "string" ? payload.last_agent_message : "";
            this.terminalResult = { kind: "completed", finalText };
          }
          continue;
        }
        if (payload.type === "turn_aborted") {
          this.terminalResult = {
            kind: "aborted",
            reason: typeof payload.reason === "string" ? payload.reason : undefined,
          };
          continue;
        }
      }

      if (obj.type === "response_item") {
        if (payload.type === "message" && payload.role === "user") {
          this.submitConfirmed = true;
          continue;
        }
        if (
          (payload.type === "function_call" || payload.type === "custom_tool_call") &&
          typeof payload.name === "string"
        ) {
          const id = typeof payload.call_id === "string" && payload.call_id
            ? payload.call_id
            : typeof payload.id === "string"
              ? payload.id
              : "";
          if (!id) continue;
          const rawName = payload.name;
          const name = ["shell", "exec_command", "shell_command", "exec"].includes(rawName) ? "Bash" : rawName;
          const args = parseArgsObject(payload.type === "function_call" ? payload.arguments : payload.input);
          this.pendingOutputs.push({ status: "tool_start", id, name, title: toolTitle(name, args) });
          continue;
        }
        if (payload.type === "local_shell_call") {
          const id = typeof payload.call_id === "string" && payload.call_id
            ? payload.call_id
            : typeof payload.id === "string"
              ? payload.id
              : "";
          if (!id) continue;
          const action = parseArgsObject(payload.action);
          this.pendingOutputs.push({ status: "tool_start", id, name: "Bash", title: toolTitle("Bash", action) });
          continue;
        }
        if (payload.type === "web_search_call" && typeof payload.id === "string" && payload.id) {
          const action = parseArgsObject(payload.action);
          this.pendingOutputs.push({ status: "tool_start", id: payload.id, name: "web_search", title: toolTitle("web_search", action) });
          if (payload.status === "completed" || payload.status === "failed") {
            this.pendingOutputs.push({ status: "tool_result", id: payload.id, text: toolResultText(payload.status === "failed") });
            this.pendingOutputs.push({ status: "checkpoint" });
          }
          continue;
        }
        if (
          payload.type === "function_call_output" ||
          payload.type === "custom_tool_call_output" ||
          payload.type === "local_shell_call_output"
        ) {
          const id = typeof payload.call_id === "string" ? payload.call_id : "";
          if (!id) continue;
          this.pendingOutputs.push({
            status: "tool_result",
            id,
            text: toolResultText(toolOutputIndicatesFailure(payload.output)),
          });
          this.pendingOutputs.push({ status: "checkpoint" });
        }
      }
    }
  }

  isSubmittedOrTerminal(): { submitted: boolean; sessionId?: string } {
    this.ingest();
    return {
      submitted: this.submitConfirmed || this.terminalResult !== undefined,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }

  drain(): PtyTurnDrainResult {
    this.ingest();
    const outputs = this.pendingOutputs.splice(0);
    return {
      outputs,
      ...(this.sessionId ? { observedSessionId: this.sessionId } : {}),
      submitConfirmed: this.submitConfirmed,
      ...(this.terminalResult ? { terminal: this.terminalResult } : {}),
    };
  }
}

export const codexPtyAdapter: PtyCliAdapter = {
  family: "codex",
  idleConfig: {
    readyPattern: /[›»](?!\s*\d+\.)|\d+% left/,
    busyPattern: CODEX_ACTIVE_BUSY_RE,
    startupPendingPattern: CODEX_STARTUP_PENDING_RE,
    startupReadyPattern: CODEX_STARTUP_READY_RE,
    isViewportReady: isCodexViewportReady,
    quiescenceMs: 2_000,
    spinnerGuardMs: 3_000,
  },

  async prepareSpawn(input): Promise<PtySpawnSpec> {
    const codexHome = resolveCodexHome(input.home, input.baseEnv);
    seedCodexAuthState(codexHome, input.baseEnv);
    writeCodexHooksJson(codexHome);
    const { skillPlugin } = runnerAssetPaths(input.home);
    if (existsSync(join(skillPlugin, ".codex-plugin", "plugin.json"))) {
      await prepareCodexSkills({ ...input.baseEnv, CODEX_HOME: codexHome }, runnerResourcesPath(input.home), codexHome);
    }

    const rootArgs: string[] = [
      "-c", "analytics.enabled=false",
      "-c", "check_for_update_on_startup=false",
      "-c", `project_doc_max_bytes=${CODEX_PROJECT_DOC_MAX_BYTES}`,
      "-c", `projects={${JSON.stringify(input.cwd)}={trust_level="trusted"}}`,
      "-c", `shell_environment_policy.set.LUNA_TURN_ENV_FILE=${JSON.stringify(input.turnEnvFile)}`,
    ];

    if(input.baseEnv.CODEX_WEB_SEARCH_MODE==="disabled")rootArgs.push("-c",'web_search="disabled"');
    if (input.baseEnv.CODEX_PROVIDER_MODE === "gateway") {
      const baseUrl = input.baseEnv.OPENAI_BASE_URL;
      if (!baseUrl || !input.baseEnv.OPENAI_API_KEY?.trim()) {
        throw new Error("Codex gateway requires OPENAI_BASE_URL and OPENAI_API_KEY");
      }
      rootArgs.push(
        "-c", 'model_provider="luna_gateway"',
        "-c", 'model_providers.luna_gateway.name="Luna Gateway"',
        "-c", `model_providers.luna_gateway.base_url=${JSON.stringify(baseUrl)}`,
        "-c", 'model_providers.luna_gateway.env_key="OPENAI_API_KEY"',
        "-c", 'model_providers.luna_gateway.wire_api="responses"',
        "-c", "model_providers.luna_gateway.requires_openai_auth=false",
        "-c", "model_providers.luna_gateway.supports_websockets=false",
      );
    }

    const commonTuiFlags: string[] = [
      "--no-daemon",
      "--no-alt-screen",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      ...(input.model?.trim() ? ["--model", input.model.trim()] : []),
    ];

    const args = input.resumeSessionId
      ? [...rootArgs, "-c", "tui.auto_recap=false", "resume", ...commonTuiFlags, input.resumeSessionId]
      : [...rootArgs, ...commonTuiFlags, "-C", input.cwd];

    const env: NodeJS.ProcessEnv = {
      ...input.baseEnv,
      TERM: "xterm-256color",
      ...(input.baseEnv.CODEX_HOME?.trim() ? { CODEX_HOME: codexHome } : {}),
      LUNA_TURN_ENV_FILE: input.turnEnvFile,
    };

    return {
      command: input.runnerType === "codex" ? "codex" : input.runnerType,
      args,
      env,
      ...(input.resumeSessionId ? { initialSessionId: input.resumeSessionId } : {}),
    };
  },

  beginTurn(input) {
    const codexHome = resolveCodexHome(input.home, input.env);
    const bridge = new CodexRolloutTurnBridge({
      prompt: input.prompt,
      codexHome,
      cwd: input.cwd,
      cliPid: input.cliPid,
      initialSessionId: input.currentSessionId,
    });

    return {
      bridge,
      async submit(pty: PtyWriteTarget) {
        const chunks = chunkTextByUtf8Bytes(input.prompt, 4096);
        pty.write("\x1b[200~");
        for (let i = 0; i < chunks.length; i += 1) {
          pty.write(chunks[i]!);
          if (i < chunks.length - 1) await delay(15);
        }
        pty.write("\x1b[201~");
        await delay(250);
        pty.write("\r");

        const deadline = Date.now() + 3_500;
        while (Date.now() < deadline) {
          const check = bridge.isSubmittedOrTerminal();
          if (check.submitted) {
            return { submitted: true, sessionId: check.sessionId };
          }
          await delay(100);
        }
        pty.write("\r");
        const retryDeadline = Date.now() + 2_000;
        while (Date.now() < retryDeadline) {
          const check = bridge.isSubmittedOrTerminal();
          if (check.submitted) {
            return { submitted: true, sessionId: check.sessionId };
          }
          await delay(100);
        }
        return {
          submitted: false,
          failureReason: "Codex PTY did not record prompt submission in history.jsonl",
        };
      },
    };
  },

  normalizeExitFailure(message: string) {
    const failure = normalizeCodexFailure(message);
    return {
      failure,
      ...(failure.providerCode ? { code: failure.providerCode } : {}),
    };
  },
};
