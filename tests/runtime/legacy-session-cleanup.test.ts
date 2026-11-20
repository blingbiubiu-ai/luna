import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

describe("legacy session runtime cleanup", () => {
  test("runtime serves Luna sessions without mounting legacy sessions", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-cleanup-runtime-"));

    try {
      mkdirSync(testHome, { recursive: true });
      writeFileSync(
        join(testHome, "config.yaml"),
        "{}\n",
        "utf-8",
      );

      const port = await resolveAvailablePort();
      const result = await runRuntimeStartupProbe({ port, testHome });

      expect(result.status).toEqual({
        status: "running",
        service: "luna-agent-runtime",
      });
      expect(result.lunaDbExists).toBe(true);
      expect(result.agentaraDbExists).toBe(false);
      expect(result.sessionsStatus).toBe(200);
      expect(result.sessionsJson).toEqual([
        expect.objectContaining({
          id: "conv-cleanup",
          title: "Luna cleanup session",
        }),
      ]);
      expect(result.messagesStatus).toBe(200);
      expect(result.messagesJson).toEqual([
        expect.objectContaining({
          id: result.messageId,
          session_id: "conv-cleanup",
          role: "user",
        }),
      ]);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  }, 15_000);

  test("runtime source has no active imports from legacy sessioning namespaces", () => {
    const runtimeSrc = join(import.meta.dir, "../../src");
    const matches = findLegacySessioningImports(runtimeSrc);

    expect(matches).toEqual([]);
  });

  test("runtime source has no legacy outbound bridge", () => {
    const runtimeSrc = join(import.meta.dir, "../../src");
    const bridgePath = join(runtimeSrc, "work", "legacy-outbound-context.ts");

    expect(existsSync(bridgePath)).toBe(false);
    expect(findSourceReferences(runtimeSrc, "legacy-outbound-context")).toEqual([]);
    expect(findSourceReferences(runtimeSrc, "legacyOutboundContextFromNormalized")).toEqual([]);
  });

  test("runtime source has no legacy inbound bridge adapter", () => {
    const runtimeSrc = join(import.meta.dir, "../../src");
    const bridgePath = join(runtimeSrc, "work", "legacy-inbound-test-adapter.ts");

    expect(existsSync(bridgePath)).toBe(false);
    expect(findSourceReferences(runtimeSrc, "legacy-inbound-test-adapter")).toEqual([]);
    expect(findSourceReferences(runtimeSrc, "normalizedInboundFromLegacyDirectCallForTest")).toEqual([]);
  });

  test("channel directory source has no direct-call inbound compatibility", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/channels/directory-store.ts"),
      "utf-8",
    );

    expect(source).not.toContain("upsertFromInbound");
    expect(source).not.toContain("InboundChannelMessage");
  });

  test("task engine source has no direct-call inbound compatibility", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/tasks/task-engine.ts"),
      "utf-8",
    );

    expect(source).not.toContain("InboundChannelMessage");
    expect(source).not.toContain("DirectInputForTest");
    expect(source).not.toContain("normalizedInboundFromDirectCallForTest");
  });

  test("session resolver source has no direct-call inbound compatibility", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/sessions/session-resolver.ts"),
      "utf-8",
    );

    expect(source).not.toContain("InboundChannelMessage");
    expect(source).not.toContain("resolveFromInbound");
  });

  test("legacy Main action runtime is removed", () => {
    for (const name of ["legacy", "action-executor.ts", "action-schema.ts", "runner-decision-store.ts", "thread-handoff.ts", "work-session-policy.ts"]) {
      expect(existsSync(join(import.meta.dir, "../../src/main-runner", name))).toBe(false);
    }
  });

  test("message ingress source has no direct-call inbound compatibility", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/messaging/gateway/luna-message-ingress.ts"),
      "utf-8",
    );

    expect(source).not.toContain("InboundChannelMessage");
    expect(source).not.toContain("normalizedInboundFromDirectCallForTest");
    expect(source).not.toContain("toNormalizedSessionInboundRouterMessageForTest");
  });

  test("session inbound router source has no direct-call inbound route compatibility", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/sessions/inbound/session-inbound-router.ts"),
      "utf-8",
    );

    expect(source).not.toContain("InboundChannelMessage");
    expect(source).not.toContain("routeDirectInboundForTest");
    expect(source).not.toContain("normalizedInboundFromDirectCallForTest");
  });

  test("feishu message channel source has no direct-call inbound handler compatibility", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../extensions/channels/feishu/messaging/message-channel.ts"),
      "utf-8",
    );

    expect(source).not.toContain("InboundChannelMessage");
    expect(source).not.toContain("subscribeDirectInboundForTest");
    expect(source).not.toContain("_directInboundHandlerForTest");
  });

  test("public runtime index does not export direct-call inbound contracts", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/index.ts"),
      "utf-8",
    );

    expect(source).not.toContain("InboundChannelMessage");
  });

  test("fake Feishu channel source has no direct-call inbound compatibility", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../extensions/channels/fake/fake-feishu-channel.ts"),
      "utf-8",
    );

    expect(source).not.toContain("InboundChannelMessage");
    expect(source).not.toContain("emitInbound");
    expect(source).not.toContain("_normalizeDirectInbound");
  });
});

function findLegacySessioningImports(root: string): string[] {
  const matches: string[] = [];
  for (const filePath of walkTypeScriptFiles(root)) {
    if (filePath.includes(`${join("src", "kernel", "sessioning")}`)) continue;
    if (filePath.includes(`${join("src", "shared", "sessioning")}`)) continue;

    const source = readFileSync(filePath, "utf-8");
    const importPattern =
      /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']*sessioning[^"']*)["']/g;
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? "";
      if (
        specifier.includes("kernel/sessioning") ||
        specifier.includes("shared/sessioning") ||
        specifier === "./sessioning" ||
        specifier.startsWith("./sessioning/") ||
        specifier === "../sessioning" ||
        specifier.startsWith("../sessioning/")
      ) {
        matches.push(`${relative(root, filePath)} -> ${specifier}`);
      }
    }
  }
  return matches.sort();
}

function walkTypeScriptFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(fullPath));
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function findSourceReferences(root: string, needle: string): string[] {
  const matches: string[] = [];
  for (const filePath of walkTypeScriptFiles(root)) {
    const source = readFileSync(filePath, "utf-8");
    if (source.includes(needle)) {
      matches.push(relative(root, filePath));
    }
  }
  return matches.sort();
}

interface RuntimeStartupProbeResult {
  status: { status: string; service: string };
  lunaDbExists: boolean;
  agentaraDbExists: boolean;
  sessionsStatus: number;
  sessionsJson: unknown;
  messageId: string;
  messagesStatus: number;
  messagesJson: unknown;
}

async function runRuntimeStartupProbe(input: {
  port: number;
  testHome: string;
}): Promise<RuntimeStartupProbeResult> {
  const probe = Bun.spawn({
    cmd: ["bun", "--eval", runtimeStartupProbeScript()],
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      LUNA_HOME: input.testHome,
      LUNA_SERVICE_HOST: "127.0.0.1",
      LUNA_SERVICE_PORT: String(input.port),
      LUNA_SHARED_WORKSPACE_DIR: join(input.testHome, "unmounted-project"),
      LUNA_DASHBOARD_TOKEN: "cleanup-secret",
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr);
  }

  const resultLine = stdout
    .split("\n")
    .find((line) => line.startsWith("__LUNA_CLEANUP_RESULT__"));
  if (!resultLine) {
    throw new Error(`Runtime probe did not emit result JSON.\n${stdout}`);
  }
  return JSON.parse(
    resultLine.replace("__LUNA_CLEANUP_RESULT__", ""),
  ) as RuntimeStartupProbeResult;
}

function runtimeStartupProbeScript(): string {
  return String.raw`
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "@luna/execution-store";
import { Database as SQLiteDatabase } from "bun:sqlite";
import {
  getAgentRuntimeStatus,
  resolveAgentRuntimeOptions,
  startAgentRuntime,
  stopAgentRuntime,
} from "./src";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { fixtureNamedSession } from "./tests/helpers/platform-fixtures";
import { messages, sessions } from "./src/data/schema";
import { MessageStore } from "./src/sessions/message-store";

function seedSessionFixture(dbPath) {
  const sqlite = new SQLiteDatabase(dbPath);
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    const db = drizzle(sqlite);
    const userId = "local-dashboard-user";
    const sessionId = "conv-cleanup";
    const scope = fixtureNamedSession(db, sessionId, userId);
    db.update(sessions).set({title: "Luna cleanup session"}).where(eq(sessions.id, sessionId)).run();
    const message = new MessageStore(db).append({
      sessionId, senderUserId: userId, role: "user", channelMessageKey: "channel-message-cleanup",
      content: {text: "cleanup check"},
    });
    return {agentId: scope.agentId, messageId: message.id};
  } finally {
    sqlite.close();
  }
}

let exitCode = 0;
const options = resolveAgentRuntimeOptions(Bun.env);
await (await import("./tests/fixtures/runtime-config")).writeRuntimeFixture(options.home);

try {
  await startAgentRuntime(options);
  const dataDir = join(options.home, "data");
  const lunaDbPath = join(dataDir, "luna.db");
  const agentaraDbPath = join(dataDir, "agentara.db");
  const fixture = seedSessionFixture(lunaDbPath);
  const loginResponse = await fetch(
    "http://" + options.host + ":" + options.port + "/api/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "cleanup-secret" }),
    },
  );
  const cookie = loginResponse.headers.get("set-cookie") ?? "";

  const sessionsResponse = await fetch(
    "http://" + options.host + ":" + options.port + "/api/sessions?agentId=" + fixture.agentId,
    { headers: { cookie } },
  );
  const messagesResponse = await fetch(
    "http://" +
      options.host +
      ":" +
      options.port +
      "/api/sessions/conv-cleanup/messages",
    { headers: { cookie } },
  );

  console.log(
    "__LUNA_CLEANUP_RESULT__" +
      JSON.stringify({
        status: getAgentRuntimeStatus(),
        lunaDbExists: existsSync(lunaDbPath),
        agentaraDbExists: existsSync(agentaraDbPath),
        sessionsStatus: sessionsResponse.status,
        sessionsJson: await sessionsResponse.json(),
        messageId: fixture.messageId,
        messagesStatus: messagesResponse.status,
        messagesJson: await messagesResponse.json(),
      }),
  );
} catch (err) {
  exitCode = 1;
  console.error(err);
} finally {
  try {
    await stopAgentRuntime();
  } catch (err) {
    exitCode = 1;
    console.error(err);
  }
}
process.exit(exitCode);
`;
}

async function resolveAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve test port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
