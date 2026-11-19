import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runnerAssetPaths } from "@luna/runner-protocol/runner-assets";
import type { ProviderOutput } from "@luna/runner-protocol";
import { normalizeProviderFailure } from "../providers/failure-normalizer";
import { toolResultText, toolTitle } from "../providers/tool-progress";
import {
  currentRegularFileSize,
  drainJsonlLines,
  realpathOrResolve,
  writePrivateJsonAtomic,
} from "./jsonl-cursor";
import { chunkTextByUtf8Bytes, wrapBracketedPaste } from "./viewport";
import type { PtyCliAdapter, PtySpawnSpec, PtyTurnBridge, PtyTurnDrainResult, PtyWriteTarget } from "./types";

const COMPLETION_RE = /\u2733\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed|Baked|Brewed) for \d+[smh]/;
const CLAUDE_BUSY_FOOTER_RE = /^\s*(?:[⏵⏸]+\s.*\bon\b|.*next try).*·\s*esc to interrupt\b/m;
const SYNTHETIC_MODEL_PLACEHOLDER = "<synthetic>";

function claudeErrorCode(message: string): string | undefined {
  return message.toLowerCase().includes("no conversation found with session id")
    ? "runner_session_not_found"
    : undefined;
}

function normalizeClaudeFailure(message: string, explicitStatus?: number) {
  const normalized = message.toLowerCase();
  const providerCode = claudeErrorCode(message);
  const fallbackKind =
    providerCode === "runner_session_not_found"
      ? "session_unusable"
      : explicitStatus === 429 || normalized.includes("rate_limit")
        ? "rate_limited"
        : normalized.includes("reconnecting") || normalized.includes("response.failed") || normalized.includes("stream disconnected")
          ? "transport_interrupted"
          : "unknown";
  const withStatus = explicitStatus !== undefined && !/\bstatus\b/i.test(message)
    ? `${message} (HTTP ${explicitStatus})`
    : message;
  return normalizeProviderFailure("claude", withStatus, {
    fallbackKind,
    ...(providerCode === undefined ? {} : { providerCode }),
  });
}

export function claudeDataDir(home: string, env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
}

export function claudeStateJsonPath(home: string, env: NodeJS.ProcessEnv): string {
  const customDir = env.CLAUDE_CONFIG_DIR?.trim();
  return customDir ? join(customDir, ".claude.json") : join(home, ".claude.json");
}

export function claudeProjectSlug(cwd: string): string {
  return realpathOrResolve(cwd).replace(/[^A-Za-z0-9-]/g, "-");
}

export function resolveClaudeTranscriptPath(
  sessionId: string,
  cwd: string,
  dataDir: string,
): string {
  const slug = claudeProjectSlug(cwd);
  const exact = join(dataDir, "projects", slug, `${sessionId}.jsonl`);
  if (existsSync(exact) || slug.length <= 200) return exact;
  const projectsDir = join(dataDir, "projects");
  try {
    const prefix = slug.slice(0, 200);
    const target = `${sessionId}.jsonl`;
    const hits = readdirSync(projectsDir)
      .filter(name => name === slug || name.startsWith(`${prefix}-`))
      .map(name => join(projectsDir, name, target))
      .filter(candidate => existsSync(candidate));
    if (hits.length === 1 && hits[0]) return hits[0];
  } catch { /* fall back to exact */ }
  return exact;
}

function readClaudePidSessionId(pid: number, cwd: string, dataDir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "sessions", `${pid}.json`), "utf8")) as Record<string, unknown>;
    const sid = typeof raw.sessionId === "string" && raw.sessionId.trim() ? raw.sessionId.trim() : undefined;
    const pidCwd = typeof raw.cwd === "string" ? realpathOrResolve(raw.cwd) : undefined;
    if (!sid) return undefined;
    if (pidCwd && pidCwd !== realpathOrResolve(cwd)) return undefined;
    return sid;
  } catch {
    return undefined;
  }
}

/** Pre-seed `.claude.json` so interactive Claude never blocks on theme onboarding or folder trust. */
export function seedClaudeTrustState(home: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const statePath = claudeStateJsonPath(home, env);
  let data: Record<string, unknown> = {};
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch { /* replace unreadable state */ }
  }
  data.hasCompletedOnboarding = true;
  data.bypassPermissionsModeAccepted = true;
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (apiKey) {
    const suffix = apiKey.slice(-20);
    const existingResponses = (
      data.customApiKeyResponses &&
      typeof data.customApiKeyResponses === "object" &&
      !Array.isArray(data.customApiKeyResponses)
    )
      ? (data.customApiKeyResponses as Record<string, unknown>)
      : {};
    const approved = Array.isArray(existingResponses.approved)
      ? existingResponses.approved.filter((v): v is string => typeof v === "string")
      : [];
    if (!approved.includes(suffix)) approved.push(suffix);
    data.customApiKeyResponses = {
      ...existingResponses,
      approved,
      rejected: Array.isArray(existingResponses.rejected) ? existingResponses.rejected : [],
    };
  }
  const projects = (data.projects && typeof data.projects === "object" && !Array.isArray(data.projects))
    ? (data.projects as Record<string, unknown>)
    : {};
  data.projects = projects;
  const canonicalCwd = realpathOrResolve(cwd);
  const existing = projects[canonicalCwd];
  projects[canonicalCwd] = {
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    hasTrustDialogAccepted: true,
  };
  writePrivateJsonAtomic(statePath, data);
}

function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildHookCommand(hookEventsFile: string, event: "SessionStart" | "Stop" | "StopFailure"): string {
  return `/bin/sh -c 'printf "{\\"event\\":\\"${event}\\"}\\n" >> "$1"' sh ${shellEscapeSingle(hookEventsFile)}`;
}

function extractClaudeSettingsEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (key === "API_TIMEOUT_MS" || key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_")) {
      result[key] = value;
    }
  }
  return result;
}

function extractApiErrorText(obj: Record<string, unknown>): string {
  const msg = obj.message;
  if (msg && typeof msg === "object") {
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
        .map(b => b.text)
        .join(" ")
        .trim();
      if (text) return text;
    }
  }
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim();
  return "Claude execution failed";
}

function normalizePromptFingerprint(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, 120);
}

function userRecordMatchesFingerprint(obj: Record<string, unknown>, fingerprint: string): boolean {
  if (!fingerprint) return true;
  if (obj.type === "queue-operation" && typeof obj.content === "string") {
    return obj.content.replace(/\s+/g, " ").includes(fingerprint);
  }
  if (obj.type === "user" && obj.isMeta !== true) {
    const content = obj.message && typeof obj.message === "object"
      ? (obj.message as Record<string, unknown>).content
      : obj.content;
    if (typeof content === "string") {
      return content.replace(/\s+/g, " ").includes(fingerprint);
    }
    if (Array.isArray(content)) {
      const joined = content
        .map(block => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
        .join(" ")
        .replace(/\s+/g, " ");
      return joined.includes(fingerprint);
    }
  }
  return false;
}

export class ClaudeTranscriptTurnBridge implements PtyTurnBridge {
  private offset: number;
  private activePath: string;
  private activeSessionId: string;
  private submitConfirmed = false;
  private candidateText = "";
  private stopReasonCompleted = false;
  private turnDurationSeen = false;
  private terminalError?: Extract<ProviderOutput, { status: "error" }>;
  private initEmitted = false;
  private pendingOutputs: ProviderOutput[] = [];
  private readonly fingerprint: string;

  constructor(
    private readonly options: {
      readonly prompt: string;
      readonly cwd: string;
      readonly dataDir: string;
      readonly cliPid: number;
      readonly initialSessionId: string;
    },
  ) {
    this.activeSessionId = options.initialSessionId;
    this.activePath = resolveClaudeTranscriptPath(this.activeSessionId, options.cwd, options.dataDir);
    this.offset = currentRegularFileSize(this.activePath);
    this.fingerprint = normalizePromptFingerprint(options.prompt);
  }

  ingest(): void {
    const pidSid = this.options.cliPid > 0
      ? readClaudePidSessionId(this.options.cliPid, this.options.cwd, this.options.dataDir)
      : undefined;
    if (pidSid && pidSid !== this.activeSessionId) {
      const nextPath = resolveClaudeTranscriptPath(pidSid, this.options.cwd, this.options.dataDir);
      this.activeSessionId = pidSid;
      this.activePath = nextPath;
      this.offset = 0;
    }

    const { lines, newOffset } = drainJsonlLines(this.activePath, this.offset);
    this.offset = newOffset;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof obj.sessionId === "string" && obj.sessionId.trim()) {
        this.activeSessionId = obj.sessionId.trim();
      }
      if (!this.initEmitted) {
        this.initEmitted = true;
        this.pendingOutputs.push({ status: "init", sessionId: this.activeSessionId });
      }

      if (obj.isSidechain === true || obj.isCompactSummary === true) continue;

      if (!this.submitConfirmed && userRecordMatchesFingerprint(obj, this.fingerprint)) {
        this.submitConfirmed = true;
      }

      if (obj.type === "system" && obj.subtype === "turn_duration") {
        this.submitConfirmed = true;
        this.turnDurationSeen = true;
        continue;
      }

      if (obj.type === "assistant") {
        this.submitConfirmed = true;
        if (obj.isApiErrorMessage === true) {
          const message = extractApiErrorText(obj);
          const status = typeof obj.apiErrorStatus === "number" ? obj.apiErrorStatus : undefined;
          const failure = normalizeClaudeFailure(message, status);
          const code = failure.providerCode;
          this.terminalError = {
            status: "error",
            error: message,
            failure,
            ...(code ? { code } : {}),
          };
          continue;
        }

        const msg = obj.message && typeof obj.message === "object"
          ? (obj.message as Record<string, unknown>)
          : undefined;
        if (msg?.model === SYNTHETIC_MODEL_PLACEHOLDER) {
          const failure = normalizeProviderFailure("claude", "Claude exited turn without calling the model", {
            fallbackKind: "transport_interrupted",
          });
          this.terminalError = {
            status: "error",
            error: failure.message,
            failure,
          };
          continue;
        }

        const content = msg?.content;
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              textParts.push(b.text);
            } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
              this.candidateText = "";
              this.stopReasonCompleted = false;
              this.pendingOutputs.push({
                status: "tool_start",
                id: b.id,
                name: b.name,
                title: toolTitle(
                  b.name,
                  b.input && typeof b.input === "object" && !Array.isArray(b.input)
                    ? (b.input as Record<string, unknown>)
                    : {},
                ),
              });
            }
          }
          if (textParts.length > 0) {
            const joined = textParts.join("\n");
            this.candidateText = this.candidateText ? `${this.candidateText}\n${joined}` : joined;
            this.pendingOutputs.push({ status: "stream", text: this.candidateText });
          }
        }

        const stopReason = msg?.stop_reason;
        if (
          typeof stopReason === "string" &&
          stopReason.length > 0 &&
          stopReason !== "tool_use" &&
          stopReason !== "pause_turn"
        ) {
          this.stopReasonCompleted = true;
        }
        continue;
      }

      if (obj.type === "user" && obj.message && typeof obj.message === "object") {
        const content = (obj.message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
              this.candidateText = "";
              this.stopReasonCompleted = false;
              this.pendingOutputs.push({
                status: "tool_result",
                id: b.tool_use_id,
                text: toolResultText(b.is_error === true),
              });
              this.pendingOutputs.push({ status: "checkpoint" });
            }
          }
        }
      }
    }
  }

  isSubmittedOrTerminal(): { submitted: boolean; sessionId: string } {
    this.ingest();
    return {
      submitted: this.submitConfirmed || this.turnDurationSeen || this.terminalError !== undefined,
      sessionId: this.activeSessionId,
    };
  }

  drain(options?: { readonly settleFallback?: boolean }): PtyTurnDrainResult {
    this.ingest();
    const outputs = this.pendingOutputs.splice(0);
    const allowStopReasonFallback = options?.settleFallback === true;

    if (this.terminalError) {
      return {
        outputs,
        observedSessionId: this.activeSessionId,
        submitConfirmed: this.submitConfirmed,
        terminal: { kind: "error", output: this.terminalError },
      };
    }

    if (this.turnDurationSeen || (allowStopReasonFallback && this.stopReasonCompleted)) {
      return {
        outputs,
        observedSessionId: this.activeSessionId,
        submitConfirmed: this.submitConfirmed,
        terminal: { kind: "completed", finalText: this.candidateText },
      };
    }

    return {
      outputs,
      observedSessionId: this.activeSessionId,
      submitConfirmed: this.submitConfirmed,
    };
  }
}

export const claudePtyAdapter: PtyCliAdapter = {
  family: "claude",
  idleConfig: {
    readyPattern: /❯/,
    busyPattern: CLAUDE_BUSY_FOOTER_RE,
    completionPattern: COMPLETION_RE,
    quiescenceMs: 2_000,
    spinnerGuardMs: 3_000,
  },

  async prepareSpawn(input): Promise<PtySpawnSpec> {
    seedClaudeTrustState(input.home, input.cwd, input.baseEnv);
    const sessionId = input.resumeSessionId ?? randomUUID();
    const hookEventsFile = join(input.controlDir, "claude-hooks.jsonl");
    const settingsFile = join(input.controlDir, "claude-settings.json");
    const settingsEnv = extractClaudeSettingsEnv(input.baseEnv);

    const inlineSettings: Record<string, unknown> = {
      skipDangerousModePermissionPrompt: true,
      permissions: { defaultMode: "bypassPermissions" },
      ...(Object.keys(settingsEnv).length > 0 ? { env: settingsEnv } : {}),
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: buildHookCommand(hookEventsFile, "SessionStart") }] }],
        Stop: [{ hooks: [{ type: "command", command: buildHookCommand(hookEventsFile, "Stop") }] }],
        StopFailure: [{ hooks: [{ type: "command", command: buildHookCommand(hookEventsFile, "StopFailure") }] }],
      },
    };
    writePrivateJsonAtomic(settingsFile, inlineSettings);

    const args: string[] = [];
    const { skillPlugin } = runnerAssetPaths(input.home);
    if (existsSync(join(skillPlugin, ".claude-plugin", "plugin.json"))) {
      args.push("--plugin-dir", skillPlugin);
    }
    if (input.resumeSessionId) {
      args.push("--resume", input.resumeSessionId);
    } else {
      args.push("--session-id", sessionId);
    }
    if (input.model?.trim()) {
      args.push("--model", input.model.trim());
    }
    args.push(
      "--dangerously-skip-permissions",
      "--disallowed-tools",
      "EnterPlanMode,ExitPlanMode,AskUserQuestion",
      "--settings",
      settingsFile,
    );

    const env: NodeJS.ProcessEnv = {
      ...input.baseEnv,
      TERM: "xterm-256color",
      LUNA_TURN_ENV_FILE: input.turnEnvFile,
    };

    return {
      command: input.runnerType,
      args,
      env,
      initialSessionId: sessionId,
      hookEventsFile,
    };
  },

  beginTurn(input) {
    const dataDir = claudeDataDir(input.home, input.env);
    const sessionId = input.currentSessionId ?? randomUUID();
    const bridge = new ClaudeTranscriptTurnBridge({
      prompt: input.prompt,
      cwd: input.cwd,
      dataDir,
      cliPid: input.cliPid,
      initialSessionId: sessionId,
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
        const hasImage = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(input.prompt);
        await delay(hasImage ? 600 : 300);

        for (let attempt = 0; attempt < 3; attempt += 1) {
          pty.write("\r");
          const deadline = Date.now() + 800;
          while (Date.now() < deadline) {
            const check = bridge.isSubmittedOrTerminal();
            if (check.submitted) {
              return { submitted: true, sessionId: check.sessionId };
            }
            await delay(80);
          }
        }
        const graceDeadline = Date.now() + 1_500;
        while (Date.now() < graceDeadline) {
          const check = bridge.isSubmittedOrTerminal();
          if (check.submitted) {
            return { submitted: true, sessionId: check.sessionId };
          }
          await delay(100);
        }
        return {
          submitted: false,
          failureReason: "Claude PTY did not record prompt submission in session transcript",
        };
      },
    };
  },

  normalizeExitFailure(message: string) {
    const code = claudeErrorCode(message);
    const failure = normalizeClaudeFailure(message);
    return {
      failure,
      ...(code ? { code } : failure.providerCode ? { code: failure.providerCode } : {}),
    };
  },
};

export { wrapBracketedPaste };
