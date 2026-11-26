import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WorkerConfig } from "../config";
import type { RunnerRuntime } from "../runner-runtime";

/** Run the actual Codex CLI on this Worker, with only a validation-scoped gateway key. */
export async function testModelProfile(config: WorkerConfig, runtime: RunnerRuntime | undefined,
  model: string, env: Record<string, string>, executionDriver: "stdio" | "pty") {
  const name = `luna-model-profile-test-${randomUUID()}`;
  const mount = "/opt/luna-runtime";
  const home = "/luna-model-test";
  const args = ["docker", "run", "-i", "--rm", "--name", name, "--network", "bridge",
    "--add-host", "host.docker.internal:host-gateway", "--memory", "1g", "--cpus", "1", "--pids-limit", "128",
    "--tmpfs", `${home}:rw,size=256m,uid=1000,gid=1000`, "-e", `HOME=${home}`, "-e", `LUNA_RUNNER_HOME=${home}`, "-w", home,
    ...(runtime ? ["--mount", `type=bind,src=${runtime.root},dst=${mount},readonly`] : []),
    "--entrypoint", "bun", config.imageDigest,
    runtime ? `${mount}/${runtime.version}/job-main.js` : "/app/agent-runner/dist/job-main.js"];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn(args, { stdin: new TextEncoder().encode(JSON.stringify({ runnerType: "codex", model,
      executionDriver, env, prompt: "Reply with exactly LUNA_AGENT_PROFILE_OK and nothing else." })), stdout: "pipe", stderr: "pipe" });
    timer = setTimeout(() => child.kill(), 60000);
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(); let text = "";
      for (;;) { const next = await reader.read(); if (next.done) return text;
        text += new TextDecoder().decode(next.value); if (text.length > 65536) { child.kill(); return ""; } }
    };
    const [code, output] = await Promise.all([child.exited, read(child.stdout), read(child.stderr)]);
    const success = code === 0 && output.includes("LUNA_AGENT_PROFILE_OK");
    return { success, message: success ? "Connection succeeded on bound Worker" : "model_connection_failed" };
  } catch { return { success: false, message: "model_connection_failed" }; }
  finally {
    clearTimeout(timer);
    const cleanup = Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
    await cleanup.exited;
  }
}
