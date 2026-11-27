import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildCliArgs,
  parseRunnerStreamLine,
  runQuery,
} from "@luna/executor/runner";
import { buildChildEnvironment } from "@luna/executor/job-env";
import { OUTPUT_END_MARKER, OUTPUT_START_MARKER } from "@luna/runner-protocol/stream-parser";

async function captureWorkerOutput(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const originalWrite = process.stdout.write;
  let output = "";
  (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = (
    chunk: string | Uint8Array,
  ): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }

  const events: Array<Record<string, unknown>> = [];
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== OUTPUT_START_MARKER) {
      continue;
    }
    const payload = lines[index + 1];
    if (payload === undefined || lines[index + 2] !== OUTPUT_END_MARKER) {
      continue;
    }
    events.push(JSON.parse(payload) as Record<string, unknown>);
    index += 2;
  }
  return events;
}

function fakeClaudeShellScriptWithoutTrailingNewline(text: string): string {
  const payload = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  });
  return `printf '%s\\n' '${payload}'; printf '%s' '${JSON.stringify({type: "result", is_error: false, result: text})}'`;
}

describe("container agent-runner worker", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not treat Codex reasoning as assistant text", () => {
    expect(
      parseRunnerStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "reasoning-1",
            type: "reasoning",
            text: "private reasoning should not become a task report",
          },
        }),
        "codex",
      ),
    ).toBeNull();
  });

  test("derives Claude tool titles from command subjects", () => {
    expect(
      parseRunnerStreamLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "pwd" },
            }],
          },
        }),
        "claude",
      ),
    ).toEqual({kind: "events", events: [{kind:"tool_start", id:"tool-1", name:"Bash", title:"查看目录"}]});
  });

  test("does not treat tool descriptions as assistant narration", () => {
    expect(
      parseRunnerStreamLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { description: "检查当前目录", command: "pwd" },
            }],
          },
        }),
        "claude",
      ),
    ).toEqual({kind: "events", events: [{kind:"tool_start", id:"tool-1", name:"Bash", title:"检查当前目录"}]});
  });

  test("preserves Codex command execution as a tool event", () => {
    expect(
      parseRunnerStreamLine(
        JSON.stringify({
          type: "item.started",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "ls",
          },
        }),
        "codex",
      ),
    ).toEqual({kind: "events", events: [{kind:"tool_start", id:"cmd-1", name:"Bash", title:"查看目录"}]});
  });

  test("emits stream output for a final unterminated runner line", async () => {
    const originalRunnerHome = process.env.LUNA_RUNNER_HOME;
    process.env.LUNA_RUNNER_HOME = process.cwd();
    let events: Array<Record<string, unknown>>;
    try {
      events = await captureWorkerOutput(() =>
        runQuery({
          runnerType: "/bin/sh",
          prompt: fakeClaudeShellScriptWithoutTrailingNewline("final line"),
        }),
      );
    } finally {
      if (originalRunnerHome === undefined) {
        delete process.env.LUNA_RUNNER_HOME;
      } else {
        process.env.LUNA_RUNNER_HOME = originalRunnerHome;
      }
    }

    expect(events).toContainEqual({ status: "stream", text: "final line" });
    expect(events).toContainEqual({ status: "success", result: "final line" });
  });

  test("rejects worker startup without a complete runner root", async () => {
    const originalRunnerHome = process.env.LUNA_RUNNER_HOME;
    delete process.env.LUNA_RUNNER_HOME;
    try {
      await expect(
        runQuery({ runnerType: "/bin/sh", prompt: "exit 0" }),
      ).rejects.toThrow("LUNA_RUNNER_HOME is required");
    } finally {
      if (originalRunnerHome === undefined) {
        delete process.env.LUNA_RUNNER_HOME;
      } else {
        process.env.LUNA_RUNNER_HOME = originalRunnerHome;
      }
    }
  });

  test("retains container proxy bypasses when a job adds the Luna host", () => {
    const env = buildChildEnvironment(
      { NO_PROXY: "192.0.2.0/24,localhost", no_proxy: "localhost" },
      { NO_PROXY: "host.docker.internal", no_proxy: "host.docker.internal" },
    );
    expect(env.NO_PROXY).toBe("192.0.2.0/24,localhost,host.docker.internal");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  test("emits error when Codex reports a failed turn", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "luna-fake-codex-"));
    tempDirs.push(tempDir);
    const binDir = join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCodex = join(binDir, "codex");
    writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        "cat <<'JSON'",
        JSON.stringify({
          type: "turn.failed",
          error: { message: "model refused task" },
        }),
        "JSON",
        "exit 0",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(fakeCodex, 0o755);

    const originalPath = process.env.PATH;
    const originalRunnerHome = process.env.LUNA_RUNNER_HOME;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.LUNA_RUNNER_HOME = tempDir;
    try {
      const events = await captureWorkerOutput(() =>
        runQuery({
          runnerType: "codex",
          prompt: "do work",
        }),
      );

      expect(events).toContainEqual({
        status: "error",
        error: "model refused task",
        failure: {
          kind: "unknown",
          provider: "codex",
          message: "model refused task",
        },
      });
      expect(events.some((event) => event.status === "success")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      if (originalRunnerHome === undefined) {
        delete process.env.LUNA_RUNNER_HOME;
      } else {
        process.env.LUNA_RUNNER_HOME = originalRunnerHome;
      }
    }
  });

  test("emits a normalized failure when Codex is rate limited", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "luna-fake-codex-rate-limit-"));
    tempDirs.push(tempDir);
    const binDir = join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCodex = join(binDir, "codex");
    writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        "cat <<'JSON'",
        JSON.stringify({
          type: "turn.failed",
          error: { message: "HTTP 429: rate_limit_exceeded" },
        }),
        "JSON",
        "exit 0",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(fakeCodex, 0o755);

    const originalPath = process.env.PATH;
    const originalRunnerHome = process.env.LUNA_RUNNER_HOME;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.LUNA_RUNNER_HOME = tempDir;
    try {
      const events = await captureWorkerOutput(() =>
        runQuery({ runnerType: "codex", prompt: "do work" }),
      );

      expect(events).toContainEqual({
        status: "error",
        error: "HTTP 429: rate_limit_exceeded",
        failure: {
          kind: "rate_limited",
          provider: "codex",
          message: "HTTP 429: rate_limit_exceeded",
          httpStatus: 429,
        },
      });
    } finally {
      process.env.PATH = originalPath;
      if (originalRunnerHome === undefined) {
        delete process.env.LUNA_RUNNER_HOME;
      } else {
        process.env.LUNA_RUNNER_HOME = originalRunnerHome;
      }
    }
  });

  test("emits normalized stale-session error when Codex only writes resume failure to stderr", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "luna-fake-codex-stderr-"));
    tempDirs.push(tempDir);
    const binDir = join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCodex = join(binDir, "codex");
    writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        "echo 'Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)' >&2",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(fakeCodex, 0o755);

    const originalPath = process.env.PATH;
    const originalRunnerHome = process.env.LUNA_RUNNER_HOME;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.LUNA_RUNNER_HOME = tempDir;
    try {
      const events = await captureWorkerOutput(() =>
        runQuery(
          {
            runnerType: "codex",
            prompt: "do work",
          },
          "stale-thread",
        )
      );

      expect(events).toContainEqual({
        status: "stderr",
        text: "Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)",
      });
      expect(events).toContainEqual({
        status: "error",
        error: "Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)",
        exitCode: 1,
        failure: {
          kind: "session_unusable",
          provider: "codex",
          message: "Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)",
          providerCode: "runner_session_not_found",
        },
        code: "runner_session_not_found",
      });
      expect(events.some((event) => event.status === "success")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      if (originalRunnerHome === undefined) {
        delete process.env.LUNA_RUNNER_HOME;
      } else {
        process.env.LUNA_RUNNER_HOME = originalRunnerHome;
      }
    }
  });

  test("emits normalized stale-session error for Claude errors arrays", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "luna-fake-claude-resume-"));
    tempDirs.push(tempDir);
    const binDir = join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeClaude = join(binDir, "claude");
    const message =
      "No conversation found with session ID: stale-claude-session";
    writeFileSync(
      fakeClaude,
      [
        "#!/bin/sh",
        `echo ${JSON.stringify(message)} >&2`,
        "cat <<'JSON'",
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [message],
        }),
        "JSON",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(fakeClaude, 0o755);

    const originalPath = process.env.PATH;
    const originalRunnerHome = process.env.LUNA_RUNNER_HOME;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.LUNA_RUNNER_HOME = tempDir;
    try {
      const events = await captureWorkerOutput(() =>
        runQuery(
          { runnerType: "claude", prompt: "do work" },
          "stale-claude-session",
        )
      );

      expect(events).toContainEqual({
        status: "error",
        error: message,
        failure: {
          kind: "session_unusable",
          provider: "claude",
          message,
          providerCode: "runner_session_not_found",
        },
        code: "runner_session_not_found",
      });
      expect(events.some((event) => event.status === "success")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      if (originalRunnerHome === undefined) {
        delete process.env.LUNA_RUNNER_HOME;
      } else {
        process.env.LUNA_RUNNER_HOME = originalRunnerHome;
      }
    }
  });
});

test("mixed text/tools and an unterminated result survive the worker protocol without exposing inputs", async()=>{
  const previous=process.env.LUNA_RUNNER_HOME;
  process.env.LUNA_RUNNER_HOME=process.cwd();
  try {
    const assistant={type:"assistant",message:{content:[
      {type:"text",text:"正在检查文件"},
      {type:"thinking",thinking:"private reasoning"},
      {type:"tool_use",id:"call-read",name:"Read",input:{file_path:"/private/work/README.md",secret:"private-token"}},
      {type:"tool_use",id:"call-shell",name:"Bash",input:{command:"echo hello"}},
    ]}};
    const result={type:"user",message:{content:[{type:"tool_result",tool_use_id:"call-read",content:"private output"}]}};
    const script=`cat <<'LUNA_TEST_JSON'\n${JSON.stringify(assistant)}\n${JSON.stringify(result)}\nLUNA_TEST_JSON\nprintf '%s' '${JSON.stringify({type:"result",is_error:false,result:"检查完成"})}'`;
    const events=await captureWorkerOutput(()=>runQuery({runnerType:"/bin/sh",prompt:script}));
    expect(events.filter(e=>e.status==="tool_start")).toEqual([
      {status:"tool_start",id:"call-read",name:"Read",title:"读取 README.md"},
      {status:"tool_start",id:"call-shell",name:"Bash",title:"执行 echo hello"},
    ]);
    expect(events).toContainEqual({status:"tool_result",id:"call-read",text:"工具调用已结束"});
    expect(events).toContainEqual({status:"checkpoint"});
    expect(events).toContainEqual({status:"success",result:"检查完成"});
    expect(JSON.stringify(events)).not.toContain("private-token");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(JSON.stringify(events)).not.toContain("private output");
    const {ProviderOutput}=await import("@luna/runner-protocol/events");
    for (const event of events) expect(ProviderOutput.safeParse(event).success).toBe(true);
    const {RunnerOutputState}=await import("../../src/runners/runner-output");
    const output=new RunnerOutputState("session");
    const messages=events.flatMap(event=>output.accept(String(event.status),event));
    expect(messages.filter(m=>m.role==="assistant").flatMap(m=>m.role==="assistant"?m.content:[]).filter(c=>c.type==="tool_use")).toHaveLength(2);
    expect(messages.find(m=>m.role==="tool")).toMatchObject({role:"tool",content:[{type:"tool_result",tool_use_id:"call-read",content:"工具调用已结束"}]});
  } finally { if(previous===undefined)delete process.env.LUNA_RUNNER_HOME;else process.env.LUNA_RUNNER_HOME=previous; }
});
