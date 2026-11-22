import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contentHash, openExecutionDatabase } from "@luna/execution-store";
import { ExecutionClient, TokenAuthority, closeExecutionServer, executionServer, json, readJson, requirePeer } from "@luna/execution-transport";
import type { Assignment, ExecutorEvent, JobRequest, ProviderOutput } from "@luna/runner-protocol";
import { resolveAccessToken, resolveTurnLunaEnv } from "@luna/cli-support/env";
import { unifiedServiceHeaders } from "@luna/cli-support/service-client";
import { createExecutor } from "@luna/executor/executor/server";
import {
  ClaudeTranscriptTurnBridge,
  claudeProjectSlug,
  resolveClaudeTranscriptPath,
  seedClaudeTrustState,
} from "@luna/executor/pty/claude-pty-adapter";
import { CodexRolloutTurnBridge, codexPtyAdapter } from "@luna/executor/pty/codex-pty-adapter";
import { PtyIdleDetector } from "@luna/executor/pty/idle-detector";
import { PtySessionController } from "@luna/executor/pty/pty-session";
import { HeadlessViewport } from "@luna/executor/pty/viewport";
import type { PtyCliAdapter } from "@luna/executor/pty/types";
import { ActiveAgentConfigService, AgentProfileStore, AgentSecretCipher } from "../../src/agent-config";
import { executionReference } from "../../src/agent-config/execution-reference";
import { ContainerConsoleSession, type ContainerConsoleSocketData } from "../../src/server/container-console";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { RuntimeEventStore } from "../../src/runtime/event-store";
import { SchedulerStore } from "../../src/runtime/scheduler-store";
import { reloadConfig, setLunaHome } from "../../src/shared/config";
import { fixtureJobScope } from "../helpers/job-scope";
import { fixtureScope } from "../helpers/platform-fixtures";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("LUNA_TURN_ENV_FILE dynamic credential overlay", () => {
  test("overlays per-turn LUNA_* credentials and blocks symlinks or forbidden keys", () => {
    const root = makeTempDir("luna-turn-env-");
    const turnFile = join(root, "turn-env.json");
    writeFileSync(
      turnFile,
      JSON.stringify({
        LUNA_ACCESS_TOKEN: "turn-token-2",
        LUNA_INVOCATION_ID: "inv-2",
        LUNA_SESSION_ID: "sess-2",
        LUNA_ACTOR_KIND: "runner",
        LUNA_ACTOR_ID: "ctx-1",
        LUNA_HOME: "/evil/home",
        PATH: "/evil/bin",
      }),
      { mode: 0o600 },
    );

    const baseEnv = {
      HOME: root,
      LUNA_HOME: join(root, ".luna"),
      LUNA_ACCESS_TOKEN: "stale-token-1",
      LUNA_TURN_ENV_FILE: turnFile,
    };

    const resolved = resolveTurnLunaEnv(baseEnv);
    expect(resolved.LUNA_ACCESS_TOKEN).toBe("turn-token-2");
    expect(resolved.LUNA_INVOCATION_ID).toBe("inv-2");
    expect(resolved.LUNA_HOME).toBe(join(root, ".luna"));
    expect((resolved as Record<string, string | undefined>).PATH).toBeUndefined();
    expect(resolveAccessToken(baseEnv)).toBe("turn-token-2");

    const headers = unifiedServiceHeaders(baseEnv);
    expect(headers.get("authorization")).toBe("Bearer turn-token-2");
    expect(headers.get("x-luna-session-id")).toBe("sess-2");

    // Unlinking the turn file immediately revokes the overlay.
    rmSync(turnFile, { force: true });
    expect(resolveTurnLunaEnv({ HOME: root, LUNA_TURN_ENV_FILE: turnFile }).LUNA_ACCESS_TOKEN).toBeUndefined();

    // Symlinked turn-env file must be rejected.
    const realTarget = join(root, "real.json");
    writeFileSync(realTarget, JSON.stringify({ LUNA_ACCESS_TOKEN: "hijacked" }));
    const linkPath = join(root, "link-env.json");
    symlinkSync(realTarget, linkPath);
    expect(resolveTurnLunaEnv({ LUNA_TURN_ENV_FILE: linkPath }).LUNA_ACCESS_TOKEN).toBeUndefined();
  });
});

describe("ClaudeTranscriptTurnBridge & CodexRolloutTurnBridge", () => {
  test("handles partial JSONL writes, thinking+text multi-block stop_reason, tool checkpoints, and rate limits", () => {
    const root = makeTempDir("luna-claude-bridge-");
    const cwd = join(root, "workspace");
    const dataDir = join(root, ".claude");
    mkdirSync(cwd, { recursive: true });
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const transcriptPath = resolveClaudeTranscriptPath(sessionId, cwd, dataDir);
    mkdirSync(join(dataDir, "projects", claudeProjectSlug(cwd)), { recursive: true });

    seedClaudeTrustState(root, cwd, {});
    const stateJson = JSON.parse(Bun.file(join(root, ".claude.json")).size ? require("node:fs").readFileSync(join(root, ".claude.json"), "utf8") : "{}");
    expect(stateJson.hasCompletedOnboarding).toBe(true);

    const bridge = new ClaudeTranscriptTurnBridge({
      prompt: "Run status check",
      cwd,
      dataDir,
      cliPid: 0,
      initialSessionId: sessionId,
    });

    // 1. Half-written user line (no newline yet) must not advance or emit.
    const userLine = JSON.stringify({
      type: "user",
      sessionId,
      message: { role: "user", content: "Run status check" },
    });
    appendFileSync(transcriptPath, userLine.slice(0, 20));
    expect(bridge.drain().submitConfirmed).toBe(false);

    // Complete the user line + tool_use + tool_result.
    appendFileSync(transcriptPath, `${userLine.slice(20)}\n`);
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Checking now..." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status" } },
          ],
        },
      })}\n` +
      `${JSON.stringify({
        type: "user",
        sessionId,
        isMeta: true,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false }],
        },
      })}\n`,
    );

    const mid = bridge.drain();
    expect(mid.submitConfirmed).toBe(true);
    expect(mid.terminal).toBeUndefined();
    expect(mid.outputs).toEqual([
      { status: "init", sessionId },
      { status: "tool_start", id: "toolu_1", name: "Bash", title: expect.stringContaining("git status") },
      { status: "stream", text: "Checking now..." },
      { status: "tool_result", id: "toolu_1", text: "工具调用已结束" },
      { status: "checkpoint" },
    ]);

    // 2. Thinking block stamped with stop_reason="end_turn" arrives BEFORE text block and turn_duration:
    //    must NOT prematurely close the turn with empty text before settle!
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "thinking", thinking: "Internal reasoning" }],
        },
      })}\n`,
    );
    expect(bridge.drain().terminal).toBeUndefined();

    // Now the visible text block + system/turn_duration land.
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "All checks green." }],
        },
      })}\n` +
      `${JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 420 })}\n`,
    );

    const done = bridge.drain();
    expect(done.outputs).toEqual([{ status: "stream", text: "All checks green." }]);
    expect(done.terminal).toEqual({ kind: "completed", finalText: "All checks green." });
  });

  test("drains Codex history.jsonl + rollout task_complete and normalizes tool calls", async () => {
    const root = makeTempDir("luna-codex-bridge-");
    const codexHome = join(root, ".codex");
    const rolloutDir = join(codexHome, "sessions", "2026", "11", "19");
    mkdirSync(rolloutDir, { recursive: true });

    const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const historyPath = join(codexHome, "history.jsonl");
    const rolloutPath = join(rolloutDir, `rollout-2026-11-19T21-00-00-${sid}.jsonl`);

    const spec = await codexPtyAdapter.prepareSpawn({
      runnerType: "codex",
      cwd: root,
      home: root,
      model: "gpt-5",
      baseEnv: {
        CODEX_PROVIDER_MODE: "gateway",
        OPENAI_BASE_URL: "https://gateway.example.test/v1",
        OPENAI_API_KEY: "sk-test",
      },
      controlDir: join(root, "ctrl"),
      turnEnvFile: "/tmp/luna-pty-test/turn-env.json",
    });
    expect(spec.args).toContain("--no-daemon");
    expect(spec.args).toContain("--no-alt-screen");
    expect(spec.args.join(" ")).toContain("LUNA_TURN_ENV_FILE");

    // In gateway mode, auth.json is not seeded.
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);

    // In direct API-key mode on a fresh home, prepareSpawn creates CODEX_HOME and seeds auth.json.
    const directHome = makeTempDir("luna-codex-direct-");
    await codexPtyAdapter.prepareSpawn({
      runnerType: "codex",
      cwd: directHome,
      home: directHome,
      model: "gpt-5",
      baseEnv: { OPENAI_API_KEY: "sk-direct-key-123" },
      controlDir: join(directHome, "ctrl"),
      turnEnvFile: "/tmp/luna-pty-test/turn-env.json",
    });
    expect(JSON.parse(readFileSync(join(directHome, ".codex", "auth.json"), "utf8"))).toEqual({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-direct-key-123",
    });

    // Claude state seeding sets onboarding, bypassPermissionsModeAccepted, and API key approval suffix.
    const claudeHome = makeTempDir("luna-claude-seed-");
    seedClaudeTrustState(claudeHome, claudeHome, {
      ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    });
    const claudeState = JSON.parse(readFileSync(join(claudeHome, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(claudeState.hasCompletedOnboarding).toBe(true);
    expect(claudeState.bypassPermissionsModeAccepted).toBe(true);
    expect(claudeState.customApiKeyResponses).toEqual({
      approved: ["ghijklmnopqrstuvwxyz"],
      rejected: [],
    });

    const bridge = new CodexRolloutTurnBridge({
      prompt: "Summarize repo",
      codexHome,
      cliPid: 0,
    });

    appendFileSync(historyPath, `${JSON.stringify({ session_id: sid, text: "Summarize repo" })}\n`);
    appendFileSync(
      rolloutPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: sid } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call", call_id: "call_1", name: "shell_command", arguments: JSON.stringify({ command: "ls -la" }) },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_1", output: JSON.stringify({ exit_code: 0, output: "ok" }) },
        }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Drafting summary..." } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "Repo has 3 packages." } }),
      ].join("\n") + "\n",
    );

    const drained = bridge.drain();
    expect(drained.submitConfirmed).toBe(true);
    expect(drained.observedSessionId).toBe(sid);
    expect(drained.outputs).toEqual([
      { status: "init", sessionId: sid },
      { status: "tool_start", id: "call_1", name: "Bash", title: expect.stringContaining("ls -la") },
      { status: "tool_result", id: "call_1", text: "工具调用已结束" },
      { status: "checkpoint" },
      { status: "stream", text: "Drafting summary..." },
    ]);
    expect(drained.terminal).toEqual({ kind: "completed", finalText: "Repo has 3 packages." });
  });
});

describe("HeadlessViewport & PtyIdleDetector", () => {
  test("vetoes idle while Claude busy footer is rendered on screen and fires once cleared", async () => {
    const viewport = new HeadlessViewport(120, 24);
    let nowMs = 1_000;
    let idleCount = 0;
    const detector = new PtyIdleDetector(
      {
        readyPattern: /❯/,
        busyPattern: /^\s*(?:[⏵⏸]+\s.*\bon\b|.*next try).*·\s*esc to interrupt\b/m,
        quiescenceMs: 40,
        spinnerGuardMs: 60,
        now: () => nowMs,
      },
      () => ({
        full: viewport.readViewport(),
        bottom: viewport.readBottomProbeRegion(),
      }),
    );
    detector.onIdle(() => { idleCount += 1; });

    const busyFrame = "❯ working...\r\n⏵⏵ bypass permissions on · esc to interrupt ·\r\n";
    viewport.feed(busyFrame);
    await viewport.flush();
    detector.feed(busyFrame);
    await delay(100);
    expect(idleCount).toBe(0);

    // Clear the line and render the idle footer.
    nowMs += 5_000;
    const idleFrame = "\x1b[2J\x1b[H❯ \r\n⏵⏵ bypass permissions on (shift+tab to cycle)\r\n";
    viewport.feed(idleFrame);
    await viewport.flush();
    detector.feed(idleFrame);
    await delay(100);
    expect(idleCount).toBe(1);

    detector.dispose();
    viewport.dispose();
  });
});

describe("PtySessionController with real Bun PTY subprocess", () => {
  test("keeps CLI warm across turns, rotates LUNA_TURN_ENV_FILE per turn, settles late transcript flushes, and reaps on idle", async () => {
    const root = makeTempDir("luna-real-pty-");
    const home = join(root, "home");
    const cwd = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    // Real interactive TUI simulator running inside a real Bun PTY:
    // - Renders ANSI prompt `❯ `
    // - Reads bracketed paste + CR from TTY stdin
    // - Reads LUNA_TURN_ENV_FILE dynamically on each turn (proving per-turn token rotation!)
    // - Fires Stop hook BEFORE flushing the closing JSONL record (testing TranscriptTerminalSettle!)
    const fakeCliScript = join(root, "fake-interactive-claude.ts");
    writeFileSync(
      fakeCliScript,
      `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const sidIdx = args.indexOf("--session-id");
const resumeIdx = args.indexOf("--resume");
const sessionId = sidIdx >= 0 ? args[sidIdx + 1] : (resumeIdx >= 0 ? args[resumeIdx + 1] : "default-sid");
const hookFile = process.env.FAKE_HOOK_FILE!;
const transcriptPath = process.env.FAKE_TRANSCRIPT_PATH!;
mkdirSync(dirname(transcriptPath), { recursive: true });
mkdirSync(dirname(hookFile), { recursive: true });

process.stdout.write("\\x1b[32mFake Interactive CLI v1\\x1b[0m\\r\\n❯ ");
appendFileSync(hookFile, JSON.stringify({ event: "SessionStart" }) + "\\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  if (chunk.includes("\\x03")) {
    buf = "";
    process.stdout.write("\\r\\nInterrupted\\r\\n❯ ");
    return;
  }
  if (!buf.includes("\\r") && !buf.includes("\\n")) return;
  const cleaned = buf
    .replace(/\\x1b\\[200~/g, "")
    .replace(/\\x1b\\[201~/g, "")
    .replace(/[\\r\\n]+$/g, "");
  buf = "";
  if (!cleaned.trim()) return;

  const turnEnvRaw = process.env.LUNA_TURN_ENV_FILE ? readFileSync(process.env.LUNA_TURN_ENV_FILE, "utf8") : "{}";
  const turnEnv = JSON.parse(turnEnvRaw);

  appendFileSync(transcriptPath, JSON.stringify({
    type: "user",
    sessionId,
    message: { role: "user", content: cleaned },
  }) + "\\n");

  if (cleaned.includes("SLOW_HANG")) {
    process.stdout.write("\\r\\n⏵⏵ bypass permissions on · esc to interrupt\\r\\n");
    return;
  }

  // Fire Stop hook 120ms BEFORE writing the final assistant + turn_duration records
  // to prove TranscriptTerminalSettle prevents premature empty completion!
  process.stdout.write("\\r\\n❯ ");
  appendFileSync(hookFile, JSON.stringify({ event: "Stop" }) + "\\n");

  setTimeout(() => {
    const reply = \`pid=\${process.pid} token=\${turnEnv.LUNA_ACCESS_TOKEN} inv=\${turnEnv.LUNA_INVOCATION_ID} echo=\${cleaned}\`;
    appendFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      sessionId,
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: reply }] },
    }) + "\\n");
    appendFileSync(transcriptPath, JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      durationMs: 50,
    }) + "\\n");
  }, 120);
});
`,
      { mode: 0o755 },
    );
    chmodSync(fakeCliScript, 0o755);

    const fixedSessionId = "22222222-3333-4444-8555-666666666666";
    const dataDir = join(home, ".claude");
    const transcriptPath = resolveClaudeTranscriptPath(fixedSessionId, cwd, dataDir);

    const testAdapter: PtyCliAdapter = {
      family: "claude",
      idleConfig: { readyPattern: /❯/, quiescenceMs: 100, spinnerGuardMs: 100 },
      async prepareSpawn(specInput) {
        const sid = specInput.resumeSessionId ?? fixedSessionId;
        const hookEventsFile = join(specInput.controlDir, "hooks.jsonl");
        return {
          command: process.execPath,
          args: [fakeCliScript, ...(specInput.resumeSessionId ? ["--resume", sid] : ["--session-id", sid])],
          env: {
            ...specInput.baseEnv,
            TERM: "xterm-256color",
            LUNA_TURN_ENV_FILE: specInput.turnEnvFile,
            FAKE_HOOK_FILE: hookEventsFile,
            FAKE_TRANSCRIPT_PATH: transcriptPath,
          },
          initialSessionId: sid,
          hookEventsFile,
        };
      },
      beginTurn(turnInput) {
        const bridge = new ClaudeTranscriptTurnBridge({
          prompt: turnInput.prompt,
          cwd: turnInput.cwd,
          dataDir,
          cliPid: 0,
          initialSessionId: turnInput.currentSessionId ?? fixedSessionId,
        });
        return {
          bridge,
          async submit(pty) {
            pty.write(`\x1b[200~${turnInput.prompt}\x1b[201~`);
            await delay(40);
            pty.write("\r");
            const deadline = Date.now() + 1_500;
            while (Date.now() < deadline) {
              if (bridge.isSubmittedOrTerminal().submitted) {
                return { submitted: true, sessionId: fixedSessionId };
              }
              await delay(30);
            }
            return { submitted: false, failureReason: "submit timeout" };
          },
        };
      },
      normalizeExitFailure(message) {
        return { failure: { kind: "unknown", provider: "claude", message } };
      },
    };

    let idleExpired = false;
    const controller = new PtySessionController({
      runnerType: "claude",
      cwd,
      home,
      staticEnv: { HOME: home, PATH: process.env.PATH ?? "" },
      idleTimeoutMs: 350,
      adapter: testAdapter,
      onIdleExpired: () => { idleExpired = true; },
    });

    try {
      // Turn 1: cold start
      const turn1Outputs: ProviderOutput[] = [];
      const turn1 = await controller.runTurn({
        prompt: "hello turn one",
        turnEnv: { LUNA_ACCESS_TOKEN: "tok-1", LUNA_INVOCATION_ID: "inv-1" },
        onOutput: (out) => turn1Outputs.push(out),
      });
      expect(turn1.outcome).toBe("succeeded");
      const turn1Success = turn1Outputs.find((o): o is Extract<ProviderOutput, { status: "success" }> => o.status === "success");
      expect(turn1Success?.result).toContain("token=tok-1 inv=inv-1 echo=hello turn one");
      // Turn env file MUST be wiped immediately after turn settles!
      expect(existsSync(controller.getTurnEnvFilePath())).toBe(false);
      expect(controller.isAlive()).toBe(true);
      const pid1 = /pid=(\d+)/.exec(turn1Success!.result)?.[1];
      expect(pid1).toBeDefined();

      // Turn 2: warm reuse (same PID!) + rotated LUNA_ACCESS_TOKEN!
      const turn2Outputs: ProviderOutput[] = [];
      const turn2 = await controller.runTurn({
        prompt: "hello turn two",
        turnEnv: { LUNA_ACCESS_TOKEN: "tok-2", LUNA_INVOCATION_ID: "inv-2" },
        onOutput: (out) => turn2Outputs.push(out),
      });
      expect(turn2.outcome).toBe("succeeded");
      const turn2Success = turn2Outputs.find((o): o is Extract<ProviderOutput, { status: "success" }> => o.status === "success");
      expect(turn2Success?.result).toContain(`pid=${pid1} token=tok-2 inv=inv-2 echo=hello turn two`);

      // Turn 3: mid-turn cancellation wipes turn-env immediately and returns cancelled
      const turn3Promise = controller.runTurn({
        prompt: "SLOW_HANG",
        turnEnv: { LUNA_ACCESS_TOKEN: "tok-3", LUNA_INVOCATION_ID: "inv-3" },
        onOutput: () => {},
      });
      await delay(150);
      controller.cancelActiveTurn();
      expect(existsSync(controller.getTurnEnvFilePath())).toBe(false);
      const turn3 = await turn3Promise;
      expect(turn3.outcome).toBe("cancelled");

      // Wait for idle reaper to expire (350ms) and verify cleanup
      const reapDeadline = Date.now() + 2_000;
      while (!idleExpired && Date.now() < reapDeadline) {
        await delay(50);
      }
      expect(idleExpired).toBe(true);
      expect(controller.isAlive()).toBe(false);
    } finally {
      await controller.close();
    }
  });
});

describe("AgentProfileStore & ActiveAgentConfigService executionDriver persistence", () => {
  test("persists executionDriver=pty across SQLite migrations and pins it in AgentExecutionReference", () => {
    const home = makeTempDir("luna-pty-profile-db-");
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "config.yaml"), "{}\n");
    setLunaHome(home);
    reloadConfig();

    const connection = new DataConnection(schema);
    try {
      const cipher = AgentSecretCipher.fromEnvironment({
        LUNA_AGENT_CONFIG_MASTER_KEY: randomBytes(32).toString("base64"),
      });
      const scope = fixtureScope(connection.db);
      const store = new AgentProfileStore(connection.db, cipher, scope.agentId);
      const active = new ActiveAgentConfigService(connection.db, cipher);

      const created = store.createProfile({
        name: "Claude PTY",
        agentType: "claude",
        model: "claude-sonnet-4-6",
        executionDriver: "pty",
        env: { ANTHROPIC_BASE_URL: "https://api.example.test" },
        secrets: { ANTHROPIC_API_KEY: { set: "sk-ant-secret" } },
        actorId: "fixture-owner",
      });
      expect(created.latestRevision.executionDriver).toBe("pty");

      store.recordValidation(created.latestRevision.id, { success: true, message: "ok" });
      const snapshot = active.activate(scope.agentId, created.latestRevision.id, "fixture-owner");
      expect(snapshot.executionDriver).toBe("pty");

      const ref = executionReference(snapshot);
      expect(ref.executionDriver).toBe("pty");
      const resolvedPinned = active.resolvePinnedSnapshot(scope.agentId, ref);
      expect(resolvedPinned.executionDriver).toBe("pty");
    } finally {
      connection.close();
    }
  });
});

describe("Executor HTTP integration with PtyContextPool and Linux subreaper", () => {
  test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "reuses unprivileged warm PTY host across turns, rotates tokens, and recycles host when privileged changes",
    async () => {
      const root = makeTempDir("luna-exec-pty-");
      chmodSync(root, 0o755);
      const db = openExecutionDatabase(join(root, "executor.sqlite"));
      const runtimeDb = openExecutionDatabase(join(root, "runtime.sqlite"));
      const grants = new TokenAuthority();
      const runtimeGrants = new TokenAuthority(runtimeDb);
      const control = grants.issue("runtime-control", { role: "runtime", id: "runtime1" });
      const maintenance = grants.issue("worker-control", { role: "worker", id: "worker1" });
      const upload = runtimeGrants.issue("instance-upload", { role: "executor", id: "instance1" });
      const scheduler = new SchedulerStore(runtimeDb);
      const events = new RuntimeEventStore(runtimeDb);

      const receiver = executionServer(runtimeGrants, async ({ peer, request, response, url }) => {
        requirePeer(peer, "executor", "instance1");
        const match = /^\/v1\/ingest\/jobs\/([^/]+)\/events$/.exec(url.pathname);
        if (!match) throw new Error("Unexpected route");
        events.ingest(match[1]!, peer.id, await readJson(request, 16 * 1024 * 1024));
        json(response, 204);
      });
      await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
      const receiverAddr = receiver.address();
      if (!receiverAddr || typeof receiverAddr === "string") throw new Error("No receiver port");
      const endpoint = `http://127.0.0.1:${receiverAddr.port}`;

      // Fake Claude binary placed on PATH (`$HOME/.local/bin/claude`) so real `pty-main.ts` + `claudePtyAdapter`
      // drives a real Bun PTY inside `job-process.ts` (`PR_SET_CHILD_SUBREAPER` + `setpriv` UID 1000)!
      const executor = createExecutor(db, grants, {
        scope: fixtureJobScope().scope,
        instanceId: "instance1",
        runtimeId: "runtime1",
        workerId: "worker1",
        dataRoot: join(root, "data"),
        runnerEntry: join(root, "unused-stdio.js"),
        runtimeEndpoint: endpoint,
        capacity: 2,
        runnerSudo: true,
      });
      await new Promise<void>((resolve) => executor.server.listen(0, "127.0.0.1", resolve));
      const execAddr = executor.server.address();
      if (!execAddr || typeof execAddr === "string") throw new Error("No executor port");
      const client = new ExecutionClient(`http://127.0.0.1:${execAddr.port}`, control);
      const worker = new ExecutionClient(`http://127.0.0.1:${execAddr.port}`, maintenance);

      const ctx = executor.contexts.provision("pty-ctx");
      const localBin = join(ctx.home, ".local", "bin");
      mkdirSync(localBin, { recursive: true });
      const fakeClaudeBin = join(localBin, "claude");
      writeFileSync(
        fakeClaudeBin,
        `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const settingsIdx = argv.indexOf("--settings");
const settings = settingsIdx >= 0 ? JSON.parse(readFileSync(argv[settingsIdx + 1], "utf8")) : {};
const sidIdx = argv.indexOf("--session-id");
const resumeIdx = argv.indexOf("--resume");
const sessionId = sidIdx >= 0 ? argv[sidIdx + 1] : (resumeIdx >= 0 ? argv[resumeIdx + 1] : "sid-fallback");
const slug = realpathSync(process.cwd()).replace(/[^A-Za-z0-9-]/g, "-");
const dataDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME!, ".claude");
const transcriptPath = join(dataDir, "projects", slug, \`\${sessionId}.jsonl\`);
mkdirSync(dirname(transcriptPath), { recursive: true });

function fireHook(name: string) {
  const cmd = settings?.hooks?.[name]?.[0]?.hooks?.[0]?.command;
  if (cmd) execSync(cmd, { stdio: "ignore" });
}

process.stdout.write("Claude Interactive Mock\\r\\n❯ ");
fireHook("SessionStart");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  if (!buf.includes("\\r") && !buf.includes("\\n")) return;
  const prompt = buf.replace(/\\x1b\\[200~/g, "").replace(/\\x1b\\[201~/g, "").replace(/[\\r\\n]+$/g, "");
  buf = "";
  if (!prompt.trim()) return;

  const turnEnv = process.env.LUNA_TURN_ENV_FILE && existsSync(process.env.LUNA_TURN_ENV_FILE)
    ? JSON.parse(readFileSync(process.env.LUNA_TURN_ENV_FILE, "utf8"))
    : {};
  const status = readFileSync("/proc/self/status", "utf8");
  const noNewPrivs = /^NoNewPrivs:\\s*(\\d+)/m.exec(status)?.[1] ?? "?";
  const reply = \`cliPid=\${process.pid};uid=\${process.getuid()};nnp=\${noNewPrivs};tok=\${turnEnv.LUNA_ACCESS_TOKEN};prompt=\${prompt}\`;

  appendFileSync(transcriptPath, JSON.stringify({ type: "user", sessionId, message: { role: "user", content: prompt } }) + "\\n");
  appendFileSync(transcriptPath, JSON.stringify({
    type: "assistant",
    sessionId,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: reply }] },
  }) + "\\n");
  appendFileSync(transcriptPath, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 10 }) + "\\n");
  process.stdout.write("\\r\\n" + reply + "\\r\\n❯ ");
  fireHook("Stop");
});
`,
        { mode: 0o755 },
      );
      chownSync(ctx.home, ctx.uid, ctx.gid);
      chownSync(localBin, ctx.uid, ctx.gid);
      chownSync(fakeClaudeBin, ctx.uid, ctx.gid);

      async function runPtyJob(jobId: string, prompt: string, opts: { resume?: string | undefined; privileged?: boolean } = {}) {
        const job: JobRequest = {
          version: 2,
          ...fixtureJobScope(),
          jobId,
          invocationId: `inv_${jobId}`,
          environmentId: "luna",
          runnerContextId: "pty-ctx",
          scopeKey: "session:pty-ctx",
          runnerKind: "main",
          sessionId: "session_pty",
          rootAccess: true,
          ...(opts.privileged ? { privileged: true } : {}),
          input: {
            runnerType: "claude",
            executionDriver: "pty",
            prompt,
            ...(opts.resume ? { sessionId: opts.resume } : {}),
          },
          credentialsRevision: 1,
          timeoutMs: 20_000,
        };
        scheduler.submit(job);
        const reserved = scheduler.reserve(jobId, "worker1");
        const assignment: Assignment = {
          scope: job.scope,
          jobId,
          assignmentId: reserved.assignmentId!,
          instanceId: "instance1",
          workerId: "worker1",
          executionEnvironmentId: "env1",
          contextId: "pty-ctx",
          scopeKey: job.scopeKey,
          requestHash: contentHash(job),
          reservationId: `res_${jobId}`,
        };
        scheduler.bind(jobId, assignment);
        await worker.call("PUT", "/v1/contexts/pty-ctx", { scope: job.scope });
        await client.call("POST", "/v1/contexts", { scope: job.scope, contextId: "pty-ctx" });
        await worker.call("PUT", `/v1/reservations/${assignment.reservationId}`, assignment);
        await client.call("POST", "/v1/jobs", { job, assignment });
        await client.call("PUT", `/v1/jobs/${jobId}/credentials`, {
          assignment,
          credentials: {
            revision: 1,
            expiresAt: Date.now() + 60_000,
            env: { LUNA_ACCESS_TOKEN: `tok-${jobId}`, LUNA_SERVICE_URL: "http://service.test" },
          },
        });

        const deadline = Date.now() + 15_000;
        while (executor.store.snapshot(jobId).state !== "succeeded" && Date.now() < deadline) {
          if (["failed", "cancelled", "interrupted"].includes(executor.store.snapshot(jobId).state)) {
            throw new Error(`Job ${jobId} ended unexpectedly: ${JSON.stringify(executor.store.snapshot(jobId))}`);
          }
          await delay(50);
        }
        return executor.store.snapshot(jobId);
      }

      try {
        await executor.start();
        await client.call("PUT", "/v1/ingest-credentials", { credentialId: "instance-upload", token: upload, runtimeId: "runtime1" });

        // Job 1 (unprivileged -> NoNewPrivs=1)
        const snap1 = await runPtyJob("pty1", "turn-one", { privileged: false });
        expect(snap1.state).toBe("succeeded");
        expect(snap1.finalText).toContain("uid=1000;nnp=1;tok=tok-pty1;prompt=turn-one");
        const pid1 = /cliPid=(\d+)/.exec(snap1.finalText!)?.[1];
        expect(pid1).toBeDefined();
        expect(snap1.providerSessionId).toBeDefined();

        // Job 2 (same privilege + matching resume -> warm reuse of exact same CLI PID + rotated token!)
        const snap2 = await runPtyJob("pty2", "turn-two", { resume: snap1.providerSessionId, privileged: false });
        expect(snap2.state).toBe("succeeded");
        expect(snap2.finalText).toContain(`cliPid=${pid1};uid=1000;nnp=1;tok=tok-pty2;prompt=turn-two`);

        // Job 3 (privileged=true -> NoNewPrivs=0 -> MUST recycle host!)
        const snap3 = await runPtyJob("pty3", "turn-three", { resume: snap2.providerSessionId, privileged: true });
        expect(snap3.state).toBe("succeeded");
        expect(snap3.finalText).toContain("uid=1000;nnp=0;tok=tok-pty3;prompt=turn-three");
        const pid3 = /cliPid=(\d+)/.exec(snap3.finalText!)?.[1];
        expect(pid3).not.toBe(pid1);

        // Job 4 (back to privileged=false -> NoNewPrivs=1 -> MUST recycle again so untrusted turn never inherits sudo!)
        const snap4 = await runPtyJob("pty4", "turn-four", { resume: snap3.providerSessionId, privileged: false });
        expect(snap4.state).toBe("succeeded");
        expect(snap4.finalText).toContain("uid=1000;nnp=1;tok=tok-pty4;prompt=turn-four");
        const pid4 = /cliPid=(\d+)/.exec(snap4.finalText!)?.[1];
        expect(pid4).not.toBe(pid3);

        // Verify /v1/pty-sessions and live replay stream on the warm PTY host!
        const listed = await worker.call<{ sessions: Array<{ contextId: string; busy: boolean }> }>("GET", "/v1/pty-sessions");
        expect(listed.sessions).toHaveLength(1);
        expect(listed.sessions[0]?.contextId).toBe("pty-ctx");
        expect(listed.sessions[0]?.busy).toBe(false);

        const abortStream = new AbortController();
        const streamRes = await worker.open("GET", "/v1/pty-sessions/pty-ctx/stream", undefined, abortStream.signal);
        expect(streamRes.statusCode).toBe(200);
        const firstChunk = await new Promise<Buffer>((resolve) => {
          streamRes.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
        });
        expect(firstChunk.toString("utf8")).toContain("❯");
        abortStream.abort();
      } finally {
        await executor.stop();
        await closeExecutionServer(executor.server);
        await closeExecutionServer(receiver);
        db.close();
        runtimeDb.close();
      }
    },
    30_000,
  );
});

describe("HeadlessViewport ANSI snapshot serialization", () => {
  test("preserves scrollback, active screen, CJK glyphs, colors, and cursor across >500 KiB of differential spinner updates", async () => {
    const src = new HeadlessViewport(120, 36, 1500);
    // Emit 80 scrollback + command output lines with ANSI colors and CJK text.
    for (let i = 1; i <= 80; i += 1) {
      src.feed(`\x1b[32m[cmd-${i}]\x1b[0m 检查鸿蒙与 iOS 构建状态 line-${i}\r\n`);
    }
    src.feed("\x1b[30;1H\x1b[1;36m• Running bytedcli bits client workflow job get...\x1b[0m");
    src.feed("\x1b[32;5H\x1b[2m+25 lines (^t to view transcript)\x1b[0m");

    // Simulate >500 KiB of differential ratatui spinner updates that previously evicted a 256 KiB raw byte buffer.
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let chunk = "";
    for (let tick = 0; tick < 6000; tick += 1) {
      const f = frames[tick % frames.length]!;
      chunk += `\x1b]0;${f} 跟进 Bits MR 8625303\x07\x1b[?2026h\x1b[34;1H${f} Waiting (${tick}s)\x1b[35;3H\x1b[?2026l`;
      if (chunk.length >= 16384) {
        src.feed(chunk);
        chunk = "";
      }
    }
    if (chunk) src.feed(chunk);
    await src.flush();

    const snapshot = src.serializeAnsi();
    const dst = new HeadlessViewport(120, 36, 1500);
    dst.feed(snapshot);
    await dst.flush();

    expect(dst.readViewport()).toBe(src.readViewport());
    expect(dst.readViewport()).toContain("Running bytedcli bits client workflow job get");
    expect(dst.readViewport()).toContain("+25 lines (^t to view transcript)");
    expect(dst.readViewport()).toContain("Waiting (5999s)");
    // Scrollback history is also preserved in the serialized snapshot.
    expect(snapshot.toString("utf8")).toContain("检查鸿蒙与 iOS 构建状态 line-1");
    expect(snapshot.toString("utf8")).toContain("\x1b[0;32m[cmd-1]\x1b[0m");

    src.dispose();
    dst.dispose();
  });
});

describe("ContainerConsoleSession TUI read-only & takeover gating", () => {
  test("blocks keystrokes in read-only PTY mode while forwarding viewport resizes, and enables keystrokes when mode writable=true", () => {
    const writes: Uint8Array[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    let openedRequest: Record<string, unknown> | undefined;

    const fakeGateway = {
      openStream(_workerId: string, request: Record<string, unknown>) {
        openedRequest = request;
        return {
          write: (bytes: Uint8Array) => { writes.push(bytes); },
          resize: (cols: number, rows: number) => { resizes.push({ cols, rows }); },
          close: () => {},
        };
      },
    } as unknown as ConstructorParameters<typeof ContainerConsoleSession>[0];

    const session = new ContainerConsoleSession(fakeGateway, {
      accountId: "acc-1",
      agentId: "agent-1",
      shadowId: "shadow-1",
      workerId: "local",
      environmentId: "env-1",
      kind: "pty",
      user: "runner",
      cols: 120,
      rows: 40,
      contextId: "ctx-1",
    });

    const fakeWs = {
      send: () => 1,
      close: () => {},
    } as unknown as import("bun").ServerWebSocket<ContainerConsoleSocketData>;

    session.open(fakeWs);
    expect(openedRequest?.kind).toBe("pty");
    expect(openedRequest?.contextId).toBe("ctx-1");

    // Read-only by default: binary input is blocked, while viewport resize frames pass through.
    session.message(fakeWs, Buffer.from("ls\r"));
    session.message(fakeWs, JSON.stringify({ type: "resize", cols: 140, rows: 45 }));
    expect(writes).toHaveLength(0);
    expect(resizes).toEqual([{ cols: 140, rows: 45 }]);

    // Take input control: binary input and resize frames both pass through.
    session.message(fakeWs, JSON.stringify({ type: "mode", writable: true }));
    session.message(fakeWs, Buffer.from("pwd\r"));
    session.message(fakeWs, JSON.stringify({ type: "resize", cols: 150, rows: 48 }));
    expect(writes).toHaveLength(1);
    expect(Buffer.from(writes[0]!).toString("utf8")).toBe("pwd\r");
    expect(resizes).toEqual([{ cols: 140, rows: 45 }, { cols: 150, rows: 48 }]);

    // Release input control: subsequent keystrokes are blocked again.
    session.message(fakeWs, JSON.stringify({ type: "mode", writable: false }));
    session.message(fakeWs, Buffer.from("rm -rf\r"));
    expect(writes).toHaveLength(1);
    session.closed();
  });
});
