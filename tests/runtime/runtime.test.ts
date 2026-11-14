import {fixtureObserveFeishuSender, fixtureFeishuSender, fixtureNamedSession, fixturePlatformAdmin, fixtureRunnerContext, fixtureSessionOwnership, fixtureTaskOwnership} from "../helpers/platform-fixtures";
import { writeRuntimeFixture } from "../fixtures/runtime-config";
import { writePrivateJson } from "@luna/execution-store";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Database as SQLiteDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { TaskRunStore } from "../../src/tasks/task-run-store";
import { TaskRunSupervisor } from "../../src/tasks/task-run-supervisor";
import { SessionQueue } from "../../src/sessions/session-queue";
import { ArtifactRegistry } from "../../src/artifacts/artifact-registry";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { ChannelAdapterRegistry } from "../../src/channels";
import type { NormalizedInboundMessage } from "../../src/channels";
import { FeishuMessageChannel } from "../../extensions/channels/feishu";
import type { MessageReceiveEventData } from "../../extensions/channels/feishu/messaging/types";
import { DataConnection } from "../../src/data";
import {
  artifacts as artifactRowsTable,
  managedArtifacts,
  runnerContexts,
  tasks as taskRowsTable,
  sessions as sessionRowsTable,
  timelineEvents,
  users as userRowsTable,
} from "../../src/data/schema";
import * as lunaSchema from "../../src/data/schema";
import type { TaskResultForMainRunner } from "../../src/main-runner/types";
import type { InboundChannelMessage } from "../../src/sessions/types";
import { FakeFeishuChannel as BaseFakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress } from "./support/main-command-harness";
import { DashboardAuthService } from "../../src/server/auth";
import { AppConfig, SessionConfig } from "../../src/shared/config/schema";
import {
  config,
  reloadConfig,
  setLunaHome,
  type SessionConfig as SessionConfigType,
} from "../../src/shared";
import {
  getAgentRuntimeStatus,
  resolveAgentRuntimeOptions,
  startAgentRuntime,
  stopAgentRuntime,
} from "../../src";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { normalizedInboundFromDirectCallForTest } from "../../src/work/direct-call-inbound-adapter";
import { createDeterministicMainRunner } from "./test-main-runner";

const SessionConfigForTests = {
  coalesce_idle_ms: 1,
  coalesce_max_wait_ms: 25,
  max_batch_size: 8,
  max_task_actions_per_batch: 3,
  processing_notice_after_ms: 1500,
  stale_claim_ms: 120000,
  turn_warn_after_ms: 120000,
  max_queue_depth: 50,
  activation_context_window_ms: 300000,
  activation_context_max_messages: 12,
  activation_context_max_chars: 6000,
  activation_context_recent_unprocessed_messages: 10,
  activation_context_max_cc_reporters: 1,
  group_bot_aliases: [],
  group_activation_followup_window_ms: 300000,
  group_activation_followup_senders: "requester_and_reporters",
  group_activation_followup_max_messages: 8,
  group_activation_followup_recent_messages: 3,
  group_activation_followup_interrupt_on_other_user: true,
} satisfies SessionConfigType;

class FakeFeishuChannel extends BaseFakeFeishuChannel {
  constructor(
    id: string,
    inbound: readonly (NormalizedInboundMessage | InboundChannelMessage)[] = [],
    options?: ConstructorParameters<typeof BaseFakeFeishuChannel>[2],
  ) {
    super(id, inbound.map(normalizeInboundForFakeFeishuTest), options);
  }

  async emitInbound(message: InboundChannelMessage): Promise<void> {
    await this.emitNormalizedInbound(normalizeInboundForFakeFeishuTest(message));
  }

  async deliver(
    message: NormalizedInboundMessage | InboundChannelMessage,
  ): Promise<void> {
    await super.deliver(normalizeInboundForFakeFeishuTest(message));
  }
}

function normalizeInboundForFakeFeishuTest(
  message: NormalizedInboundMessage | InboundChannelMessage,
): NormalizedInboundMessage {
  return "channel" in message
    ? message
    : normalizedInboundFromDirectCallForTest(message);
}

describe("agent runtime package shell", () => {
  test("resolves default runtime options from env", () => {
    const options = resolveAgentRuntimeOptions({
      LUNA_HOME: "/tmp/luna-agent-home",
      LUNA_SERVICE_HOST: "127.0.0.1",
      LUNA_SERVICE_PORT: "9001",
    });

    expect(options.home).toBe("/tmp/luna-agent-home");
    expect(options.host).toBe("127.0.0.1");
    expect(options.port).toBe(9001);
    expect(options.dashboardToken).toBe("luna-local-dev");
  });

  test("uses HOME from env when LUNA_HOME is missing", () => {
    const options = resolveAgentRuntimeOptions({
      HOME: "/tmp/luna-user-home",
    });

    expect(options.home).toBe("/tmp/luna-user-home/.luna");
    expect(options.host).toBe("127.0.0.1");
    expect(options.port).toBe(8090);
    expect(options.dashboardToken).toBe("luna-local-dev");
  });

  test("loads runtime defaults from HOME scoped .env", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-runtime-env-home-"));
    const lunaHome = join(testRoot, ".luna");
    mkdirSync(lunaHome, { recursive: true });
    writeFileSync(
      join(lunaHome, "config.yaml"),
      [
        "service:",
        "  host: 0.0.0.0",
        "  port: 9101",
        "  publicUrl: http://config-service.test",
        "paths:",
        "  runtimeDir: /tmp/luna-runtime-config",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(lunaHome, ".env"),
      [
        "export LUNA_SERVICE_PORT=9102",
        "export LUNA_DASHBOARD_TOKEN=env-file-dashboard-token",
      ].join("\n"),
      "utf-8",
    );

    try {
      const options = resolveAgentRuntimeOptions({
        HOME: testRoot,
      });

      expect(options.home).toBe(lunaHome);
      expect(options.host).toBe("0.0.0.0");
      expect(options.port).toBe(9102);
      expect(options.dashboardToken).toBe("env-file-dashboard-token");
      expect(options.runtimeDir).toBe("/tmp/luna-runtime-config");
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("generates config without agent settings", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-default-agent-home-"));

    try {
      const boot = Bun.spawnSync({
        cmd: [
          "bun",
          "-e",
          [
            'const { bootLoader } = await import("./src/boot-loader/boot-loader");',
            'await bootLoader["_verifyIntegrity"]();',
          ].join("\n"),
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          LUNA_HOME: testHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(boot.exitCode).toBe(0);

      const rawConfig = readFileSync(join(testHome, "config.yaml"), "utf-8");
      const parsedConfig = (Bun as unknown as {
        YAML: { parse(value: string): unknown };
      }).YAML.parse(rawConfig) as Record<string, unknown>;

      expect(parsedConfig).not.toHaveProperty("agents");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("test inbound registers the injected channel while handling the message", async () => {
    const { kernel } = await import("../../src/kernel");
    const mutableKernel = kernel as unknown as {
      _lunaChannels: Map<string, unknown>;
      _sessionCommands: { waitForIdle: () => Promise<void> };
      _lunaMessageIngress: {
        handleInboundMessageForTest: (
          channel: unknown,
          message: unknown,
        ) => Promise<void>;
      };
    };
    const channel = { id: "test-inject-regression" };
    const originalCommands = mutableKernel._sessionCommands;
    const originalIngress = mutableKernel._lunaMessageIngress;
    const originalChannel = mutableKernel._lunaChannels.get(channel.id);
    let sawTemporaryRegistration = false;
    let sawExistingChannelPreserved = false;

    try {
      mutableKernel._sessionCommands = { waitForIdle: async () => {} };
      mutableKernel._lunaChannels.delete(channel.id);
      mutableKernel._lunaMessageIngress = {
        async handleInboundMessageForTest(activeChannel) {
          sawTemporaryRegistration =
            mutableKernel._lunaChannels.get(channel.id) === activeChannel;
        },
      };

      await kernel.handleInboundMessageForTest(
        channel as never,
        {} as never,
      );

      expect(sawTemporaryRegistration).toBe(true);
      expect(mutableKernel._lunaChannels.has(channel.id)).toBe(false);

      const existingChannel = { id: channel.id, existing: true };
      mutableKernel._lunaChannels.set(channel.id, existingChannel);
      mutableKernel._lunaMessageIngress = {
        async handleInboundMessageForTest() {
          sawExistingChannelPreserved =
            mutableKernel._lunaChannels.get(channel.id) === existingChannel;
        },
      };

      await kernel.handleInboundMessageForTest(
        channel as never,
        {} as never,
      );

      expect(sawExistingChannelPreserved).toBe(true);
      expect(mutableKernel._lunaChannels.get(channel.id)).toBe(existingChannel);
    } finally {
      mutableKernel._sessionCommands = originalCommands;
      mutableKernel._lunaMessageIngress = originalIngress;
      if (originalChannel === undefined) {
        mutableKernel._lunaChannels.delete(channel.id);
      } else {
        mutableKernel._lunaChannels.set(channel.id, originalChannel);
      }
    }
  });

  test("boot loader resolves the repo root from source and bundled dist dirs", async () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), "luna-boot-loader-repo-"));

    try {
      mkdirSync(join(fakeRepo, "src", "boot-loader"), { recursive: true });
      mkdirSync(join(fakeRepo, "dist"), { recursive: true });
      writeFileSync(join(fakeRepo, "package.json"), "{}", "utf-8");

      const { resolveBootLoaderRepoRoot } = await import(
        "../../src/boot-loader/boot-loader"
      );

      expect(resolveBootLoaderRepoRoot(join(fakeRepo, "src", "boot-loader")))
        .toBe(fakeRepo);
      expect(resolveBootLoaderRepoRoot(join(fakeRepo, "dist"))).toBe(fakeRepo);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test("shared config defaults do not expose agent settings", () => {
    const source = readFileSync("src/shared/config/index.ts", "utf-8");

    expect(source).not.toContain("get agents");
  });

  test("rejects removed agents section in config yaml", () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-runtime-host-config-"));
    mkdirSync(join(testHome, "data"), { recursive: true });
    setLunaHome(testHome);
    writeFileSync(
      join(testHome, "config.yaml"),
      [
        "agents:",
        "  default:",
        "    type: mock",
        "messaging:",
        "  default_channel_id: fake",
        "  channels: []",
      ].join("\n"),
      "utf-8",
    );

    try {
      expect(() => reloadConfig()).toThrow(/unrecognized key.*agents/i);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("uses container bootstrap defaults before config.yaml is loaded", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-runtime-bootstrap-"));
    mkdirSync(join(testHome, "data"), { recursive: true });
    setLunaHome(testHome);
    rmSync(join(testHome, "config.yaml"), { force: true });

    try {
      const { kernel } = await import("../../src/kernel");

      expect(() => kernel.prepareForRuntimeStart()).not.toThrow();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("dashboard auth service defaults to the local development token", async () => {
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;

    try {
      delete process.env.LUNA_DASHBOARD_TOKEN;
      delete Bun.env.LUNA_DASHBOARD_TOKEN;

      const auth = new DashboardAuthService({
        sessionSecret: "test-session-secret",
      });

      expect(auth.usesLocalDefaultToken).toBe(true);
      expect(await auth.login("wrong-token")).toBeNull();
      const login = await auth.login("luna-local-dev");
      expect(login?.session).toEqual({
        authenticated: true,
        user: {
          id: "local-dashboard-user",
          name: "Local dashboard user",
          provider: "local-token",
        },
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
    }
  });

  test("dashboard auth service preserves provider profile metadata in sessions", async () => {
    const auth = new DashboardAuthService({
      provider: {
        id: "company-sso",
        async authenticateToken(token) {
          if (token !== "valid-token") {
            return null;
          }
          return {
            id: "user-actual-dashboard",
            name: "Actual Dashboard User",
            provider: "company-sso",
            avatarUrl: "https://avatar.example/actual.png",
          };
        },
      },
      sessionSecret: "test-session-secret",
    });

    const login = await auth.login("valid-token");

    expect(login?.session).toEqual({
      authenticated: true,
      user: {
        id: "user-actual-dashboard",
        name: "Actual Dashboard User",
        provider: "company-sso",
        avatarUrl: "https://avatar.example/actual.png",
      },
    });
  });

  test("rejects invalid service ports", () => {
    const invalidPorts = ["abc", "0", "-1", "65536", "9000.5"];

    for (const port of invalidPorts) {
      expect(() =>
        resolveAgentRuntimeOptions({
          LUNA_SERVICE_PORT: port,
        }),
      ).toThrow("LUNA_SERVICE_PORT must be an integer between 1 and 65535");
    }
  });

  test("reports stopped before the server starts", () => {
    expect(getAgentRuntimeStatus()).toEqual({
      status: "stopped",
      service: "luna-agent-runtime",
    });
  });

  test("runtime status identifies luna service", () => {
    expect(getAgentRuntimeStatus().service).toBe("luna-agent-runtime");
  });

  test("session queue config has safe defaults", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/shared/config/schema.ts"),
      "utf-8",
    );

    expect(source).toContain("SessionConfig");
    expect(source).toContain("coalesce_idle_ms");
    expect(source).toContain("coalesce_max_wait_ms");
    expect(source).toContain("max_batch_size");
    expect(source).toContain("max_task_actions_per_batch");
    expect(source).toContain("processing_notice_after_ms");
    expect(source).toContain("stale_claim_ms");
    expect(source).toContain("turn_warn_after_ms");
    expect(source).toContain("max_queue_depth");
  });

  test("app config reads session queue settings from the session block", () => {
    const parsed = AppConfig.parse({
      timezone: "Asia/Shanghai",
      service: {
        host: "0.0.0.0",
        port: 8090,
        publicUrl: "http://127.0.0.1:8090",
      },
      paths: {
        repoRoot: "/tmp/luna-knowledge",
        runtimeDir: "/tmp/luna",
        artifactsDir: "/tmp/luna-artifacts",
      },
      logging: {
        level: "debug",
        pretty: true,
      },
      plugins: {
        config: {
          samplePlugin: {
            projectId: "304286",
            appId: "6589",
          },
        },
      },
      session: {
        coalesce_idle_ms: 1200,
        coalesce_max_wait_ms: 10000,
        max_batch_size: 8,
        max_task_actions_per_batch: 3,
      },
      messaging: {
        default_channel_id: "feishu-default",
        max_visible_steps: 32,
        channels: [],
      },
    });

    expect(parsed.session.coalesce_max_wait_ms).toBe(10000);
    expect(parsed.session.max_task_actions_per_batch).toBe(3);
    expect(parsed.service.host).toBe("0.0.0.0");
    expect(parsed.paths.runtimeDir).toBe("/tmp/luna");
    expect(parsed.logging.pretty).toBe(true);
    expect(parsed.plugins.config).toMatchObject({
      samplePlugin: {
        projectId: "304286",
      },
    });
  });

  test("app config reads Runtime configuration override and Job timeout from the sandbox block", () => {
    const parsed = AppConfig.parse({
      timezone: "Asia/Shanghai",
      messaging: {
        default_channel_id: "feishu-default",
        channels: [],
      },
      sandbox: {
        runtimeConfigFile: "/private/runtime.json",
        containerTimeoutMs: 34_000,
      },
    });

    expect(parsed.sandbox).toEqual({
      runtimeConfigFile: "/private/runtime.json",
      containerTimeoutMs: 34_000,
    });
  });

  test("app config defaults and overrides transient runner retries", () => {
    const defaults = AppConfig.parse({
      messaging: { default_channel_id: "", channels: [] },
    });
    expect(defaults.runner.maxTransientRetries).toBe(5);

    const configured = AppConfig.parse({
      messaging: { default_channel_id: "", channels: [] },
      runner: { maxTransientRetries: 4 },
    });
    expect(configured.runner.maxTransientRetries).toBe(4);
    expect(
      AppConfig.safeParse({
        messaging: { default_channel_id: "", channels: [] },
        runner: { maxTransientRetries: -1 },
      }).success,
    ).toBe(false);
  });

  test("app config accepts only complete single-line managed Git identities", () => {
    const configured = AppConfig.parse({
      messaging: { default_channel_id: "", channels: [] },
      git: {
        authorName: "Example Contributor",
        authorEmail: "contributor@example.com",
      },
    });
    expect(configured.git).toEqual({
      authorName: "Example Contributor",
      authorEmail: "contributor@example.com",
    });
    expect(
      AppConfig.safeParse({
        messaging: { default_channel_id: "", channels: [] },
        git: { authorName: "Example Contributor" },
      }).success,
    ).toBe(false);
    expect(
      AppConfig.safeParse({
        messaging: { default_channel_id: "", channels: [] },
        git: {
          authorName: "Example Contributor\n[credential]",
          authorEmail: "contributor@example.com",
        },
      }).success,
    ).toBe(false);
  });

  test("app config rejects stale conversation queue keys instead of ignoring them", () => {
    const parsed = AppConfig.safeParse({
      timezone: "Asia/Shanghai",
      conversation: {
        coalesce_max_wait_ms: 10000,
      },
      messaging: {
        default_channel_id: "feishu-default",
        max_visible_steps: 32,
        channels: [],
      },
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some((issue) =>
        "keys" in issue &&
        Array.isArray(issue.keys) &&
        issue.keys.includes("conversation")
      ),
    ).toBe(true);
  });

  test("session config includes group activation defaults", () => {
    const defaults = SessionConfig.parse({});

    expect(defaults).toMatchObject({
      activation_context_window_ms: 300000,
      activation_context_max_messages: 12,
      activation_context_max_chars: 6000,
      activation_context_recent_unprocessed_messages: 10,
      activation_context_max_cc_reporters: 1,
      group_bot_aliases: [],
    });
    expect(defaults.group_activation_followup_window_ms).toBe(300000);
    expect(defaults.group_activation_followup_senders).toBe(
      "requester_and_reporters",
    );
    expect(defaults.group_activation_followup_max_messages).toBe(8);
    expect(defaults.group_activation_followup_recent_messages).toBe(3);
    expect(defaults.group_activation_followup_interrupt_on_other_user).toBe(true);
    expect(
      SessionConfig.parse({
        group_activation_followup_window_ms: 0,
        group_activation_followup_senders: "requester_only",
        group_activation_followup_max_messages: 1,
        group_activation_followup_recent_messages: 2,
        group_activation_followup_interrupt_on_other_user: false,
      }),
    ).toMatchObject({
      group_activation_followup_window_ms: 0,
      group_activation_followup_senders: "requester_only",
      group_activation_followup_max_messages: 1,
      group_activation_followup_recent_messages: 2,
      group_activation_followup_interrupt_on_other_user: false,
    });
  });

  test("fresh database contains session inbox and turn tables", () => {
    const env = createRuntimeTestEnvironment();
    try {
      const tableNames = env.database.sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;

      expect(tableNames.map((row) => row.name)).toContain("session_inbox");
      expect(tableNames.map((row) => row.name)).toContain("session_turns");
      expect(tableNames.map((row) => row.name)).toContain("messages");
      expect(tableNames.map((row) => row.name)).toContain(
        "session_timeline_entries",
      );
      expect(tableNames.map((row) => row.name)).toContain(
        "session_turn_entries",
      );

      const inboxIndexes = env.database.sqlite
        .query("PRAGMA index_list(session_inbox)")
        .all() as Array<{ name: string }>;
      expect(inboxIndexes.map((row) => row.name)).toContain(
        "session_inbox_entry_unique",
      );
      expect(inboxIndexes.map((row) => row.name)).toContain(
        "session_inbox_queue_idx",
      );
      expect(inboxIndexes.map((row) => row.name)).toContain(
        "session_inbox_turn_idx",
      );
      const timelineIndexes = env.database.sqlite
        .query("PRAGMA index_list(session_timeline_entries)")
        .all() as Array<{ name: string }>;
      expect(timelineIndexes.map((row) => row.name)).toContain(
        "session_timeline_entries_session_created_idx",
      );
      const timelineIndexColumns = env.database.sqlite
        .query("PRAGMA index_info(session_timeline_entries_session_created_idx)")
        .all() as Array<{ name: string }>;
      expect(timelineIndexColumns.map((row) => row.name)).toEqual([
        "session_id",
        "created_at",
      ]);

      const messageIndexes = env.database.sqlite
        .query("PRAGMA index_list(messages)")
        .all() as Array<{ name: string }>;
      expect(messageIndexes.map((row) => row.name)).toContain(
        "messages_channel_external_role_unique",
      );
      const messageIndexColumns = env.database.sqlite
        .query("PRAGMA index_info(messages_channel_external_role_unique)")
        .all() as Array<{ name: string | null }>;
      expect(messageIndexColumns.map((row) => row.name)).toEqual([
        "agent_id",
        "shadow_id",
        null, // coalesce(binding_id, '') keeps Dashboard uniqueness with a null binding
        "channel_type",
        "channel_id",
        "external_message_id",
        "role",
      ]);
    } finally {
      env.cleanup();
    }
  });

  test("fake Feishu ordinary chat creates one session without a task", async () => {
    const env = await _createRuntimeAcceptanceEnv();

    try {
      await env.fakeFeishu.sendInbound({ text: "这个接口是什么意思" });
      await env.waitForIdle();

      const sessions = env.database.db
        .select()
        .from(sessionRowsTable)
        .all();
      const tasks = env.database.db.select().from(taskRowsTable).all();
      const outbound = env.fakeFeishu.outbound;

      expect(sessions).toHaveLength(1);
      expect(tasks).toHaveLength(0);
      expect(outbound[0]?.content).not.toContain("runner-stderr");
    } finally {
      env.cleanup();
    }
  });

  test("fake Feishu troubleshooting creates a task with runner timeline and report artifact", async () => {
    const env = await _createRuntimeAcceptanceEnv();

    try {
      await env.fakeFeishu.sendInbound({
        text: "线上这个接口 502 了，帮忙排查",
      });
      await env.waitForIdle();

      const tasks = env.database.db.select().from(taskRowsTable).all();
      const timeline = env.database.db.select().from(timelineEvents).all();
      const artifacts = env.database.db.select().from(artifactRowsTable).all();

      expect(tasks[0]?.type).toBe("task");
      expect(timeline.map((event) => event.type)).toContain("runner.started");
      expect(artifacts.map((artifact) => artifact.name)).toContain(
        "final-report.md",
      );
      expect(env.fakeFeishu.outbound[0]?.content).not.toContain(
        "runner-stderr",
      );
    } finally {
      env.cleanup();
    }
  });

  test("explicit Task Run supervisor persists run, runner timeline, and final report", async () => {
    const taskResults: TaskResultForMainRunner[] = [];
    const env = await _createRuntimeAcceptanceEnv({
      taskRunSupervisor: (database) =>
        new TaskRunSupervisor({
          db: database.db,
          runnerType: "mock",
          onTaskResult: async (result) => {
            taskResults.push(result);
          },
        }),
    });

    try {
      await env.fakeFeishu.sendInbound({
        text: "线上这个接口 502 了，帮忙排查",
      });
      await env.waitForIdle();

      const taskRows = env.database.db.select().from(taskRowsTable).all();
      const taskId = taskRows[0]!.id;
      const taskRuns = new TaskRunStore(env.database.db).listRunsForTask(
        taskId,
      );
      const timeline = env.database.db.select().from(timelineEvents).all();
      const artifacts = env.database.db.select().from(artifactRowsTable).all();
      const reportArtifact = artifacts.find((artifact) =>
        artifact.name === "final-report.md"
      );
      const managedArtifactId = isRecord(reportArtifact?.metadata)
        ? reportArtifact.metadata.managedArtifactId
        : undefined;
      const managedReport = typeof managedArtifactId === "string"
        ? env.database.db
          .select()
          .from(managedArtifacts)
          .where(eq(managedArtifacts.id, managedArtifactId))
          .get()
        : undefined;

      expect(taskRows[0]?.status).toBe("completed");
      expect(taskRuns).toHaveLength(1);
      expect(taskRuns[0]).toMatchObject({
        taskId,
        reason: "initial",
        status: "completed",
      });
      expect(timeline.map((event) => event.type)).toContain("runner.started");
      expect(timeline.map((event) => event.type)).toContain("runner.completed");
      expect(artifacts.map((artifact) => artifact.name)).toContain(
        "final-report.md",
      );
      expect(managedReport).toMatchObject({
        scope_id: taskId,
        kind: "report",
        name: "final-report.md",
        mime_type: "text/markdown",
      });
      expect(taskResults).toHaveLength(1);
      expect(taskResults[0]).toMatchObject({
        taskId,
        status: "completed",
        title: taskRows[0]!.title,
        summary: taskRows[0]!.summary,
        userVisibleReport: expect.stringContaining("# Fake runner report"),
        nextActions: [],
      });
      expect(taskResults[0]?.conclusion).toBeUndefined();
      expect(taskResults[0]?.evidenceSummary).toContain(
        "Started mock runner.",
      );
      expect(taskResults[0]?.evidenceSummary).toContain(
        "Completed mock runner.",
      );
      expect(taskResults[0]?.artifactIds).toContain(
        reportArtifact?.id,
      );
    } finally {
      env.cleanup();
    }
  });

  test("explicit Task Run supervisor keeps completed task resolved when result notification fails", async () => {
    const env = await _createRuntimeAcceptanceEnv({
      taskRunSupervisor: (database) =>
        new TaskRunSupervisor({
          db: database.db,
          runnerType: "mock",
          onTaskResult: () => {
            throw new Error("final notification failed");
          },
        }),
    });

    try {
      await env.fakeFeishu.sendInbound({
        text: "线上这个接口 502 了，帮忙排查",
      });
      await env.waitForIdle();

      const taskRows = env.database.db.select().from(taskRowsTable).all();
      const taskId = taskRows[0]!.id;
      const taskRuns = new TaskRunStore(env.database.db).listRunsForTask(
        taskId,
      );
      const timeline = env.database.db.select().from(timelineEvents).all();

      expect(taskRows[0]?.status).toBe("completed");
      expect(taskRuns).toHaveLength(1);
      expect(taskRuns[0]).toMatchObject({
        taskId,
        status: "completed",
        error: null,
      });
      expect(
        timeline.filter((event) => event.type === "runner.failed"),
      ).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });

  test("explicit Task Run supervisor marks failed runner and notifies status card", async () => {
    const taskResults: TaskResultForMainRunner[] = [];
    const env = await _createRuntimeAcceptanceEnv({
      taskRunSupervisor: (database) =>
        new TaskRunSupervisor({
          db: database.db,
          runnerType: "mock",
          executeRun: async () => { throw new Error("fixture runner execution failed"); },
          onTaskResult: async (result) => {
            taskResults.push(result);
          },
        }),
    });

    try {
      await env.fakeFeishu.sendInbound({
        text: "线上这个接口 502 了，帮忙排查",
      });
      await env.waitForIdle();

      const taskRows = env.database.db.select().from(taskRowsTable).all();
      const taskId = taskRows[0]!.id;
      const taskRuns = new TaskRunStore(env.database.db).listRunsForTask(
        taskId,
      );
      const timeline = env.database.db.select().from(timelineEvents).all();

      expect(taskRows[0]?.status).toBe("failed");
      expect(taskRuns).toHaveLength(1);
      expect(taskRuns[0]).toMatchObject({
        taskId,
        status: "failed",
      });
      expect(timeline.map((event) => event.type)).toContain("runner.failed");
      expect(taskResults).toHaveLength(1);
      expect(taskResults[0]).toMatchObject({
        taskId,
        status: "failed",
        title: taskRows[0]!.title,
        summary: taskRows[0]!.summary,
        userVisibleReport: expect.stringContaining("Task runner failed:"),
        artifactIds: [],
        nextActions: [],
      });
      expect(taskResults[0]?.evidenceSummary).toContain(
        "Task runner failed: fixture runner execution failed",
      );
    } finally {
      env.cleanup();
    }
  });

  test("production static server serves agent dashboard SPA routes", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-static-root-"));
    const previousCwd = process.cwd();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBunNodeEnv = Bun.env.NODE_ENV;
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;

    try {
      _writeDashboardDistFixture(testRoot, {
        script: "console.log('luna');\n",
      });

      process.chdir(testRoot);
      process.env.NODE_ENV = "production";
      Bun.env.NODE_ENV = "production";
      process.env.LUNA_DASHBOARD_TOKEN = "static-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "static-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer();
      const cookie = await _dashboardCookie(server, "static-secret");

      const anonymousHome = await server.app.fetch(new Request("http://luna.test/"));
      expect(anonymousHome.status).toBe(302);
      expect(anonymousHome.headers.get("location")).toBe("/login?next=%2F");

      for (const route of [
        "/",
        "/agent/agent_fixture",
        "/agent/sessions",
        "/agent/tasks",
        "/agent/tasks/task_1",
        "/agent/knowledge",
        "/agent/plugins",
        "/agent/groups",
      ]) {
        const shellResponse = await server.app.fetch(
          new Request(`http://luna.test${route}`, {
            headers: { cookie },
          }),
        );
        expect(shellResponse.status).toBe(200);
        expect(await shellResponse.text()).toContain('<div id="root"></div>');
      }
      const artifactPreviewResponse = await server.app.fetch(
        new Request(
          "http://luna.test/artifacts/artifact-report/preview?expires=1782443260821&sig=test",
        ),
      );
      expect(artifactPreviewResponse.status).toBe(200);
      expect(await artifactPreviewResponse.text()).toContain(
        '<div id="artifact-preview-root"></div>',
      );

      const assetResponse = await server.app.fetch(
        new Request("http://luna.test/agent/main.js"),
      );
      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toContain("luna");
      const cssResponse = await server.app.fetch(
        new Request("http://luna.test/agent/main.css"),
      );
      expect(cssResponse.status).toBe(200);
      expect(await cssResponse.text()).toContain("display: flex");
    } finally {
      process.chdir(previousCwd);
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousBunNodeEnv === undefined) {
        delete Bun.env.NODE_ENV;
      } else {
        Bun.env.NODE_ENV = previousBunNodeEnv;
      }
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("static server resolves npm package dashboard assets from dist module dir", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-npm-static-root-"));
    try {
      _writeDashboardDistFixture(testRoot, {
        script: "console.log('luna-npm');\n",
      });
      const { resolveWebDistPath } = await import("../../src/server/server");
      expect(resolveWebDistPath({
        moduleDir: join(testRoot, "dist"),
        cwd: join(testRoot, "runtime-cwd"),
        env: {},
      })).toBe(join(testRoot, "apps", "dashboard", "dist"));
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("static server serves agent dashboard after restart without production env", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-static-root-"));
    const previousCwd = process.cwd();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBunNodeEnv = Bun.env.NODE_ENV;
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;

    try {
      _writeDashboardDistFixture(testRoot, {
        script: "console.log('luna');\n",
      });

      process.chdir(testRoot);
      delete process.env.NODE_ENV;
      delete Bun.env.NODE_ENV;
      process.env.LUNA_DASHBOARD_TOKEN = "static-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "static-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer();
      const cookie = await _dashboardCookie(server, "static-secret");

      for (const route of ["/", "/agent/test-agent", "/agent/test-agent/sessions"]) {
        const shellResponse = await server.app.fetch(
          new Request(`http://luna.test${route}`, {
            headers: { cookie },
          }),
        );
        expect(shellResponse.status).toBe(200);
        expect(await shellResponse.text()).toContain('<div id="root"></div>');
      }
    } finally {
      process.chdir(previousCwd);
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousBunNodeEnv === undefined) {
        delete Bun.env.NODE_ENV;
      } else {
        Bun.env.NODE_ENV = previousBunNodeEnv;
      }
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("static server serves dashboard when daemon starts from repository parent cwd", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-static-parent-root-"));
    const previousCwd = process.cwd();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBunNodeEnv = Bun.env.NODE_ENV;
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;
    const previousWebDistPath = process.env.LUNA_WEB_DIST_PATH;
    const previousBunWebDistPath = Bun.env.LUNA_WEB_DIST_PATH;

    try {
      _writeDashboardDistFixture(join(testRoot, "luna"), {
        script: "console.log('luna-parent');\n",
      });

      process.chdir(testRoot);
      delete process.env.NODE_ENV;
      delete Bun.env.NODE_ENV;
      delete process.env.LUNA_WEB_DIST_PATH;
      delete Bun.env.LUNA_WEB_DIST_PATH;
      process.env.LUNA_DASHBOARD_TOKEN = "static-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "static-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer();
      const cookie = await _dashboardCookie(server, "static-secret");

      const shellResponse = await server.app.fetch(
        new Request("http://luna.test/agent/test-agent", {
          headers: { cookie },
        }),
      );
      expect(shellResponse.status).toBe(200);
      expect(await shellResponse.text()).toContain('<div id="root"></div>');

      const assetResponse = await server.app.fetch(
        new Request("http://luna.test/agent/main.js"),
      );
      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toContain("luna-parent");
    } finally {
      process.chdir(previousCwd);
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousBunNodeEnv === undefined) {
        delete Bun.env.NODE_ENV;
      } else {
        Bun.env.NODE_ENV = previousBunNodeEnv;
      }
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      if (previousWebDistPath === undefined) {
        delete process.env.LUNA_WEB_DIST_PATH;
      } else {
        process.env.LUNA_WEB_DIST_PATH = previousWebDistPath;
      }
      if (previousBunWebDistPath === undefined) {
        delete Bun.env.LUNA_WEB_DIST_PATH;
      } else {
        Bun.env.LUNA_WEB_DIST_PATH = previousBunWebDistPath;
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("dashboard auth protects web pages and business APIs", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-auth-root-"));
    const previousCwd = process.cwd();
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;

    try {
      _writeDashboardDistFixture(testRoot, {
        script: "console.log('luna');\n",
      });

      process.chdir(testRoot);
      process.env.LUNA_DASHBOARD_TOKEN = "local-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "local-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer();

      const apiResponse = await server.app.fetch(
        new Request("http://luna.test/api/agent/sessions"),
      );
      expect(apiResponse.status).toBe(401);
      expect(await apiResponse.json()).toEqual({
        status: "error",
        code: "unauthorized",
        message: "authentication required",
      });

      const pageResponse = await server.app.fetch(
        new Request("http://luna.test/agent/sessions"),
      );
      expect(pageResponse.status).toBe(302);
      expect(pageResponse.headers.get("location")).toBe(
        "/login?next=%2Fagent%2Fsessions",
      );

      const assetResponse = await server.app.fetch(
        new Request("http://luna.test/agent/main.js"),
      );
      expect(assetResponse.status).toBe(200);

      const loginPage = await server.app.fetch(
        new Request("http://luna.test/login"),
      );
      expect(loginPage.status).toBe(200);
      const loginHtml = await loginPage.text();
      expect(loginHtml).toContain("Luna Login");
      expect(loginHtml).toContain("Dashboard Login");
      expect(loginHtml).toContain("luna-ui-language");
      expect(loginHtml).toContain("简体中文");
      expect(loginHtml).toContain('data-testid="service-login-page"');
      expect(loginHtml).toContain('type="password"');
      expect(loginHtml).toContain('href="/api/auth/sso/start?next=%2F"');
    } finally {
      process.chdir(previousCwd);
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("dashboard auth login issues a session cookie and logout clears it", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-auth-root-"));
    const previousCwd = process.cwd();
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;

    try {
      _writeDashboardDistFixture(testRoot, {
        script: "console.log('luna');\n",
      });
      process.chdir(testRoot);
      process.env.LUNA_DASHBOARD_TOKEN = "local-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "local-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer();

      const failedLogin = await server.app.fetch(
        new Request("http://luna.test/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "wrong" }),
        }),
      );
      expect(failedLogin.status).toBe(401);

      const login = await server.app.fetch(
        new Request("http://luna.test/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "local-secret" }),
        }),
      );
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual({
        authenticated: true,
        user: {
          id: "local-dashboard-user",
          name: "Local dashboard user",
          provider: "local-token",
        },
      });
      const cookie = login.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("luna_dashboard_session=");
      expect(cookie).toContain("HttpOnly");

      const session = await server.app.fetch(
        new Request("http://luna.test/api/auth/session", {
          headers: { cookie },
        }),
      );
      expect(session.status).toBe(200);
      expect(await session.json()).toEqual({
        authenticated: true,
        user: {
          id: "local-dashboard-user",
          name: "Local dashboard user",
          provider: "local-token",
        },
      });

      const page = await server.app.fetch(
        new Request("http://luna.test/agent/sessions", {
          headers: { cookie },
        }),
      );
      expect(page.status).toBe(200);

      const logout = await server.app.fetch(
        new Request("http://luna.test/api/auth/logout", {
          method: "POST",
          headers: { cookie },
        }),
      );
      expect(logout.status).toBe(200);
      expect(logout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    } finally {
      process.chdir(previousCwd);
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("dashboard CLI auth routes issue list and revoke access tokens", async () => {
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;
    const previousAccessSecret = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunAccessSecret = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    const runtime = createRuntimeTestEnvironment();

    try {
      process.env.LUNA_DASHBOARD_TOKEN = "local-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "local-secret";
      process.env.LUNA_ACCESS_TOKEN_SECRET = "access-secret";
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = "access-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer({ db: runtime.database.db });

      const unauthenticatedMe = await server.app.fetch(
        new Request("http://luna.test/api/auth/me"),
      );
      expect(unauthenticatedMe.status).toBe(401);
      expect(await unauthenticatedMe.json()).toMatchObject({
        status: "error",
        code: "unauthorized",
      });

      const start = await server.app.fetch(
        new Request("http://luna.test/api/auth/cli/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(start.status).toBe(200);
      const started = await start.json() as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
      };
      expect(started.deviceCode).toBeString();
      expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(started.verificationUri).toContain(
        `/auth/cli?user_code=${encodeURIComponent(started.userCode)}`,
      );

      const anonymousPage = await server.app.fetch(
        new Request(`http://luna.test/auth/cli?user_code=${started.userCode}`),
      );
      expect(anonymousPage.status).toBe(200);
      const anonymousPageHtml = await anonymousPage.text();
      expect(anonymousPageHtml).toContain("Feishu bot");
      expect(anonymousPageHtml).toContain("One-time token");

      const pending = await server.app.fetch(
        new Request("http://luna.test/api/auth/cli/poll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: started.deviceCode }),
        }),
      );
      expect(pending.status).toBe(200);
      expect(await pending.json()).toEqual({ status: "authorization_pending" });

      runtime.database.db
        .insert(userRowsTable)
        .values({
          id: "local-dashboard-user",
          kind: "human",
          displayName: "Local dashboard user",
          avatarUrl: null,
          status: "active",
          mergedIntoUserId: null,
          profileSource: "dashboard",
          createdAt: "1000",
          updatedAt: "1000",
        })
        .run();
      const channelProof = new AccessTokenService({
        db: runtime.database.db,
        signingSecret: "access-secret",
      }).issueChannelAuthToken({
        userId: "local-dashboard-user",
        channelType: "feishu",
        channelId: "feishu-main",
        channelIdentityId: "local-dashboard-channel-identity",
        purpose: "cli_login",
        ttlMs: 5 * 60 * 1000,
        now: Date.now(),
      });
      const channelConfirm = await server.app.fetch(
        new Request("http://luna.test/api/auth/cli/confirm-channel-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userCode: started.userCode,
            token: channelProof.token,
          }),
        }),
      );
      expect(channelConfirm.status).toBe(200);
      expect(await channelConfirm.json()).toEqual({ status: "approved" });

      const approvedFromChannel = await server.app.fetch(
        new Request("http://luna.test/api/auth/cli/poll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: started.deviceCode }),
        }),
      );
      expect(approvedFromChannel.status).toBe(200);
      const approvedFromChannelBody = await approvedFromChannel.json() as {
        status: string;
        accessToken: string;
        user: { id: string; displayName: string };
      };
      expect(approvedFromChannelBody.status).toBe("approved");
      expect(approvedFromChannelBody.accessToken).toBeString();
      expect(approvedFromChannelBody.user).toEqual({
        id: "local-dashboard-user",
        displayName: "Local dashboard user",
      });

      const secondStart = await server.app.fetch(
        new Request("http://luna.test/api/auth/cli/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      const secondStarted = await secondStart.json() as {
        deviceCode: string;
        userCode: string;
      };

      const cookie = await _dashboardCookie(server, "local-secret");
      const page = await server.app.fetch(
        new Request(`http://luna.test/auth/cli?user_code=${secondStarted.userCode}`, {
          headers: { cookie },
        }),
      );
      expect(page.status).toBe(200);
      const pageHtml = await page.text();
      expect(pageHtml).toContain(secondStarted.userCode);
      expect(pageHtml).toContain("current user and group operation grants");
      expect(pageHtml).toContain("Local dashboard user");

      const confirm = await server.app.fetch(
        new Request("http://luna.test/api/auth/cli/confirm", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ userCode: secondStarted.userCode }),
        }),
      );
      expect(confirm.status).toBe(200);
      expect(await confirm.json()).toEqual({ status: "approved" });

      const approved = await server.app.fetch(
        new Request("http://luna.test/api/auth/cli/poll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: secondStarted.deviceCode }),
        }),
      );
      expect(approved.status).toBe(200);
      const approvedBody = await approved.json() as {
        status: string;
        accessToken: string;
        user: { id: string; displayName: string };
      };
      expect(approvedBody.status).toBe("approved");
      expect(approvedBody.accessToken).toBeString();
      expect(approvedBody.user).toEqual({
        id: "local-dashboard-user",
        displayName: "Local dashboard user",
      });

      const accessTokenMe = await server.app.fetch(
        new Request("http://luna.test/api/auth/me", {
          headers: { authorization: `Bearer ${approvedBody.accessToken}` },
        }),
      );
      expect(accessTokenMe.status).toBe(200);
      expect(await accessTokenMe.json()).toMatchObject({
        status: "ok",
        authenticated: true,
        authKind: "luna-access-token",
        user: {
          id: "local-dashboard-user",
          displayName: "Local dashboard user",
        },
        token: {
          source: "cli",
          role: "user",
        },
      });

      const dashboardMe = await server.app.fetch(
        new Request("http://luna.test/api/auth/me", {
          headers: { cookie },
        }),
      );
      expect(dashboardMe.status).toBe(200);
      expect(await dashboardMe.json()).toMatchObject({
        status: "ok",
        authenticated: true,
        authKind: "dashboard-cookie",
        user: {
          id: "local-dashboard-user",
          displayName: "Local dashboard user",
        },
      });

      const bearerConfirm = await server.app.fetch(
        new Request("http://luna.test/api/auth/cli/confirm", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${approvedBody.accessToken}`,
          },
          body: JSON.stringify({ userCode: secondStarted.userCode }),
        }),
      );
      expect(bearerConfirm.status).toBe(403);
      expect(await bearerConfirm.json()).toMatchObject({
        status: "error",
        code: "dashboard_session_required",
      });

      const bearerTokenList = await server.app.fetch(
        new Request("http://luna.test/api/auth/tokens", {
          headers: { authorization: `Bearer ${approvedBody.accessToken}` },
        }),
      );
      expect(bearerTokenList.status).toBe(403);
      expect(await bearerTokenList.json()).toMatchObject({
        status: "error",
        code: "dashboard_session_required",
      });

      const dashboardDeleteCurrent = await server.app.fetch(
        new Request("http://luna.test/api/auth/tokens/current", {
          method: "DELETE",
          headers: { cookie },
        }),
      );
      expect(dashboardDeleteCurrent.status).toBe(403);
      expect(await dashboardDeleteCurrent.json()).toMatchObject({
        status: "error",
        code: "access_token_required",
      });

      fixturePlatformAdmin(runtime.database.db, "local-dashboard-user");
      const createMcp = await server.app.fetch(
        new Request("http://luna.test/api/auth/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            name: "Local MCP",
            source: "mcp",
          }),
        }),
      );
      expect(createMcp.status).toBe(200);
      const createdMcp = await createMcp.json() as {
        accessToken: string;
        token: { id: string; source: string };
      };
      expect(createdMcp.accessToken).toBeString();
      expect(createdMcp.token.source).toBe("mcp");

      const listed = await server.app.fetch(
        new Request("http://luna.test/api/auth/tokens", {
          headers: { cookie },
        }),
      );
      expect(listed.status).toBe(200);
      const listedBody = await listed.json() as {
        tokens: Array<{ id: string; source: string; token?: string }>;
      };
      expect(listedBody.tokens.map((token) => token.source).sort()).toEqual([
        "cli",
        "cli",
        "mcp",
      ]);
      expect(JSON.stringify(listedBody)).not.toContain(approvedBody.accessToken);

      const deleteMcp = await server.app.fetch(
        new Request(`http://luna.test/api/auth/tokens/${createdMcp.token.id}`, {
          method: "DELETE",
          headers: { cookie },
        }),
      );
      expect(deleteMcp.status).toBe(200);
      expect(await deleteMcp.json()).toEqual({ status: "revoked" });

      const deleteCurrent = await server.app.fetch(
        new Request("http://luna.test/api/auth/tokens/current", {
          method: "DELETE",
          headers: { authorization: `Bearer ${approvedBody.accessToken}` },
        }),
      );
      expect(deleteCurrent.status).toBe(200);
      expect(await deleteCurrent.json()).toEqual({ status: "revoked" });
    } finally {
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      if (previousAccessSecret === undefined) {
        delete process.env.LUNA_ACCESS_TOKEN_SECRET;
      } else {
        process.env.LUNA_ACCESS_TOKEN_SECRET = previousAccessSecret;
      }
      if (previousBunAccessSecret === undefined) {
        delete Bun.env.LUNA_ACCESS_TOKEN_SECRET;
      } else {
        Bun.env.LUNA_ACCESS_TOKEN_SECRET = previousBunAccessSecret;
      }
      runtime.cleanup();
    }
  });

  test("dashboard rejects legacy path based file reads", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-files-root-"));
    const testHome = mkdtempSync(join(tmpdir(), "luna-files-home-"));
    const previousCwd = process.cwd();
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;

    try {
      _writeDashboardDistFixture(testRoot, {
        script: "console.log('luna');\n",
      });
      mkdirSync(join(testHome, "workspace", "uploads", "images"), {
        recursive: true,
      });
      writeFileSync(
        join(testHome, "workspace", "uploads", "images", "topic.jpeg"),
        "image-bytes",
      );
      setLunaHome(testHome);
      process.chdir(testRoot);
      process.env.LUNA_DASHBOARD_TOKEN = "local-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "local-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer();

      const unauthenticated = await server.app.fetch(
        new Request("http://luna.test/api/files/workspace/uploads/images/topic.jpeg"),
      );
      expect(unauthenticated.status).toBe(401);

      const login = await server.app.fetch(
        new Request("http://luna.test/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "local-secret" }),
        }),
      );
      const cookie = login.headers.get("set-cookie") ?? "";
      const fileResponse = await server.app.fetch(
        new Request("http://luna.test/api/files/workspace/uploads/images/topic.jpeg", {
          headers: { cookie },
        }),
      );

      expect(fileResponse.status).toBe(404);

      const traversal = await server.app.fetch(
        new Request("http://luna.test/api/files/../config.yaml", {
          headers: { cookie },
        }),
      );
      expect(traversal.status).toBe(404);
    } finally {
      process.chdir(previousCwd);
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      rmSync(testRoot, { recursive: true, force: true });
      rmSync(testHome, { recursive: true, force: true });
      setLunaHome(homedir() ? join(homedir(), ".luna") : testHome);
    }
  });

  test("dashboard runtime status exposes channel statuses behind auth", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-runtime-status-root-"));
    const testHome = mkdtempSync(join(tmpdir(), "luna-runtime-status-home-"));
    const previousCwd = process.cwd();
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;

    try {
      _writeDashboardDistFixture(testRoot, {
        script: "console.log('luna');\n",
      });
      writeFileSync(
        join(testHome, "config.yaml"),
        [
          "messaging:",
          "  default_channel_id: fake",
          "  channels: []",
          "",
        ].join("\n"),
        "utf-8",
      );
      mkdirSync(join(testHome, "data"), { recursive: true });
      setLunaHome(testHome);
      reloadConfig();
      process.chdir(testRoot);
      process.env.LUNA_DASHBOARD_TOKEN = "local-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "local-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer();

      const unauthenticated = await server.app.fetch(
        new Request("http://luna.test/api/runtime/status"),
      );
      expect(unauthenticated.status).toBe(401);

      const { kernel } = await import("../../src/kernel");
      const kernelState = kernel as unknown as {
        _lunaMessageIngress: unknown;
        _activeAgentConfig: unknown;
      };
      const originalIngress = kernelState._lunaMessageIngress;
      const originalAgentConfig = kernelState._activeAgentConfig;

      try {
        kernelState._lunaMessageIngress = {
          channelStatuses() {
            return [
              {
                id: "feishu-main",
                type: "feishu",
                inbound: {
                  state: "connected",
                  reconnectAttempts: 1,
                },
              },
            ];
          },
        };
        kernelState._activeAgentConfig = {
          resolveExecutionSnapshot() {
            return { agentType: "codex", model: "gpt-5" };
          },
        };

        const cookie = await _dashboardCookie(server, "local-secret");
        const response = await server.app.fetch(
          new Request("http://luna.test/api/runtime/status", {
            headers: { cookie },
          }),
        );

        expect(response.status).toBe(200);
        const responseBody = await response.json() as { agent: unknown };
        expect(responseBody.agent).toBeUndefined();
        expect(responseBody).toMatchObject({
          status: "ok",
          channels: [
            {
              id: "feishu-main",
              type: "feishu",
              inbound: {
                state: "connected",
                reconnectAttempts: 1,
              },
            },
          ],
        });
      } finally {
        kernelState._lunaMessageIngress = originalIngress;
        kernelState._activeAgentConfig = originalAgentConfig;
      }
    } finally {
      process.chdir(previousCwd);
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      rmSync(testRoot, { recursive: true, force: true });
      rmSync(testHome, { recursive: true, force: true });
      setLunaHome(homedir() ? join(homedir(), ".luna") : testHome);
    }
  });

  test("production static server serves real built agent dashboard routes", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBunNodeEnv = Bun.env.NODE_ENV;
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;
    const testRoot = mkdtempSync(join(tmpdir(), "luna-built-static-root-"));
    const previousCwd = process.cwd();

    try {
      _writeDashboardDistFixture(testRoot, {
        script: 'createFileRoute("/sessions/"); createFileRoute("/tasks/$taskId");',
      });
      process.chdir(testRoot);
      process.env.NODE_ENV = "production";
      Bun.env.NODE_ENV = "production";
      process.env.LUNA_DASHBOARD_TOKEN = "static-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "static-secret";

      const { HonoServer } = await import("../../src/server/server");
      const server = new HonoServer();
      const cookie = await _dashboardCookie(server, "static-secret");
      const productionRoutes = [
        "/agent/sessions",
        "/agent/tasks",
        "/agent/tasks/task_1",
      ];

      for (const route of productionRoutes) {
        const shellResponse = await server.app.fetch(
          new Request(`http://luna.test${route}`, {
            headers: { cookie },
          }),
        );
        expect(shellResponse.status).toBe(200);
        const shell = await shellResponse.text();
        expect(shell).toContain('<div id="root"></div>');
        expect(shell).toContain('src="/agent/main.js"');
      }

      const bundleResponse = await server.app.fetch(
        new Request("http://luna.test/agent/main.js"),
      );
      expect(bundleResponse.status).toBe(200);
      const bundle = await bundleResponse.text();
      expect(bundle).toContain('createFileRoute("/sessions/")');
      expect(bundle).not.toContain('createFileRoute("/cases/")');
      const cssResponse = await server.app.fetch(
        new Request("http://luna.test/agent/main.css"),
      );
      expect(cssResponse.status).toBe(200);
      expect(await cssResponse.text()).toContain("display: flex");
    } finally {
      process.chdir(previousCwd);
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousBunNodeEnv === undefined) {
        delete Bun.env.NODE_ENV;
      } else {
        Bun.env.NODE_ENV = previousBunNodeEnv;
      }
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("foreground runtime identity service creates luna database and exposes canonical users", async () => {
    const testHome = mkdtempSync(
      join(tmpdir(), "luna-agent-runtime-test-home-"),
    );
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;

    try {
      await writeRuntimeFixture(testHome);
      mkdirSync(testHome, { recursive: true });
      writeFileSync(
        join(testHome, "config.yaml"),
        `timezone: "Asia/Shanghai"
messaging:
  default_channel_id: ""
  max_visible_steps: 32
  channels: []

session:
  coalesce_idle_ms: 1
  coalesce_max_wait_ms: 25
`,
        "utf-8",
      );
      const port = await _resolveAvailablePort();
      const options = resolveAgentRuntimeOptions({
        LUNA_HOME: testHome,
        LUNA_SERVICE_PORT: String(port),
        LUNA_SHARED_WORKSPACE_DIR: join(testHome, "unmounted-project"),
        LUNA_DASHBOARD_TOKEN: "runtime-secret",
      });
      expect(options.host).toBe("127.0.0.1");
      const started = await startAgentRuntime(options);

      expect(getAgentRuntimeStatus()).toEqual({
        status: "running",
        service: "luna-agent-runtime",
      });

      const healthResponse = await fetch(
        `http://${options.host}:${options.port}/api/health`,
      );
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toMatchObject({ status: "ok" });

      const sessionsResponse = await fetch(
        `http://${options.host}:${options.port}/api/sessions`,
      );
      expect(sessionsResponse.status).toBe(401);

      const { kernel } = await import("../../src/kernel");
      const identityChannel = new FakeFeishuChannel("feishu-identity-e2e");
      const {agent_id: agentId} = fixtureSessionOwnership(kernel.database.db, "feishu", identityChannel.id, "local-dashboard-user");
      fixturePlatformAdmin(kernel.database.db, "local-dashboard-user");
      await kernel.handleInboundMessageForTest(
        identityChannel,
        normalizedInboundFromDirectCallForTest({
          id: "identity-e2e-human",
          channelType: "feishu",
          channelId: identityChannel.id,
          groupId: "group-identity-e2e",
          rootMessageId: "identity-e2e-human",
          senderUserId: "ou_identity_human",
          text: "@Monkey King hello from service verification",
          chatType: "group",
          senderProfile: {
            externalUserId: "ou_identity_human",
            openId: "ou_identity_human",
            unionId: "on_identity_human",
            userId: "user_identity_human",
            tenantKey: "tenant-identity",
            displayName: "Identity Human",
            avatarUrl: "https://avatar.example/identity-human.png",
          },
          mentions: [
            {
              key: "@_user_1",
              openId: "ou_identity_bot",
              userId: "user_identity_bot",
              unionId: "on_identity_bot",
              tenantKey: "tenant-identity",
              name: "Monkey King",
              mentionedType: "bot",
            },
          ],
        } satisfies InboundChannelMessage, {
          environment: "feishu",
          appId: `test:feishu:${identityChannel.id}`,
          developerId: "identity-test-developer",
        }),
      );
      const serviceUser = kernel.database.db
        .select()
        .from(lunaSchema.users)
        .all()
        .find(
          (user) =>
            user.kind === "human" &&
            user.displayName === "Identity Human",
        );
      expect(serviceUser).toBeDefined();
      const serviceToken = new AccessTokenService({
        db: kernel.database.db,
        signingSecret: "runtime-secret",
      }).issueToken({
        userId: serviceUser?.id ?? "",
        name: "Runtime identity verification",
        source: "cli",
        role: "user",
        ttlMs: 30 * 60 * 1000,
        now: Date.now(),
      }).token;

      const accessTokenUsers = await fetch(
        `http://${options.host}:${options.port}/api/users`,
        {
          headers: { authorization: `Bearer ${serviceToken}` },
        },
      );
      expect(accessTokenUsers.status).toBe(403);

      const dashboardLogin = await fetch(
        `http://${options.host}:${options.port}/api/auth/login`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "runtime-secret" }),
        },
      );
      expect(dashboardLogin.status).toBe(200);
      const dashboardCookie = dashboardLogin.headers.get("set-cookie") ?? "";

      const fetchJsonWithAuth = async <T>(path: string): Promise<T> => {
        const response = await fetch(
          `http://${options.host}:${options.port}${path}`,
          {
            headers: { cookie: dashboardCookie },
          },
        );
        expect(response.status).toBe(200);
        return (await response.json()) as T;
      };
      const usersJson = await fetchJsonWithAuth<{
        users: Array<{
          id: string;
          kind: string;
          displayName: string;
          linkedIdentities: Array<{
            identityNamespace: string;
            identityKind: string;
            identityValue: string;
          }>;
          groups: Array<{ id: string; displayName: string }>;
          directGrants: Array<{ operationId: string; effect: string }>;
          indirectGrants: Array<{ operationId: string; effect: string }>;
        }>;
      }>(`/api/users?agentId=${agentId}`);
      const humanUser = usersJson.users.find((user) =>
        user.kind === "human" &&
        user.displayName === "Identity Human"
      );
      const mentionedBotUser = usersJson.users.find((user) =>
        user.kind === "bot" &&
        user.linkedIdentities.some(
          (identity) => identity.identityValue === "ou_identity_bot",
        )
      );
      expect(humanUser).toMatchObject({
        kind: "human",
        displayName: "Identity Human",
        linkedIdentities: expect.arrayContaining([
          expect.objectContaining({
            identityNamespace: "feishu",
            identityKind: "open_id",
            identityValue: "ou_identity_human",
          }),
          expect.objectContaining({
            identityNamespace: "feishu",
            identityKind: "union_id",
            identityValue: "on_identity_human",
          }),
        ]),
        groups: [],
        directGrants: [],
        indirectGrants: [],
      });
      expect(mentionedBotUser).toBeUndefined();

      const dataDir = join(testHome, "data");
      const lunaDbPath = join(dataDir, "luna.db");
      const agentaraDbPath = join(dataDir, "agentara.db");

      expect(existsSync(lunaDbPath)).toBe(true);
      expect(existsSync(agentaraDbPath)).toBe(false);

      const database = new SQLiteDatabase(lunaDbPath, { readonly: true });
      try {
        const tables = database
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          )
          .all()
          .map((row) => row.name);

        for (const tableName of [
          "sessions",
          "session_surface_aliases",
          "messages",
          "message_mentions",
          "session_timeline_entries",
          "session_turn_entries",
          "session_inbox",
          "runner_contexts",
          "task_runs",
        ]) {
          expect(tables).toContain(tableName);
        }

        const sessionColumns = _getTableColumns(
          database,
          "sessions",
        );
        expect(sessionColumns).toContainEqual({
          name: "surface_key",
          notnull: 0,
          type: "TEXT",
        });
        const sessionUniqueIndexes = database
          .query<{ name: string; unique: number }, []>(
            "PRAGMA index_list(sessions)",
          )
          .all()
          .filter((row) => row.unique === 1)
          .map((row) => row.name);
        expect(sessionUniqueIndexes).toContain(
          "sessions_surface_key_unique",
        );

        expect(tables).not.toContain("conversations");
        expect(tables).not.toContain("cases");
        expect(tables).not.toContain("scheduled_tasks");
        const taskRunUniqueIndexes = database
          .query<{ name: string; unique: number }, []>(
            "PRAGMA index_list(task_runs)",
          )
          .all()
          .filter((row) => row.unique === 1)
          .map((row) => row.name);
        expect(taskRunUniqueIndexes).toContain(
          "task_runs_one_running_per_task_unique",
        );
      } finally {
        database.close();
      }

      // The injected adapter is only for this test. Do not start a real Feishu
      // connection when exercising the second runtime startup.
      kernel.database.db.update(lunaSchema.channelConfigs)
        .set({ enabled: false })
        .where(eq(lunaSchema.channelConfigs.id, identityChannel.id))
        .run();

      await stopAgentRuntime();
      expect(getAgentRuntimeStatus()).toEqual({
        status: "stopped",
        service: "luna-agent-runtime",
      });

      await startAgentRuntime(options);
      expect(getAgentRuntimeStatus()).toEqual({
        status: "running",
        service: "luna-agent-runtime",
      });
      await stopAgentRuntime();

      await expect(
        startAgentRuntime({
          ...options,
          port: port === 65535 ? port - 1 : port + 1,
        }),
      ).rejects.toThrow(
        "Agent runtime cannot restart with different options in the same process",
      );
      expect(started).toBeUndefined();
    } finally {
      await stopAgentRuntime();
      if (previousToken === undefined) {
        delete process.env.LUNA_DASHBOARD_TOKEN;
      } else {
        process.env.LUNA_DASHBOARD_TOKEN = previousToken;
      }
      if (previousBunToken === undefined) {
        delete Bun.env.LUNA_DASHBOARD_TOKEN;
      } else {
        Bun.env.LUNA_DASHBOARD_TOKEN = previousBunToken;
      }
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("built runtime initializes a fresh luna database with migrations", () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-dist-runtime-"));
    const port = 19_984;
    const build = Bun.spawnSync([
      "bun",
      "build",
      "src/index.ts",
      "--outdir",
      "dist",
      "--target",
      "bun",
    ]);
    expect(build.exitCode).toBe(0);

    try {
      const smoke = Bun.spawnSync({
        cmd: [
          "bun",
          "-e",
          [
            'import { writePrivateJson } from "@luna/execution-store";',
            'import { writeRuntimeFixture } from "./tests/fixtures/runtime-config";',
            'await writeRuntimeFixture(Bun.env.LUNA_HOME);',
            'const runtime = await import("./dist/index.js");',
            "const options = runtime.resolveAgentRuntimeOptions({",
            `  LUNA_HOME: ${JSON.stringify(testHome)},`,
            '  LUNA_SERVICE_HOST: "127.0.0.1",',
            `  LUNA_SERVICE_PORT: ${JSON.stringify(String(port))},`,
            `  LUNA_SHARED_WORKSPACE_DIR: ${JSON.stringify(join(testHome, "unmounted-project"))},`,
            "});",
            "await runtime.startAgentRuntime(options);",
            "await runtime.stopAgentRuntime();",
            'console.log("ok");',
            "process.exit(0);",
          ].join("\n"),
        ],
        env: {
          ...process.env,
          LUNA_HOME: testHome,
          LUNA_SERVICE_HOST: "127.0.0.1",
          LUNA_SERVICE_PORT: String(port),
        },
      });

      expect(smoke.exitCode).toBe(0);
      expect(smoke.stdout.toString()).toContain("ok");
      expect(existsSync(join(testHome, "data", "luna.db"))).toBe(true);

      const database = new SQLiteDatabase(join(testHome, "data", "luna.db"), {
        readonly: true,
      });
      try {
        const taskTable = database
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
          )
          .get();
        expect(taskTable?.name).toBe("tasks");
      } finally {
        database.close();
      }
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("agent runtime lifecycle boundaries", () => {
  test("Feishu message channel stop closes the inbound websocket client", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    let closeParams: unknown;
    (channel as unknown as { _inboundClient: { close(params: unknown): void } })
      ._inboundClient = {
      close(params: unknown): void {
        closeParams = params;
      },
    };

    await channel.stop();

    expect(closeParams).toEqual({ force: true });
  });

  test("Feishu message channel exposes inbound websocket status", () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    (
      channel as unknown as {
        _inboundClient: {
          getConnectionStatus(): {
            state: string;
            lastConnectTime: number;
            nextConnectTime: number;
            reconnectAttempts: number;
          };
        };
      }
    )._inboundClient = {
      getConnectionStatus() {
        return {
          state: "reconnecting",
          lastConnectTime: 1710000000000,
          nextConnectTime: 1710000005000,
          reconnectAttempts: 2,
        };
      },
    };

    expect(channel.getStatus()).toEqual({
      inbound: {
        state: "reconnecting",
        lastConnectAt: 1710000000000,
        nextConnectAt: 1710000005000,
        reconnectAttempts: 2,
      },
    });
  });

  test("Feishu message channel runtime status overrides stale SDK connected state", () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    (
      channel as unknown as {
        _inboundClient: {
          getConnectionStatus(): {
            state: string;
            lastConnectTime: number;
            reconnectAttempts: number;
          };
        };
        _markInboundReconnecting(): void;
      }
    )._inboundClient = {
      getConnectionStatus() {
        return {
          state: "connected",
          lastConnectTime: 1710000000000,
          reconnectAttempts: 0,
        };
      },
    };

    (
      channel as unknown as {
        _markInboundReconnecting(): void;
      }
    )._markInboundReconnecting();

    expect(channel.getStatus()).toEqual({
      inbound: {
        state: "reconnecting",
        lastConnectAt: 1710000000000,
        reconnectAttempts: 1,
      },
    });
  });

  test("Feishu message channel runtime status reports terminal websocket errors", () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    (
      channel as unknown as {
        _inboundClient: {
          getConnectionStatus(): {
            state: string;
            reconnectAttempts: number;
          };
        };
        _markInboundFailed(err: Error): void;
      }
    )._inboundClient = {
      getConnectionStatus() {
        return {
          state: "connected",
          reconnectAttempts: 0,
        };
      },
    };

    (
      channel as unknown as {
        _markInboundFailed(err: Error): void;
      }
    )._markInboundFailed(new Error("WebSocket reconnect exhausted"));

    expect(channel.getStatus().inbound).toMatchObject({
      state: "failed",
      reconnectAttempts: 0,
      lastError: "WebSocket reconnect exhausted",
    });
    expect(channel.getStatus().inbound?.lastErrorAt).toBeGreaterThan(0);
  });

  test("Luna ingress summarizes registered channel statuses", async () => {
    const env = createRuntimeTestEnvironment();

    class StatusFakeFeishuChannel extends FakeFeishuChannel {
      getStatus() {
        return {
          inbound: {
            state: "connected",
            reconnectAttempts: 0,
          },
        };
      }
    }

    try {
      const ingress = new LunaMessageIngress({
        db: env.database.db,
        runnerType: "mock",
        mainRunner: createDeterministicMainRunner(env.database.db),
        sessionConfig: SessionConfigForTests,
      });
      fixtureSessionOwnership(env.database.db, "feishu", "feishu-main");
      await ingress.registerChannel(new StatusFakeFeishuChannel("feishu-main"));

      expect(ingress.channelStatuses()).toEqual([
        {
          id: "feishu-main",
          type: "feishu",
          inbound: {
            state: "connected",
            reconnectAttempts: 0,
          },
        },
      ]);
    } finally {
      env.cleanup();
    }
  });

  test("test inbound uses the registered channel when injecting into an existing channel id", async () => {
    const env = createRuntimeTestEnvironment();
    const registeredChannel = new FakeFeishuChannel("feishu-main");
    const injectedChannel = new FakeFeishuChannel("feishu-main");
    const sessionQueue = new SessionQueue({
      db: env.database.db,
      config: SessionConfigForTests,
      executeTurn: async () => {},
    });

    try {
      const owner = "runtime-inject-owner";
      const {agent_id: agentId} = fixtureSessionOwnership(env.database.db, "feishu", "feishu-main", owner);
      fixtureObserveFeishuSender(env.database.db, "feishu-main", "ou_user_inject");
      const ingress = new LunaMessageIngress({
        db: env.database.db,
        runnerType: "mock",
        mainRunner: createDeterministicMainRunner(env.database.db),
        sessionConfig: SessionConfigForTests,
        sessionQueue,
      });
      await ingress.registerChannel(registeredChannel);

      await ingress.handleInboundMessageForTest(
        injectedChannel,
        {
          id: "om_injected_existing_channel",
          channel: { type: "feishu", id: "feishu-main" },
          surface: { externalId: "oc_group_inject", kind: "group" },
          sender: fixtureFeishuSender("feishu-main", "ou_user_inject"),
          text: "#work 注入测试",
          mentions: [],
          addressing: { addressedToBot: true, reason: "mention" },
          rawPayload: {},
        },
      );

      expect(
        env.database.db
          .select()
          .from(sessionRowsTable)
          .where(eq(sessionRowsTable.kind, "work"))
          .all(),
      ).toHaveLength(1);
      expect(registeredChannel.outbound).toHaveLength(0);
      expect(injectedChannel.outbound).toHaveLength(0);
    } finally {
      await sessionQueue.stop();
      env.cleanup();
    }
  });

  test("Feishu message channel forwards websocket messages into Luna ingress", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const inboundMessages: NormalizedInboundMessage[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-1" } };
            },
          },
        },
      },
    };
    await channel.subscribeInbound(async (message) => {
      inboundMessages.push(message);
    });

    await (
      channel as unknown as {
        _handleMessageReceive(input: unknown): Promise<void>;
      }
    )._handleMessageReceive({
      sender: {
        sender_id: {
          open_id: "ou_user_1",
          user_id: "user_1",
          union_id: "on_user_1",
        },
        sender_type: "user",
        tenant_key: "tenant-1",
      },
      message: {
        message_id: "om_message_1",
        root_id: "om_root_1",
        create_time: "1780370000000",
        chat_id: "oc_chat_1",
        thread_id: "omt_thread_1",
        chat_type: "group",
        message_type: "text",
        mentions: [
          {
            key: "@_user_1",
            id: {
              open_id: "ou_reporter_1",
              user_id: "user_reporter_1",
              union_id: "on_reporter_1",
            },
            name: "Reporter",
            tenant_key: "tenant-mention",
          },
        ],
        content: JSON.stringify({ text: "@_user_1 线上接口 502，帮忙排查" }),
      },
    });

    expect(inboundMessages).toEqual([
      expect.objectContaining({
        id: "om_message_1",
        channel: expect.objectContaining({ type: "feishu", id: "test-feishu" }),
        surface: expect.objectContaining({
          externalId: "oc_chat_1",
          kind: "group",
          providerIds: { tenant_key: "tenant-1" },
        }),
        thread: expect.objectContaining({
          externalId: "omt_thread_1",
          rootMessageExternalId: "om_root_1",
        }),
        sender: expect.objectContaining({
          externalId: "ou_user_1",
          kind: "user",
          providerIds: {
            open_id: "ou_user_1",
            user_id: "user_1",
            union_id: "on_user_1",
            tenant_key: "tenant-1",
          },
        }),
        text: "@Reporter 线上接口 502，帮忙排查",
        mentions: [
          expect.objectContaining({
            key: "@_user_1",
            label: "@Reporter",
            target: expect.objectContaining({
              externalId: "ou_reporter_1",
              kind: "user",
              providerIds: {
                open_id: "ou_reporter_1",
                user_id: "user_reporter_1",
                union_id: "on_reporter_1",
                tenant_key: "tenant-mention",
              },
            }),
          }),
        ],
      }),
    ]);
  });

  test("Feishu message channel extracts markdown from interactive cards", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const inboundMessages: NormalizedInboundMessage[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-1" } };
            },
          },
        },
      },
    };
    await channel.subscribeInbound(async (message) => {
      inboundMessages.push(message);
    });

    await (
      channel as unknown as {
        _handleMessageReceive(input: unknown): Promise<void>;
      }
    )._handleMessageReceive({
      sender: {
        sender_id: {
          open_id: "ou_user_1",
          user_id: "user_1",
          union_id: "on_user_1",
        },
        sender_type: "user",
        tenant_key: "tenant-1",
      },
      message: {
        message_id: "om_interactive_card_1",
        create_time: "1780370000000",
        chat_id: "oc_chat_1",
        chat_type: "group",
        message_type: "interactive",
        mentions: [
          {
            key: "@_user_1",
            id: {
              open_id: "ou_reporter_1",
              user_id: "user_reporter_1",
              union_id: "on_reporter_1",
            },
            name: "Reporter",
            tenant_key: "tenant-mention",
          },
        ],
        content: JSON.stringify({
          title: null,
          elements: [
            [
              {
                tag: "text",
                text: "请升级至最新版本客户端，以查看内容",
              },
            ],
          ],
          user_dsl: JSON.stringify({
            schema: "2.0",
            body: {
              direction: "vertical",
              elements: [
                {
                  tag: "markdown",
                  content:
                    "<at id=ou_reporter_1 mention_key=@_user_1></at> 📍 **广州今日天气**\n- 🌧️ 天气：**大雨**\n\n📎 [中央气象台广州天气](http://m.nmc.cn/publish/forecast/AGD/guangzhou.html)",
                },
              ],
            },
          }),
        }),
      },
    });

    expect(inboundMessages.at(-1)?.text).toContain("@Reporter 📍 **广州今日天气**");
    expect(inboundMessages.at(-1)?.text).toContain("中央气象台广州天气");
    expect(inboundMessages.at(-1)?.text).not.toContain("Unsupported message type");
    expect(inboundMessages.at(-1)?.presentation).toEqual({
      kind: "rich_markdown_card",
    });
    expect(inboundMessages.at(-1)).toMatchObject({
      contentKind: "card",
      presentationKind: "provider_rich_card",
      providerMessageType: "interactive",
    });
  });

  test("Feishu message channel normalizes post image messages as mixed image gallery blocks", async () => {
    const previousHome = config.paths.home;
    const testHome = mkdtempSync(join(tmpdir(), "luna-feishu-post-kind-"));
    mkdirSync(join(testHome, "data"), { recursive: true });
    setLunaHome(testHome);
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const inboundMessages: NormalizedInboundMessage[] = [];
    let resourceDownloads = 0;
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          messageResource: {
            async get(): Promise<unknown> {
              resourceDownloads += 1;
              return {
                headers: {
                  get(name: string): string | null {
                    return name === "inner_file_data_meta"
                      ? JSON.stringify({
                          FileName: "image",
                          Mime: "image/png",
                        })
                      : null;
                  },
                },
                async writeFile(path: string): Promise<void> {
                  // A 3 × 5 PNG, independent of the Feishu metadata.
                  writeFileSync(path, Buffer.from(
                    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAAAAAClGgl+AAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=",
                    "base64",
                  ));
                },
              };
            },
          },
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-1" } };
            },
          },
        },
      },
    };
    await channel.subscribeInbound(async (message) => {
      inboundMessages.push(message);
    });

    try {
      await (
        channel as unknown as {
          _handleMessageReceive(input: unknown): Promise<void>;
        }
      )._handleMessageReceive({
        sender: {
          sender_id: {
            open_id: "ou_user_1",
            user_id: "user_1",
            union_id: "on_user_1",
          },
          sender_type: "user",
          tenant_key: "tenant-1",
        },
        message: {
          message_id: "om_post_image_1",
          create_time: "1780370000000",
          chat_id: "oc_chat_1",
          chat_type: "group",
          message_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "截图",
              content: [
                [{ tag: "text", text: "请看这张图" }],
                [{ tag: "img", image_key: "img_post_1" }],
              ],
            },
          }),
        },
      });
    } finally {
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    }

    const normalized = inboundMessages.at(-1);
    expect(normalized?.text).toContain("请看这张图");
    expect(normalized?.text).toContain("![image]");
    expect(normalized).toMatchObject({
      contentKind: "mixed",
      presentationKind: "image_gallery",
      providerMessageType: "post",
    });
    expect((normalized as { readonly contentBlocks?: unknown }).contentBlocks)
      .toEqual([
        { type: "text", text: "# 截图" },
        { type: "text", text: "请看这张图" },
        {
          type: "image",
          fileId: "img_post_1",
          url: expect.stringContaining("workspace/uploads/images/"),
          alt: "image",
          width: 3,
          height: 5,
          source: { provider: "feishu", imageKey: "img_post_1" },
        },
      ]);
    expect(resourceDownloads).toBe(1);
  });

  test("Luna persists channel content metadata from normalized inbound messages", async () => {
    const env = createRuntimeTestEnvironment();
    fixtureSessionOwnership(env.database.db, "feishu", "feishu-main");
    const channel = new FakeFeishuChannel("feishu-main");
    const imagePath = join(
      config.paths.workspace,
      "uploads",
      "images",
      "img_persisted_1.jpeg",
    );
    mkdirSync(join(config.paths.workspace, "uploads", "images"), {
      recursive: true,
    });
    writeFileSync(imagePath, "image-bytes");
    const ingress = new LunaMessageIngress({
      db: env.database.db,
      runnerType: "mock",
      sessionConfig: SessionConfigForTests,
    });

    try {
      await ingress.handleInboundMessageForTest(
        channel,
        {
          id: "om_interactive_persisted_1",
          channel: { type: "feishu", id: "feishu-main" },
          surface: { externalId: "oc_group_1", kind: "group" },
          sender: {
            externalId: "ou_user_1",
            kind: "user",
            requesterIdentity: {
              provider: "local",
              externalUserId: "ou_user_1",
              canonicalUserId: "canonical-user-1",
            },
          },
          text: "卡片正文",
          contentBlocks: [
            { type: "text", text: "卡片正文" },
            {
              type: "image",
              fileId: "img_persisted_1",
              width: 3,
              height: 5,
              url: "workspace/uploads/images/img_persisted_1.jpeg",
            },
          ],
          mentions: [],
          addressing: { addressedToBot: false, reason: "silent_group" },
          contentKind: "mixed",
          presentationKind: "image_gallery",
          providerMessageType: "post",
        } as NormalizedInboundMessage,
      );

      const storedMessage = env.database.sqlite
        .query(
          "SELECT content_kind, presentation_kind, provider_message_type, content_json FROM messages WHERE external_message_id = 'om_interactive_persisted_1'",
        )
        .get() as {
        content_kind: string;
        presentation_kind: string;
        provider_message_type: string | null;
        content_json: string;
      } | null;
      expect(storedMessage).toMatchObject({
        content_kind: "mixed",
        presentation_kind: "image_gallery",
        provider_message_type: "post",
      });
      expect(JSON.parse(storedMessage?.content_json ?? "[]")).toEqual([
        { type: "text", text: "卡片正文" },
        {
          type: "image",
          fileId: "img_persisted_1",
          width: 3,
          height: 5,
          url: expect.stringMatching(/^artifact:/),
        },
      ]);
      const artifacts = env.database.db.select().from(managedArtifacts).all();
      expect(artifacts).toEqual([
        expect.objectContaining({
          related_user_id: "canonical-user-1",
          producer: "feishu",
          kind: "image",
          status: "active",
        }),
      ]);
    } finally {
      env.cleanup();
    }
  });

  test("Feishu message channel normalizes text topic card payloads as rich cards", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const inboundMessages: NormalizedInboundMessage[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-1" } };
            },
          },
        },
      },
    };
    await channel.subscribeInbound(async (message) => {
      inboundMessages.push(message);
    });

    await (
      channel as unknown as {
        _handleMessageReceive(input: unknown): Promise<void>;
      }
    )._handleMessageReceive({
      sender: {
        sender_id: {
          open_id: "ou_user_1",
          user_id: "user_1",
          union_id: "on_user_1",
        },
        sender_type: "user",
        tenant_key: "tenant-1",
      },
      message: {
        message_id: "om_topic_card_1",
        create_time: "1780370000000",
        chat_id: "oc_chat_1",
        chat_type: "group",
        message_type: "text",
        mentions: [
          {
            key: "@_user_1",
            id: {
              open_id: "ou_bot",
              user_id: "bot_user",
              union_id: "on_bot",
            },
            name: "Monkey King",
            tenant_key: "tenant-mention",
          },
        ],
        content: {
          card_type: "topic",
          title: "话题：排查登录失败",
          description:
            "<at id=ou_bot mention_key=@_user_1></at> 请看这个话题，用户登录失败。",
          url: "https://applink.feishu.cn/client/chat/chatter/topic/thread_1",
        },
      },
    });

    expect(inboundMessages.at(-1)?.text).toContain("话题：排查登录失败");
    expect(inboundMessages.at(-1)?.text).toContain("@Monkey King 请看这个话题");
    expect(inboundMessages.at(-1)?.text).toContain(
      "https://applink.feishu.cn/client/chat/chatter/topic/thread_1",
    );
    expect(inboundMessages.at(-1)?.presentation).toEqual({
      kind: "rich_markdown_card",
    });
  });

  test("Feishu message channel normalizes merge-forward topic cards as rich cards", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
        botOpenId: "ou_bot_1",
        groupBotAliases: ["Monkey King"],
      },
    );
    const inboundMessages: NormalizedInboundMessage[] = [];
    let getMessageCalls = 0;
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          message: {
            async get(input: unknown): Promise<unknown> {
              getMessageCalls += 1;
              expect(input).toEqual({
                path: { message_id: "om_merge_forward_1" },
              });
              return {
                data: {
                  items: [
                    {
                      message_id: "om_merge_forward_1",
                      create_time: "1780370000000",
                      msg_type: "merge_forward",
                    },
                    {
                      message_id: "om_nested_forward_1",
                      upper_message_id: "om_merge_forward_1",
                      create_time: "1780370001000",
                      msg_type: "merge_forward",
                      sender: { id: "ou_user_1" },
                      body: {
                        content: "Nested topic forward",
                      },
                    },
                    {
                      message_id: "om_topic_child_1",
                      upper_message_id: "om_nested_forward_1",
                      create_time: "1780370002000",
                      msg_type: "text",
                      sender: { id: "ou_user_1" },
                      body: {
                        content: {
                          card_type: "topic",
                          title: "话题：排查登录失败",
                          description: "用户登录失败，请看这个话题。",
                          url: "https://applink.feishu.cn/client/chat/chatter/topic/thread_1",
                        },
                      },
                    },
                    {
                      message_id: "om_post_child_1",
                      upper_message_id: "om_nested_forward_1",
                      create_time: "1780370002500",
                      msg_type: "post",
                      sender: {
                        id: "ou_original_reporter",
                        id_type: "open_id",
                        name: "刘琳",
                        display_name: "刘琳",
                        avatar_url: "https://avatar.example/liulin.png",
                        sender_type: "user",
                        tenant_key: "tenant-1",
                      },
                      body: {
                        content: JSON.stringify({
                          title: "",
                          content: [
                            [
                              {
                                tag: "img",
                                image_key: "img_unavailable",
                                width: 1080,
                                height: 2348,
                              },
                            ],
                            [
                              { tag: "text", text: "示例浏览器", style: [] },
                              {
                                tag: "emotion",
                                emoji_type: "Lark_Emoji_Facepalm_0",
                              },
                              {
                                tag: "emotion",
                                emoji_type: "Lark_Emoji_Facepalm_0",
                              },
                            ],
                            [{ tag: "text", text: "仙逆144集", style: [] }],
                          ],
                        }),
                      },
                    },
                    {
                      message_id: "om_comment_child_1",
                      upper_message_id: "om_nested_forward_1",
                      create_time: "1780370003000",
                      msg_type: "text",
                      sender: {
                        id: "ou_comment_sender",
                        id_type: "open_id",
                        name: "陆雨",
                        display_name: "陆雨",
                        sender_type: "user",
                        tenant_key: "tenant-1",
                      },
                      mentions: [
                        {
                          id: "ou_mentioned_user",
                          id_type: "open_id",
                          key: "@_user_1",
                          name: "吕嘉宁",
                          tenant_key: "tenant-1",
                        },
                      ],
                      body: {
                        content: JSON.stringify({
                          text: "@_user_1 这种检测不出来吗 css",
                        }),
                      },
                    },
                    {
                      message_id: "om_bot_reply_child_1",
                      upper_message_id: "om_nested_forward_1",
                      create_time: "1780370004000",
                      msg_type: "text",
                      sender: {
                        id: "cli_0000000000000000",
                        id_type: "app_id",
                        sender_type: "app",
                        tenant_key: "tenant-1",
                      },
                      body: {
                        content: JSON.stringify({
                          text: "老大，新增信息我收到了",
                        }),
                      },
                    },
                    {
                      message_id: "om_mentioned_sender_child_1",
                      upper_message_id: "om_nested_forward_1",
                      create_time: "1780370005000",
                      msg_type: "text",
                      sender: {
                        id: "ou_mentioned_user",
                        id_type: "open_id",
                        sender_type: "user",
                        tenant_key: "tenant-1",
                      },
                      body: {
                        content: JSON.stringify({
                          text: "scc",
                        }),
                      },
                    },
                  ],
                },
              };
            },
          },
          messageResource: {
            async get(input: unknown): Promise<unknown> {
              expect(input).toEqual({
                path: {
                  message_id: "om_merge_forward_1",
                  file_key: "img_unavailable",
                },
                params: {
                  type: "file",
                },
              });
              return {
                headers: {
                  get(name: string): string | null {
                    return name === "inner_file_data_meta"
                      ? JSON.stringify({
                          FileName: "image",
                          Mime: "image/jpeg",
                        })
                      : null;
                  },
                },
                async writeFile(): Promise<void> {},
              };
            },
          },
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-1" } };
            },
          },
        },
      },
    };
    await channel.subscribeInbound(async (message) => {
      inboundMessages.push(message);
    });

    await (
      channel as unknown as {
        _handleMessageReceive(input: unknown): Promise<void>;
      }
    )._handleMessageReceive({
      sender: {
        sender_id: {
          open_id: "ou_user_1",
          user_id: "user_1",
          union_id: "on_user_1",
        },
        sender_type: "user",
        tenant_key: "tenant-1",
      },
      message: {
        message_id: "om_merge_forward_1",
        create_time: "1780370000000",
        chat_id: "oc_chat_1",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: "Merged and Forwarded Message",
      },
    });

    expect(inboundMessages.at(-1)?.text).toContain("话题：排查登录失败");
    expect(inboundMessages.at(-1)?.text).toContain("用户登录失败，请看这个话题。");
    expect(inboundMessages.at(-1)?.text).toContain("![image](");
    expect(inboundMessages.at(-1)?.text).toContain("示例浏览器");
    expect(inboundMessages.at(-1)?.text).toContain(
      "@刘琳\n![image](",
    );
    expect(inboundMessages.at(-1)?.text).toContain(
      "[emotion:Lark_Emoji_Facepalm_0]",
    );
    expect(inboundMessages.at(-1)?.text).toContain("仙逆144集");
    expect(inboundMessages.at(-1)?.text).toContain(
      "@陆雨\n@吕嘉宁 这种检测不出来吗 css",
    );
    expect(inboundMessages.at(-1)?.text).toContain(
      "@Monkey King\n老大，新增信息我收到了",
    );
    expect(inboundMessages.at(-1)?.text).toContain(
      "@吕嘉宁\nscc",
    );
    expect(inboundMessages.at(-1)?.text).not.toContain(
      "@ou_mentioned_user\nscc",
    );
    expect(inboundMessages.at(-1)?.text).not.toContain(
      "@cli_0000000000000000\n老大，新增信息我收到了",
    );
    expect(inboundMessages.at(-1)?.text).not.toContain(
      "合并转发消息（未读取到可展示内容）",
    );
    expect(inboundMessages.at(-1)?.text).toContain(
      "https://applink.feishu.cn/client/chat/chatter/topic/thread_1",
    );
    expect(inboundMessages.at(-1)?.presentation).toEqual({
      kind: "rich_markdown_card",
    });
    expect(inboundMessages.at(-1)?.mentions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "om_post_child_1:@sender",
        label: "@刘琳",
        target: expect.objectContaining({
          externalId: "ou_original_reporter",
          kind: "user",
          displayName: "刘琳",
          avatarUrl: "https://avatar.example/liulin.png",
        }),
      }),
      expect.objectContaining({
        key: "om_comment_child_1:@sender",
        label: "@陆雨",
        target: expect.objectContaining({
          externalId: "ou_comment_sender",
          kind: "user",
          displayName: "陆雨",
        }),
      }),
      expect.objectContaining({
        key: "om_bot_reply_child_1:@sender",
        label: "@Monkey King",
        target: expect.objectContaining({
          externalId: "ou_bot_1",
          kind: "bot",
          displayName: "Monkey King",
          providerIds: expect.objectContaining({
            app_id: "cli_0000000000000000",
            open_id: "ou_bot_1",
            tenant_key: "tenant-1",
          }),
        }),
      }),
      expect.objectContaining({
        key: "om_comment_child_1:@_user_1",
        label: "@吕嘉宁",
        target: expect.objectContaining({
          externalId: "ou_mentioned_user",
          kind: "user",
          displayName: "吕嘉宁",
          providerIds: {
            open_id: "ou_mentioned_user",
            tenant_key: "tenant-1",
          },
        }),
      }),
      expect.objectContaining({
        key: "om_mentioned_sender_child_1:@sender",
        label: "@吕嘉宁",
        target: expect.objectContaining({
          externalId: "ou_mentioned_user",
          kind: "user",
          displayName: "吕嘉宁",
          providerIds: {
            open_id: "ou_mentioned_user",
            tenant_key: "tenant-1",
          },
        }),
      }),
    ]));
    expect(
      (
        inboundMessages.at(-1) as
          | (NormalizedInboundMessage & {
              readonly relatedIdentities?: readonly unknown[];
            })
          | undefined
      )?.relatedIdentities,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "ou_original_reporter",
          kind: "user",
          displayName: "刘琳",
          avatarUrl: "https://avatar.example/liulin.png",
          providerIds: {
            open_id: "ou_original_reporter",
            tenant_key: "tenant-1",
          },
        }),
        expect.objectContaining({
          externalId: "ou_comment_sender",
          kind: "user",
          displayName: "陆雨",
          providerIds: {
            open_id: "ou_comment_sender",
            tenant_key: "tenant-1",
          },
        }),
        expect.objectContaining({
          externalId: "ou_bot_1",
          kind: "bot",
          displayName: "Monkey King",
          providerIds: expect.objectContaining({
            app_id: "cli_0000000000000000",
            open_id: "ou_bot_1",
            tenant_key: "tenant-1",
          }),
        }),
      ]),
    );
    expect(getMessageCalls).toBe(1);
  });

  test("Feishu message channel logs compact user profile lookup failures", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const warnings: Array<{
      readonly details: Record<string, unknown>;
      readonly message: string | undefined;
    }> = [];
    (channel as unknown as { _logger: unknown })._logger = {
      info(): void {},
      warn(details: Record<string, unknown>, message?: string): void {
        warnings.push({ details, message });
      },
      error(): void {},
    };
    (channel as unknown as { _client: unknown })._client = {
      contact: {
        v3: {
          user: {
            async get(): Promise<unknown> {
              throw {
                response: {
                  status: 400,
                  data: {
                    code: 400,
                    msg: "invalid user id",
                  },
                },
              };
            },
          },
        },
      },
    };

    const profile = await (
      channel as unknown as {
        _resolveFeishuUserProfile(
          sender: MessageReceiveEventData["sender"],
        ): Promise<unknown>;
      }
    )._resolveFeishuUserProfile({
      sender_id: { open_id: "ou_missing_user" },
      sender_type: "user",
      tenant_key: "tenant-1",
      display_name: "缺失用户",
    });

    expect(profile).toMatchObject({
      externalUserId: "ou_missing_user",
      displayName: "缺失用户",
    });
    expect(warnings).toEqual([
      {
        details: {
          channel_id: "test-feishu",
          external_user_id: "ou_missing_user",
          status: 400,
          code: 400,
          message: "invalid user id",
        },
        message:
          "Failed to resolve Feishu user profile; falling back to event sender identity",
      },
    ]);
  });

  test("Feishu message channel resolves app sender profile by app_id", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const requests: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      async request(input: unknown): Promise<unknown> {
        requests.push(input);
        return {
          data: {
            app: {
              app_id: "cli_other_bot",
              app_name: "Monkey King",
              avatar_url: "https://avatar.example/monkey-king.png",
            },
          },
        };
      },
    };

    const profile = await (
      channel as unknown as {
        _resolveFeishuUserProfile(
          sender: MessageReceiveEventData["sender"],
        ): Promise<unknown>;
      }
    )._resolveFeishuUserProfile({
      sender_id: { app_id: "cli_other_bot" },
      sender_type: "app",
      tenant_key: "tenant-1",
    });

    expect(requests).toEqual([
      {
        url: "/open-apis/application/v6/applications/cli_other_bot",
        method: "GET",
      },
    ]);
    expect(profile).toMatchObject({
      externalUserId: "cli_other_bot",
      userType: "bot",
      appId: "cli_other_bot",
      name: "Monkey King",
      displayName: "Monkey King",
      avatarUrl: "https://avatar.example/monkey-king.png",
      tenantKey: "tenant-1",
    });
  });

  test("Feishu message channel logs compact app profile lookup failures", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const warnings: Array<{
      readonly details: Record<string, unknown>;
      readonly message: string | undefined;
    }> = [];
    (channel as unknown as { _logger: unknown })._logger = {
      info(): void {},
      warn(details: Record<string, unknown>, message?: string): void {
        warnings.push({ details, message });
      },
      error(): void {},
    };
    (channel as unknown as { _client: unknown })._client = {
      async request(): Promise<unknown> {
        throw {
          response: {
            status: 400,
            data: {
              code: 400,
              msg: "invalid app id",
            },
          },
        };
      },
    };

    const profile = await (
      channel as unknown as {
        _resolveFeishuUserProfile(
          sender: MessageReceiveEventData["sender"],
        ): Promise<unknown>;
      }
    )._resolveFeishuUserProfile({
      sender_id: { app_id: "cli_missing_bot" },
      sender_type: "app",
      tenant_key: "tenant-1",
      display_name: "缺失机器人",
    });

    expect(profile).toMatchObject({
      externalUserId: "cli_missing_bot",
      userType: "bot",
      appId: "cli_missing_bot",
      displayName: "缺失机器人",
      tenantKey: "tenant-1",
    });
    expect(warnings).toEqual([
      {
        details: {
          channel_id: "test-feishu",
          app_id: "cli_missing_bot",
          status: 400,
          code: 400,
          message: "invalid app id",
        },
        message:
          "Failed to resolve Feishu app profile; falling back to event sender identity",
      },
    ]);
  });

  test("Feishu message channel enriches non-Luna bot mentions without flipping addressing", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    (channel as unknown as { _client: unknown })._client = {
      contact: {
        v3: {
          user: {
            async get(): Promise<unknown> {
              throw {
                response: {
                  status: 403,
                  data: {
                    code: 41050,
                    msg: "no user authority error",
                  },
                },
              };
            },
          },
        },
      },
      async request(input: { url: string; method: string }): Promise<unknown> {
        expect(input.method).toBe("GET");
        if (input.url.includes("/members/is_in_chat?")) {
          return { data: { is_in_chat: true } };
        }
        if (input.url.includes("/members?")) {
          return {
            data: {
              items: [
                {
                  member_id: "ou_human_only",
                  member_id_type: "open_id",
                  name: "Only Human",
                },
              ],
              has_more: false,
            },
          };
        }
        throw new Error(`Unexpected request: ${input.url}`);
      },
    };

    const enriched = await (
      channel as unknown as {
        _enrichMentionTargetsInMessage(input: {
          readonly message: NormalizedInboundMessage;
          readonly chatProfile?: {
            readonly externalChatId?: string;
            readonly rawProfile?: unknown;
          };
        }): Promise<NormalizedInboundMessage>;
      }
    )._enrichMentionTargetsInMessage({
      message: {
        id: "om_message_mention_other_bot",
        channel: { type: "feishu", id: "test-feishu" },
        surface: {
          externalId: "oc_chat_1",
          kind: "group",
        },
        sender: {
          externalId: "ou_human_only",
          kind: "user",
        },
        text: "@影视Aime助理 你来处理",
        mentions: [
          {
            key: "@_user_1",
            label: "@影视Aime助理",
            target: {
              externalId: "ou_other_bot",
              kind: "user",
              displayName: "影视Aime助理",
              providerIds: {
                open_id: "ou_other_bot",
                tenant_key: "tenant-1",
              },
              rawProfile: {
                key: "@_user_1",
                id: { open_id: "ou_other_bot" },
                name: "影视Aime助理",
                tenant_key: "tenant-1",
              },
            },
          },
        ],
        addressing: {
          addressedToBot: false,
          reason: "silent_group",
        },
      },
      chatProfile: {
        externalChatId: "oc_chat_1",
        rawProfile: {
          user_count: "1",
        },
      },
    });

    expect(enriched.addressing).toEqual({
      addressedToBot: false,
      reason: "silent_group",
    });
    expect(enriched.mentions).toEqual([
      expect.objectContaining({
        key: "@_user_1",
        target: expect.objectContaining({
          externalId: "ou_other_bot",
          kind: "bot",
          displayName: "影视Aime助理",
          providerIds: {
            open_id: "ou_other_bot",
            tenant_key: "tenant-1",
          },
          rawProfile: expect.objectContaining({
            mentioned_type: "bot",
          }),
        }),
      }),
    ]);
  });

  test("Feishu message channel auto-resolves bot identity for group mention activation", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    (channel as unknown as { _client: unknown })._client = {
      async request(input: unknown): Promise<unknown> {
        expect(input).toEqual({ url: "/open-apis/bot/v3/info", method: "GET" });
        return {
          bot: {
            open_id: "ou_bot",
            avatar_url: "https://avatar.example/bot.png",
          },
        };
      },
      im: {
        v1: {
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-1" } };
            },
          },
        },
      },
    };
    (channel as unknown as { _inboundClient: { start(input: unknown): Promise<void> } })
      ._inboundClient = {
      async start(): Promise<void> {
        return undefined;
      },
    };
    const inboundMessages: NormalizedInboundMessage[] = [];
    await channel.subscribeInbound(async (message) => {
      inboundMessages.push(message);
    });

    await channel.start();
    await (
      channel as unknown as {
        _handleMessageReceive(input: unknown): Promise<void>;
      }
    )._handleMessageReceive({
      sender: {
        sender_id: {
          open_id: "ou_user_1",
        },
        sender_type: "user",
      },
      message: {
        message_id: "om_message_1",
        create_time: "1780370000000",
        chat_id: "oc_chat_1",
        chat_type: "group",
        message_type: "text",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_bot" },
            name: "Monkey King",
          },
        ],
        content: JSON.stringify({ text: "@_user_1 帮忙看看" }),
      },
    });

    expect(inboundMessages[0]?.addressing).toEqual({
      addressedToBot: true,
      reason: "mention",
    });
    expect(inboundMessages[0]?.text).toBe("@Monkey King 帮忙看看");
    expect(inboundMessages[0]?.mentions).toEqual([
      expect.objectContaining({
        key: "@_user_1",
        label: "@Monkey King",
        target: expect.objectContaining({
          externalId: "ou_bot",
          kind: "bot",
          avatarUrl: "https://avatar.example/bot.png",
          providerIds: { open_id: "ou_bot" },
        }),
      }),
    ]);
  });

  test("Feishu message channel triggers group join history backfill on bot-added events", async () => {
    const channel = new FeishuMessageChannel("test-feishu", {
      chatId: "chat-id",
      appId: "cli_0000000000000000",
      appSecret: "app-secret",
    });
    const calls: unknown[] = [];
    (
      channel as unknown as {
        _groupJoinBackfill: {
          backfillOnBotAddedToGroup(input: unknown): Promise<unknown>;
        };
      }
    )._groupJoinBackfill = {
      async backfillOnBotAddedToGroup(input: unknown): Promise<unknown> {
        calls.push(input);
        return { importedCount: 2, skippedCount: 0 };
      },
    };

    await (
      channel as unknown as {
        _handleBotAddedToGroup(input: unknown): Promise<void>;
      }
    )._handleBotAddedToGroup({
      event_id: "evt_bot_added_1",
      chat_id: "oc_chat_1",
      create_time: "1780370000000",
      tenant_key: "tenant-1",
      operator_id: {
        open_id: "ou_operator_1",
      },
    });

    expect(calls).toEqual([
      {
        eventId: "evt_bot_added_1",
        channelType: "feishu",
        channelId: "test-feishu",
        chatId: "oc_chat_1",
        occurredAt: 1780370000000,
        tenantKey: "tenant-1",
        operatorOpenId: "ou_operator_1",
      },
    ]);
  });

  test("Feishu message channel clears processing reaction after Luna reply", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const reactionCreates: unknown[] = [];
    const reactionDeletes: unknown[] = [];
    const plainReplies: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          messageReaction: {
            async create(input: unknown): Promise<unknown> {
              reactionCreates.push(input);
              return { data: { reaction_id: "reaction-1" } };
            },
            async delete(input: unknown): Promise<void> {
              reactionDeletes.push(input);
            },
          },
        },
        message: {
          async reply(input: unknown): Promise<unknown> {
            plainReplies.push(input);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };
    await channel.subscribeInbound(async () => undefined);

    await (
      channel as unknown as {
        _handleMessageReceive(input: unknown): Promise<void>;
      }
    )._handleMessageReceive({
      sender: {
        sender_id: {
          open_id: "ou_user_1",
        },
        sender_type: "user",
      },
      message: {
        message_id: "om_message_1",
        create_time: "1780370000000",
        chat_id: "oc_chat_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hi" }),
      },
    });

    await channel.beginProcessing(feishuInboundForChannel({
      id: "om_message_1",
      channelType: "feishu",
      channelId: "test-feishu",
      groupId: "oc_chat_1",
      senderUserId: "ou_user_1",
      text: "hi",
    }));

    expect(reactionCreates).toHaveLength(1);
    expect(reactionCreates[0]).toMatchObject({
      path: { message_id: "om_message_1" },
      data: {
        reaction_type: {
          emoji_type: expect.any(String),
        },
      },
    });
    expect(reactionDeletes).toEqual([]);

    await channel.send(
      feishuInboundForChannel({
        id: "om_message_1",
        channelType: "feishu",
        channelId: "test-feishu",
        groupId: "oc_chat_1",
        senderUserId: "ou_user_1",
        text: "hi",
      }),
      {
        replyMode: "channel_message",
        targetMessageId: "om_message_1",
        content: "hello",
      },
    );

    expect(plainReplies).toEqual([
      {
        path: { message_id: "om_message_1" },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    ]);
    expect(reactionDeletes).toEqual([
      {
        path: { message_id: "om_message_1", reaction_id: "reaction-1" },
      },
    ]);
  });

  test("Feishu message channel keeps processing reaction until completion when Luna ingress only enqueues", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const reactionCreates: unknown[] = [];
    const reactionDeletes: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          messageReaction: {
            async create(input: unknown): Promise<unknown> {
              reactionCreates.push(input);
              return { data: { reaction_id: "reaction-1" } };
            },
            async delete(input: unknown): Promise<void> {
              reactionDeletes.push(input);
            },
          },
        },
      },
    };
    await channel.subscribeInbound(async () => undefined);

    await (
      channel as unknown as {
        _handleMessageReceive(input: unknown): Promise<void>;
      }
    )._handleMessageReceive({
      sender: {
        sender_id: {
          open_id: "ou_user_1",
        },
        sender_type: "user",
      },
      message: {
        message_id: "om_message_1",
        create_time: "1780370000000",
        chat_id: "oc_chat_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hi" }),
      },
    });

    await channel.beginProcessing(feishuInboundForChannel({
      id: "om_message_1",
      channelType: "feishu",
      channelId: "test-feishu",
      groupId: "oc_chat_1",
      senderUserId: "ou_user_1",
      text: "hi",
    }));

    expect(reactionCreates).toHaveLength(1);
    expect(reactionCreates[0]).toMatchObject({
      path: { message_id: "om_message_1" },
      data: {
        reaction_type: {
          emoji_type: expect.any(String),
        },
      },
    });
    expect(reactionDeletes).toEqual([]);

    await channel.completeProcessing(feishuInboundForChannel({
      id: "om_message_1",
      channelType: "feishu",
      channelId: "test-feishu",
      groupId: "oc_chat_1",
      senderUserId: "ou_user_1",
      text: "hi",
    }));

    expect(reactionDeletes).toEqual([
      {
        path: { message_id: "om_message_1", reaction_id: "reaction-1" },
      },
    ]);
  });

  test("Feishu message channel clears persisted processing marker after restart", async () => {
    const previousHome = config.paths.home;
    const env = createRuntimeTestEnvironment();
    const inbound = feishuInboundForChannel({
      id: "om_message_1",
      channelType: "feishu",
      channelId: "test-feishu",
      groupId: "oc_chat_1",
      senderUserId: "ou_user_1",
      text: "hi",
    });
    const reactionDeletes: unknown[] = [];

    try {
      const firstChannel = new FeishuMessageChannel(
        "test-feishu",
        {
          chatId: "chat-id",
          appId: "cli_0000000000000000",
          appSecret: "app-secret",
          db: env.database.db,
        },
      );
      (firstChannel as unknown as { _client: unknown })._client = {
        im: {
          v1: {
            messageReaction: {
              async create(): Promise<unknown> {
                return { data: { reaction_id: "reaction-1" } };
              },
            },
          },
        },
      };

      await firstChannel.beginProcessing(inbound);

      const restartedChannel = new FeishuMessageChannel(
        "test-feishu",
        {
          chatId: "chat-id",
          appId: "cli_0000000000000000",
          appSecret: "app-secret",
          db: env.database.db,
        },
      );
      (restartedChannel as unknown as { _client: unknown })._client = {
        im: {
          v1: {
            messageReaction: {
              async delete(input: unknown): Promise<void> {
                reactionDeletes.push(input);
              },
            },
          },
        },
      };

      await restartedChannel.completeProcessing(inbound);

      expect(reactionDeletes).toEqual([
        {
          path: { message_id: "om_message_1", reaction_id: "reaction-1" },
        },
      ]);
      expect(env.database.db.select().from(lunaSchema.channelMessageMarkers).all())
        .toEqual([]);
    } finally {
      env.cleanup();
      setLunaHome(previousHome);
    }
  });

  test("Feishu message channel keeps persisted processing marker when cleanup fails", async () => {
    const previousHome = config.paths.home;
    const env = createRuntimeTestEnvironment();
    const inbound = feishuInboundForChannel({
      id: "om_message_1",
      channelType: "feishu",
      channelId: "test-feishu",
      groupId: "oc_chat_1",
      senderUserId: "ou_user_1",
      text: "hi",
    });

    try {
      const firstChannel = new FeishuMessageChannel(
        "test-feishu",
        {
          chatId: "chat-id",
          appId: "cli_0000000000000000",
          appSecret: "app-secret",
          db: env.database.db,
        },
      );
      (firstChannel as unknown as { _client: unknown })._client = {
        im: {
          v1: {
            messageReaction: {
              async create(): Promise<unknown> {
                return { data: { reaction_id: "reaction-1" } };
              },
            },
          },
        },
      };

      await firstChannel.beginProcessing(inbound);

      const restartedChannel = new FeishuMessageChannel(
        "test-feishu",
        {
          chatId: "chat-id",
          appId: "cli_0000000000000000",
          appSecret: "app-secret",
          db: env.database.db,
        },
      );
      (restartedChannel as unknown as { _client: unknown })._client = {
        im: {
          v1: {
            messageReaction: {
              async delete(): Promise<void> {
                throw new Error("simulated delete failure");
              },
            },
          },
        },
      };

      await restartedChannel.completeProcessing(inbound);

      const rows = env.database.db
        .select()
        .from(lunaSchema.channelMessageMarkers)
        .all();
      expect(rows).toMatchObject([
        {
          channelType: "feishu",
          channelId: "test-feishu",
          messageId: "om_message_1",
          markerType: "processing",
          providerMarkerId: "reaction-1",
          providerPayloadJson: expect.objectContaining({
            reactionType: expect.any(String),
          }),
        },
      ]);
    } finally {
      env.cleanup();
      setLunaHome(previousHome);
    }
  });

  test("Feishu message channel chooses processing reaction from candidate list", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const reactionCreates: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          messageReaction: {
            async create(input: unknown): Promise<unknown> {
              reactionCreates.push(input);
              return { data: { reaction_id: "reaction-1" } };
            },
          },
        },
      },
    };

    await channel.beginProcessing(feishuInboundForChannel({
      id: "om_message_1",
      channelType: "feishu",
      channelId: "test-feishu",
      groupId: "oc_chat_1",
      senderUserId: "ou_user_1",
      text: "hi",
    }));

    const emojiType = feishuReactionCreateEmojiType(reactionCreates[0]);
    expect(
      FEISHU_PROCESSING_REACTION_CANDIDATES.some(
        (candidate) => candidate === emojiType,
      ),
    ).toBe(true);
  });

  test("Feishu message channel sends ordinary thread replies as text", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const replies: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };

    await channel.send(
      feishuInboundForChannel({
        id: "om_message_1",
        channelType: "feishu",
        channelId: "test-feishu",
        groupId: "oc_chat_1",
        threadId: "omt_thread_1",
        senderUserId: "ou_user_1",
        text: "今天有用户反馈进去清爽模式失败",
      }),
      {
        replyMode: "reply_in_thread",
        targetMessageId: "omt_thread_1",
        content: "请补充反馈时间点、did/uid 和失败表现。",
      },
    );

    expect(replies).toEqual([
      {
        path: { message_id: "om_message_1" },
        data: {
          msg_type: "text",
          content: JSON.stringify({
            text: "请补充反馈时间点、did/uid 和失败表现。",
          }),
          reply_in_thread: true,
        },
      },
    ]);
  });

  test("Feishu message channel uploads runner workspace images in thread replies", async () => {
    const previousHome = config.paths.home;
    const testHome = mkdtempSync(join(tmpdir(), "luna-feishu-outbound-image-"));
    const runnerRoot = join(testHome, "sessions", "session-1");
    const runnerWorkspace = join(testHome, "sessions", "session-1", "workspace");
    mkdirSync(runnerWorkspace, { recursive: true });
    writeFileSync(join(runnerWorkspace, "direct.jpeg"), "image-bytes");
    setLunaHome(testHome);
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const replies: unknown[] = [];
    const uploads: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          image: {
            async create(input: unknown): Promise<unknown> {
              uploads.push(input);
              return { image_key: "uploaded-image-key" };
            },
          },
        },
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };

    try {
      await channel.send(
        feishuInboundForChannel({
          id: "om_message_1",
          channelType: "feishu",
          channelId: "test-feishu",
          groupId: "oc_chat_1",
          threadId: "omt_thread_1",
          senderUserId: "ou_user_1",
          text: "发回来",
        }),
        {
          replyMode: "reply_in_thread",
          targetMessageId: "omt_thread_1",
          sessionId: "session-1",
          assetBasePath: runnerRoot,
          content: "原图：\n\n![image](workspace/direct.jpeg)",
        },
      );
    } finally {
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    }

    expect(uploads).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      path: { message_id: "om_message_1" },
      data: {
        msg_type: "post",
        reply_in_thread: true,
      },
    });
    const reply = replies[0] as {
      readonly data: { readonly content: string };
    };
    expect(JSON.parse(reply.data.content)).toEqual({
      zh_cn: {
        content: [
          [
            {
              tag: "text",
              text: "原图：",
            },
          ],
          [
            {
              tag: "img",
              image_key: "uploaded-image-key",
            },
          ],
        ],
      },
    });
  });

  test("Feishu message channel retries a transient image upload disconnect", async () => {
    const previousHome = config.paths.home;
    const testHome = mkdtempSync(join(tmpdir(), "luna-feishu-image-retry-"));
    const imagePath = join(testHome, "retry.png");
    writeFileSync(imagePath, "image-bytes");
    setLunaHome(testHome);
    const channel = new FeishuMessageChannel("test-feishu", {
      chatId: "chat-id",
      appId: "cli_0000000000000000",
      appSecret: "app-secret",
    });
    let uploadAttempts = 0;
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          image: {
            async create(): Promise<unknown> {
              uploadAttempts += 1;
              if (uploadAttempts === 1) {
                throw new Error("The socket connection was closed unexpectedly");
              }
              return { image_key: "uploaded-after-retry" };
            },
          },
        },
      },
    };

    try {
      expect(await channel.uploadImage(imagePath)).toBe("uploaded-after-retry");
      expect(uploadAttempts).toBe(2);
    } finally {
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("Feishu message channel updates the final card without inline images after upload retries fail", async () => {
    const previousHome = config.paths.home;
    const testHome = mkdtempSync(join(tmpdir(), "luna-feishu-image-fallback-"));
    const imagePath = join(testHome, "result.png");
    writeFileSync(imagePath, "image-bytes");
    setLunaHome(testHome);
    const channel = new FeishuMessageChannel("test-feishu", {
      chatId: "chat-id",
      appId: "cli_0000000000000000",
      appSecret: "app-secret",
    });
    let uploadAttempts = 0;
    const patches: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          image: {
            async create(): Promise<unknown> {
              uploadAttempts += 1;
              throw new Error("The socket connection was closed unexpectedly");
            },
          },
        },
        message: {
          async patch(input: unknown): Promise<unknown> {
            patches.push(input);
            return {};
          },
        },
      },
    };

    try {
      await channel.send(
        feishuInboundForChannel({
          id: "om_image_fallback",
          channelType: "feishu",
          channelId: "test-feishu",
          groupId: "oc_chat_1",
          threadId: "omt_thread_1",
          senderUserId: "ou_user_1",
          text: "给我图片",
        }),
        {
          replyMode: "update_status_card",
          targetMessageId: "om_status_card",
          sessionId: "session-1",
          assetBasePath: testHome,
          content: `最终正文\n\n![截图](${imagePath})`,
          statusCardState: "terminal",
          statusCard: {
            taskId: "session-1",
            title: "工作会话",
            summary: "最终正文",
            status: "completed",
          },
        },
      );
      expect(uploadAttempts).toBe(3);
      expect(patches).toHaveLength(1);
      expect(JSON.stringify(patches[0])).toContain("最终正文");
      expect(JSON.stringify(patches[0])).not.toContain('"tag":"img"');
    } finally {
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("Feishu message channel sends channel image replies as post messages", async () => {
    const previousHome = config.paths.home;
    const testHome = mkdtempSync(join(tmpdir(), "luna-feishu-channel-image-"));
    mkdirSync(join(testHome, "workspace", "uploads", "images"), {
      recursive: true,
    });
    writeFileSync(
      join(testHome, "workspace", "uploads", "images", "direct.jpeg"),
      "image-bytes",
    );
    setLunaHome(testHome);
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const replies: unknown[] = [];
    const uploads: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          image: {
            async create(input: unknown): Promise<unknown> {
              uploads.push(input);
              return { image_key: "uploaded-channel-image-key" };
            },
          },
        },
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-channel-1" } };
          },
        },
      },
    };

    try {
      await channel.send(
        feishuInboundForChannel({
          id: "om_channel_message_1",
          channelType: "feishu",
          channelId: "test-feishu",
          senderUserId: "ou_user_1",
          text: "发回来",
        }),
        {
          replyMode: "channel_message",
          targetMessageId: "om_channel_message_1",
          sessionId: "session-1",
          content:
            "老大，收到这张图：\n![image](workspace/uploads/images/direct.jpeg)",
        },
      );
    } finally {
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    }

    expect(uploads).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      path: { message_id: "om_channel_message_1" },
      data: {
        msg_type: "post",
      },
    });
    const reply = replies[0] as {
      readonly data: { readonly content: string };
    };
    expect(JSON.parse(reply.data.content)).toEqual({
      zh_cn: {
        content: [
          [
            {
              tag: "text",
              text: "老大，收到这张图：",
            },
          ],
          [
            {
              tag: "img",
              image_key: "uploaded-channel-image-key",
            },
          ],
        ],
      },
    });
  });

  test("Feishu message channel materializes artifact image refs for channel replies", async () => {
    const previousHome = config.paths.home;
    const env = createRuntimeTestEnvironment();
    const sourcePath = join(
      config.paths.home,
      "workspace",
      "uploads",
      "images",
      "artifact.jpeg",
    );
    mkdirSync(join(config.paths.home, "workspace", "uploads", "images"), {
      recursive: true,
    });
    writeFileSync(sourcePath, "artifact-image-bytes");
    fixtureNamedSession(env.database.db, "session-1", "user-1");
    const artifact = new ArtifactRegistry(env.database.db).registerLocalFile({
      scopeType: "session",
      scopeId: "session-1",
      relatedUserId: "user-1",
      producer: "test",
      kind: "image",
      name: "artifact.jpeg",
      path: sourcePath,
    });
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
        db: env.database.db,
      },
    );
    const replies: unknown[] = [];
    const uploads: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        v1: {
          image: {
            async create(input: unknown): Promise<unknown> {
              uploads.push(input);
              return { image_key: "uploaded-artifact-image-key" };
            },
          },
        },
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-artifact-1" } };
          },
        },
      },
    };

    try {
      await channel.send(
        feishuInboundForChannel({
          id: "om_artifact_message_1",
          channelType: "feishu",
          channelId: "test-feishu",
          senderUserId: "ou_user_1",
          text: "发回来",
        }),
        {
          replyMode: "channel_message",
          targetMessageId: "om_artifact_message_1",
          sessionId: "session-1",
          content: `收到：\n\n![image](artifact:${artifact.id})`,
        },
      );
    } finally {
      env.cleanup();
      setLunaHome(previousHome);
    }

    expect(uploads).toHaveLength(1);
    expect(replies).toHaveLength(1);
    const reply = replies[0] as {
      readonly data: { readonly content: string };
    };
    expect(JSON.parse(reply.data.content)).toEqual({
      zh_cn: {
        content: [
          [{ tag: "text", text: "收到：" }],
          [{ tag: "img", image_key: "uploaded-artifact-image-key" }],
        ],
      },
    });
  });

  test("Feishu message channel signs artifact file links for task result cards", async () => {
    const previousHome = config.paths.home;
    const env = createRuntimeTestEnvironment();
    const sourcePath = join(
      config.paths.home,
      "workspace",
      "yellow-content-check-report.md",
    );
    mkdirSync(join(config.paths.home, "workspace"), { recursive: true });
    writeFileSync(sourcePath, "# 检测报告\n");
    fixtureNamedSession(env.database.db, "session-1", "user-1");
    env.database.db.insert(taskRowsTable).values({
      ...fixtureTaskOwnership(env.database.db, "session-1"), id: "task-report-link", primary_session_id: "session-1",
      type: "work", title: "Report", status: "completed", created_at: 1, updated_at: 1, last_activity_at: 1,
    }).run();
    const artifact = new ArtifactRegistry(env.database.db).registerLocalFile({
      scopeType: "task",
      scopeId: "task-report-link",
      relatedUserId: "user-1",
      producer: "test",
      kind: "file",
      name: "yellow-content-check-report.md",
      mimeType: "text/markdown",
      path: sourcePath,
    });
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
        db: env.database.db,
      },
    );
    const replies: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-artifact-link-1" } };
          },
        },
      },
    };

    try {
      await channel.send(
        feishuInboundForChannel({
          id: "om_artifact_link_1",
          channelType: "feishu",
          channelId: "test-feishu",
          senderUserId: "ou_user_1",
          text: "发报告",
        }),
        {
          replyMode: "reply_in_thread",
          targetMessageId: "om_artifact_link_1",
          sessionId: "session-1",
          content:
            `报告：[检测报告](artifact:${artifact.id})\n新增：\`artifact:${artifact.id}\``,
          taskResultCard: {
            taskId: "task-report-link",
            title: "检测图片黄色信息",
            summary: "已完成",
            status: "completed",
          },
        },
      );
    } finally {
      env.cleanup();
      setLunaHome(previousHome);
    }

    expect(replies).toHaveLength(1);
    const reply = replies[0] as {
      readonly data: { readonly msg_type: string; readonly content: string };
    };
    expect(reply.data.msg_type).toBe("interactive");
    const cardText = JSON.stringify(JSON.parse(reply.data.content));
    expect(cardText).not.toContain(`artifact:${artifact.id}`);
    expect(cardText).toContain(`/artifacts/${artifact.id}/preview?expires=`);
    expect(cardText).toContain("[检测报告](");
    expect(cardText).toContain("[yellow-content-check-report.md](");
  });

  test("Feishu message channel uses resolved bot display name for outbound sender", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    (channel as unknown as { _client: unknown })._client = {
      async request(): Promise<unknown> {
        return {
          bot: {
            open_id: "ou_bot",
            app_name: "Monkey King",
            avatar_url: "https://avatar.example/bot.png",
          },
        };
      },
      im: {
        message: {
          async reply(): Promise<unknown> {
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };
    (channel as unknown as { _inboundClient: { start(input: unknown): Promise<void> } })
      ._inboundClient = {
      async start(): Promise<void> {
        return undefined;
      },
    };

    await channel.start();
    const outbound = await channel.send(
      feishuInboundForChannel({
        id: "om_message_1",
        channelType: "feishu",
        channelId: "test-feishu",
        groupId: "oc_chat_1",
        senderUserId: "ou_user_1",
        text: "hi",
      }),
      {
        replyMode: "channel_message",
        targetMessageId: "om_message_1",
        content: "hello",
      },
    );

    expect(outbound.sender).toMatchObject({
      externalId: "ou_bot",
      kind: "bot",
      displayName: "Monkey King",
      avatarUrl: "https://avatar.example/bot.png",
      providerIds: { open_id: "ou_bot" },
    });
  });

  test("Feishu message channel keeps status card thread replies interactive", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const replies: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };

    await channel.send(
      feishuInboundForChannel({
        id: "om_message_1",
        channelType: "feishu",
        channelId: "test-feishu",
        groupId: "oc_chat_1",
        senderUserId: "ou_user_1",
        text: "帮忙排查",
      }),
      {
        replyMode: "reply_in_thread",
        targetMessageId: "om_message_1",
        statusCardState: "active",
        content: "已收到，正在准备排查。",
      },
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      path: { message_id: "om_message_1" },
      data: {
        msg_type: "interactive",
        reply_in_thread: true,
      },
    });
  });

  test("Feishu message channel preserves status card semantics for thread replies and patches", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-terminal-status-card-test-"));
    const previousHome = homedir() ? join(homedir(), ".luna") : testHome;
    writeFileSync(
      join(testHome, "config.yaml"),
      [
        "messaging:",
        "  default_channel_id: test-feishu",
        "  max_visible_steps: 32",
        "  channels: []",
        "",
      ].join("\n"),
    );
    setLunaHome(testHome);
    reloadConfig();
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const replies: unknown[] = [];
    const patches: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-1" } };
          },
          async patch(input: unknown): Promise<unknown> {
            patches.push(input);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };

    try {
      await channel.send(
        feishuInboundForChannel({
          id: "om_message_1",
          channelType: "feishu",
          channelId: "test-feishu",
          groupId: "oc_chat_1",
          senderUserId: "ou_user_1",
          text: "给我最终结论",
        }),
        {
          replyMode: "reply_in_thread",
          targetMessageId: "om_message_1",
          statusCardState: "terminal",
          statusCard: {
            taskId: "session-1",
            status: "completed",
            hideHeader: true,
          },
          content: "最终正文",
        },
      );

      const reply = replies[0] as {
        readonly data: { readonly content: string };
      };
      const card = JSON.parse(reply.data.content) as {
        readonly body: {
          readonly elements: readonly {
            readonly tag: string;
            readonly content?: string;
          }[];
        };
      };
      expect(card.body.elements).toContainEqual({
        tag: "markdown",
        content: "最终正文",
      });
      expect(
        card.body.elements.some((element) => element.tag === "collapsible_panel"),
      ).toBe(false);

      await channel.send(
        feishuInboundForChannel({
          id: "om_message_1",
          channelType: "feishu",
          channelId: "test-feishu",
          groupId: "oc_chat_1",
          senderUserId: "ou_user_1",
          text: "继续处理",
        }),
        {
          replyMode: "update_status_card",
          targetMessageId: "reply-1",
          statusCardState: "active",
          statusCard: {
            taskId: "session-1",
            status: "running",
            hideHeader: true,
          },
          statusCardSteps: ["步骤一"],
          content: "处理中正文",
        },
      );

      const patch = patches[0] as {
        readonly data: { readonly content: string };
      };
      const patchedCard = JSON.parse(patch.data.content) as {
        readonly body: {
          readonly elements: readonly {
            readonly tag: string;
            readonly content?: string;
            readonly elements?: readonly {
              readonly text?: { readonly content?: string };
            }[];
          }[];
        };
      };
      expect(patchedCard.body.elements).toContainEqual({
        tag: "markdown",
        content: "处理中正文",
      });
      expect(patchedCard.body.elements[0]?.elements).toMatchObject([
        { text: { content: "步骤一" } },
      ]);
    } finally {
      setLunaHome(previousHome);
      try {
        reloadConfig();
      } catch {
        // The default user-level config is optional in tests.
      }
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("Feishu message channel keeps status card channel messages interactive without steps", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const replies: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };

    await channel.send(
      feishuInboundForChannel({
        id: "om_message_1",
        channelType: "feishu",
        channelId: "test-feishu",
        groupId: "oc_chat_1",
        senderUserId: "ou_user_1",
        text: "帮忙排查",
      }),
      {
        replyMode: "channel_message",
        targetMessageId: "om_message_1",
        statusCardState: "active",
        content: "正在处理…",
      },
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      path: { message_id: "om_message_1" },
      data: {
        msg_type: "interactive",
      },
    });
  });

  test("Feishu message channel can route test-injected channel status cards to a real reply target", async () => {
    const channel = new FeishuMessageChannel(
      "test-feishu",
      {
        chatId: "chat-id",
        appId: "cli_0000000000000000",
        appSecret: "app-secret",
      },
    );
    const replies: unknown[] = [];
    (channel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async reply(input: unknown): Promise<unknown> {
            replies.push(input);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };

    await channel.send(
      feishuInboundForChannel({
        id: "sim-injected-message",
        channelType: "feishu",
        channelId: "test-feishu",
        groupId: "oc_chat_1",
        threadId: "om_root_message_1",
        rootMessageId: "om_root_message_1",
        senderUserId: "ou_user_1",
        text: "注入测试",
        rawPayload: {
          lunaTestInject: {
            replyTargetMessageId: "om_root_message_1",
          },
        },
      }),
      {
        replyMode: "channel_message",
        statusCardState: "active",
        content: "正在处理…",
      },
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      path: { message_id: "om_root_message_1" },
      data: {
        msg_type: "interactive",
      },
    });
  });

  test("kernel start runs explicit Task Run recovery before pending result recovery", async () => {
    const { kernel } = await import("../../src/kernel");
    const kernelState = kernel as unknown as {
      _honoServer: unknown;
      _prepareContainerRuntimeForStartup: () => Promise<void>;
      _recoverExplicitTaskRuns: () => Promise<void>;
      _recoverTaskRunNotifications: () => Promise<void>;
      _recoverPendingTaskResultEvents: () => Promise<void>;
      _recoverSessionQueue: () => Promise<void>;
      _registerConfiguredLunaChannels: () => Promise<void>;
      _loadInstalledPluginsForBoot: () => Promise<void>;
      _initServer: () => void;
      _refreshMarketplaceAfterServerStart: () => void;
      _lunaMessageIngress: unknown;
      _started: boolean;
      _stopped: boolean;
    };
    const originalState = {
      ...kernelState,
      runnerOperations: kernel.runnerOperations,
      _prepareContainerRuntimeForStartup: kernelState._prepareContainerRuntimeForStartup,
    };
    const events: string[] = [];

    try {
      Object.assign(kernelState, {
        _sessionCommands: { start: () => events.push("commands.start"), stop: async () => {} },
        _honoServer: {
          async start(): Promise<void> {
            events.push("server.start");
          },
          async stop(): Promise<void> {
            events.push("server.stop");
          },
        },
        runnerOperations() { return { recoverPending() { events.push("operation-recovery"); return 0; } }; },
        async _prepareContainerRuntimeForStartup(): Promise<void> {
          events.push("container-preflight");
        },
        async _recoverExplicitTaskRuns(): Promise<void> {
          events.push("explicit-recovery");
        },
        async _recoverTaskRunNotifications(): Promise<void> {
          events.push("task-run-notification-recovery");
        },
        async _recoverPendingTaskResultEvents(): Promise<void> {
          events.push("pending-result-recovery");
        },
        async _recoverSessionQueue(): Promise<void> {
          events.push("session-queue-recovery");
        },
        async _loadInstalledPluginsForBoot(): Promise<void> {
          events.push("plugin-load");
        },
        _initServer(): void {
          events.push("server.init");
        },
        _refreshMarketplaceAfterServerStart(): void {
          events.push("marketplace.refresh");
        },
        async _registerConfiguredLunaChannels(): Promise<void> {
          events.push("register-channels");
        },
        _lunaMessageIngress: {
          async start(): Promise<void> {
            events.push("ingress.start");
          },
          async stop(): Promise<void> {
            events.push("ingress.stop");
          },
        },
        _started: false,
        _stopped: false,
      });

      await kernel.start();

      expect(events).toEqual([
        "plugin-load",
        "container-preflight",
        "server.init",
        "server.start",
        "marketplace.refresh",
        "register-channels",
        "explicit-recovery",
        "operation-recovery",
        "task-run-notification-recovery",
        "pending-result-recovery",
        "session-queue-recovery",
        "ingress.start",
        "commands.start",
      ]);
    } finally {
      Object.assign(kernelState, originalState);
    }
  });

  test("kernel container runtime is prepared before recovery can launch runners", async () => {
    const testHome = mkdtempSync(
      join(tmpdir(), "luna-agent-runtime-container-preflight-order-"),
    );
    const previousLunaHome = process.env.LUNA_HOME;
    const previousBunLunaHome = Bun.env.LUNA_HOME;
    writeFileSync(
      join(testHome, "config.yaml"),
      `timezone: "Asia/Shanghai"
messaging:
  default_channel_id: ""
  channels: []
`,
      "utf-8",
    );
    mkdirSync(join(testHome, "data"), { recursive: true });
    process.env.LUNA_HOME = testHome;
    Bun.env.LUNA_HOME = testHome;
    setLunaHome(testHome);
    reloadConfig();

    const { kernel } = await import("../../src/kernel");
    const kernelState = kernel as unknown as {
      _honoServer: unknown;
      _prepareContainerRuntimeForStartup?: () => Promise<void>;
      _recoverExplicitTaskRuns: () => Promise<void>;
      _recoverTaskRunNotifications: () => Promise<void>;
      _recoverPendingTaskResultEvents: () => Promise<void>;
      _recoverSessionQueue: () => Promise<void>;
      _registerConfiguredLunaChannels: () => Promise<void>;
      _loadInstalledPluginsForBoot: () => Promise<void>;
      _initServer: () => void;
      _refreshMarketplaceAfterServerStart: () => void;
      _lunaMessageIngress: unknown;
      _started: boolean;
      _stopped: boolean;
    };
    const originalState = { ...kernelState, runnerOperations: kernel.runnerOperations };
    const events: string[] = [];

    try {
      Object.assign(kernelState, {
        _sessionCommands: { start: () => events.push("commands.start"), stop: async () => {} },
        _honoServer: {
          async start(): Promise<void> {
            events.push("server.start");
          },
          async stop(): Promise<void> {
            events.push("server.stop");
          },
        },
        async _prepareContainerRuntimeForStartup(): Promise<void> {
          events.push("container-preflight");
        },
        runnerOperations() { return { recoverPending() { events.push("operation-recovery"); return 0; } }; },
        async _recoverExplicitTaskRuns(): Promise<void> {
          events.push("explicit-recovery");
        },
        async _recoverTaskRunNotifications(): Promise<void> {
          events.push("task-run-notification-recovery");
        },
        async _recoverPendingTaskResultEvents(): Promise<void> {
          events.push("pending-result-recovery");
        },
        async _recoverSessionQueue(): Promise<void> {
          events.push("session-queue-recovery");
        },
        async _loadInstalledPluginsForBoot(): Promise<void> {
          events.push("plugin-load");
        },
        _initServer(): void {
          events.push("server.init");
        },
        _refreshMarketplaceAfterServerStart(): void {
          events.push("marketplace.refresh");
        },
        async _registerConfiguredLunaChannels(): Promise<void> {
          events.push("register-channels");
        },
        _lunaMessageIngress: {
          async start(): Promise<void> {
            events.push("ingress.start");
          },
          async stop(): Promise<void> {
            events.push("ingress.stop");
          },
        },
        _started: false,
        _stopped: false,
      });

      await kernel.start();

      expect(events).toEqual([
        "plugin-load",
        "container-preflight",
        "server.init",
        "server.start",
        "marketplace.refresh",
        "register-channels",
        "explicit-recovery",
        "operation-recovery",
        "task-run-notification-recovery",
        "pending-result-recovery",
        "session-queue-recovery",
        "ingress.start",
        "commands.start",
      ]);
    } finally {
      Object.assign(kernelState, originalState);
      if (previousLunaHome === undefined) {
        delete process.env.LUNA_HOME;
      } else {
        process.env.LUNA_HOME = previousLunaHome;
      }
      if (previousBunLunaHome === undefined) {
        delete Bun.env.LUNA_HOME;
      } else {
        Bun.env.LUNA_HOME = previousBunLunaHome;
      }
      setLunaHome(
        previousBunLunaHome ?? previousLunaHome ?? join(homedir(), ".luna"),
      );
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("runner context store can explicitly clear runner session ids by scope", () => {
    const testHome = mkdtempSync(
      join(tmpdir(), "luna-agent-runtime-stale-runner-session-test-home-"),
    );
    const previousHome = config.paths.home;
    mkdirSync(join(testHome, "data"), { recursive: true });
    setLunaHome(testHome);
    const database = new DataConnection(lunaSchema);
    try {
      fixtureNamedSession(database.db, "session-1");
      database.db.insert(taskRowsTable).values({
        ...fixtureTaskOwnership(database.db, "session-1"), id: "task-1", primary_session_id: "session-1",
        type: "work", title: "Context owner", status: "completed", created_at: 1, updated_at: 1, last_activity_at: 1,
      }).run();
      database.db.insert(runnerContexts).values([
        fixtureRunnerContext(database.db, {
          id: "runner-context-main",
          owner_type: "session",
          owner_id: "session-1",
          runner_type: "claude",
          runner_session_id: "provider-session-main",
          instruction_fingerprint: null,
          runner_root_path: join(testHome, "runners", "session-1"),
          last_run_id: null,
          created_at: 1,
          updated_at: 1,
        }),
        fixtureRunnerContext(database.db, {
          id: "runner-context-task",
          owner_type: "task",
          owner_id: "task-1",
          runner_type: "claude",
          runner_session_id: "provider-session-task",
          instruction_fingerprint: null,
          runner_root_path: join(testHome, "runners", "task-1"),
          last_run_id: null,
          created_at: 1,
          updated_at: 1,
        }),
      ]).run();

      const { RunnerContextStore } =
        require("../../src/runners/runner-context-store") as typeof import("../../src/runners/runner-context-store");

      new RunnerContextStore(database.db).clearRunnerSessionIdByScopeKey("task:task-1:claude");

      expect(
        database.db
          .select({ runnerSessionId: runnerContexts.runner_session_id })
          .from(runnerContexts)
          .all(),
      ).toEqual([
        { runnerSessionId: "provider-session-main" },
        { runnerSessionId: null },
      ]);
    } finally {
      database.close();
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("runner context store clears stale runner sessions when instruction fingerprint changes", () => {
    const testHome = mkdtempSync(
      join(tmpdir(), "luna-agent-runtime-runner-instruction-fingerprint-test-home-"),
    );
    const previousHome = config.paths.home;
    mkdirSync(join(testHome, "data"), { recursive: true });
    setLunaHome(testHome);
    const database = new DataConnection(lunaSchema);
    try {
      fixtureNamedSession(database.db, "session-1");
      database.db.insert(runnerContexts).values(fixtureRunnerContext(database.db, {
        id: "runner-context-main",
        owner_type: "session",
        owner_id: "session-1",
        runner_type: "claude",
        runner_session_id: "provider-session-main",
        instruction_fingerprint: "old-fingerprint",
        runner_root_path: join(testHome, "runners", "session-1"),
        last_run_id: null,
        created_at: 1,
        updated_at: 1,
      })).run();

      const { RunnerContextStore } =
        require("../../src/runners/runner-context-store") as typeof import("../../src/runners/runner-context-store");

      const result = new RunnerContextStore(database.db).syncInstructionFingerprint(
        "runner-context-main",
        "new-fingerprint",
      );

      expect(result.instructionFingerprintChanged).toBe(true);
      expect(result.runnerSessionInvalidated).toBe(true);
      expect(result.runnerContext.runner_session_id).toBeNull();
      expect(result.runnerContext.instruction_fingerprint).toBe("new-fingerprint");
    } finally {
      database.close();
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("kernel stop keeps service API available until task runners detach", async () => {
    const { kernel } = await import("../../src/kernel");
    const kernelState = kernel as unknown as {
      _database: unknown;
      _honoServer: unknown;
      _lunaMessageIngress: unknown;
      _operationAuditRetention: unknown;
      _taskRunSupervisor: unknown;
      _started: boolean;
      _stopped: boolean;
    };
    const originalState = { ...kernelState, runnerOperations: kernel.runnerOperations };
    const events: string[] = [];

    try {
      Object.assign(kernelState, {
        _database: {
          close(): void {
            events.push("database.close");
          },
        },
        _honoServer: {
          async stop(): Promise<void> {
            events.push("server.stop");
          },
        },
        _lunaMessageIngress: {
          async stop(): Promise<void> {
            events.push("ingress.stop");
          },
        },
        _operationAuditRetention: {
          stop(): void {
            events.push("audit.stop");
          },
        },
        _taskRunSupervisor: {
          async abortAndWait(): Promise<void> {
            events.push(
              events.includes("server.stop")
                ? "task.abort:server-stopped"
                : "task.abort:server-running",
            );
          },
        },
        _started: true,
        _stopped: false,
      });

      await kernel.stop();

      expect(events).toEqual([
        "ingress.stop",
        "audit.stop",
        "task.abort:server-running",
        "server.stop",
        "database.close",
      ]);
    } finally {
      Object.assign(kernelState, originalState);
    }
  });

  test("kernel start rolls back started components when startup fails", async () => {
    const testHome = mkdtempSync(
      join(tmpdir(), "luna-agent-runtime-rollback-test-home-"),
    );
    const previousLunaHome = process.env.LUNA_HOME;
    const previousBunLunaHome = Bun.env.LUNA_HOME;

    mkdirSync(join(testHome, "data"), { recursive: true });
    writeFileSync(
      join(testHome, "config.yaml"),
      `timezone: "Asia/Shanghai"
messaging:
  default_channel_id: ""
  max_visible_steps: 32
  channels: []
`,
      "utf-8",
    );
    process.env.LUNA_HOME = testHome;
    Bun.env.LUNA_HOME = testHome;
    setLunaHome(testHome);

    const { kernel } = await import("../../src/kernel");
    const kernelState = kernel as unknown as {
      _database: unknown;
      _honoServer: unknown;
      _prepareContainerRuntimeForStartup: () => Promise<void>;
      _lunaMessageIngress: unknown;
      _loadInstalledPluginsForBoot: () => Promise<void>;
      _initServer: () => void;
      _started: boolean;
      _stopped: boolean;
    };
    const originalState = {
      ...kernelState,
      runnerOperations: kernel.runnerOperations,
      _prepareContainerRuntimeForStartup: kernelState._prepareContainerRuntimeForStartup,
    };
    const events: string[] = [];

    try {
      Object.assign(kernelState, {
        async _prepareContainerRuntimeForStartup(): Promise<void> {},
        _database: {
          close(): void {
            events.push("database.close");
          },
        },
        _honoServer: {
          async start(): Promise<void> {
            events.push("server.start");
            throw new Error("server failed");
          },
          async stop(): Promise<void> {
            events.push("server.stop");
          },
        },
        _lunaMessageIngress: {
          async start(): Promise<void> {
            events.push("ingress.start");
          },
          async stop(): Promise<void> {
            events.push("ingress.stop");
          },
        },
        async _loadInstalledPluginsForBoot(): Promise<void> {
          events.push("plugin-load");
        },
        _initServer(): void {
          events.push("server.init");
        },
        _started: false,
        _stopped: false,
      });

      await expect(kernel.start()).rejects.toThrow("server failed");

      expect(events).toEqual([
        "plugin-load",
        "server.init",
        "server.start",
        "database.close",
      ]);
      expect(kernelState._started).toBe(false);
      expect(kernelState._stopped).toBe(true);
    } finally {
      Object.assign(kernelState, originalState);
      await stopAgentRuntime();
      if (previousLunaHome === undefined) {
        delete process.env.LUNA_HOME;
      } else {
        process.env.LUNA_HOME = previousLunaHome;
      }
      if (previousBunLunaHome === undefined) {
        delete Bun.env.LUNA_HOME;
      } else {
        Bun.env.LUNA_HOME = previousBunLunaHome;
      }
      setLunaHome(
        previousBunLunaHome ?? previousLunaHome ?? join(homedir(), ".luna"),
      );
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("kernel start drains recovered session queue when ingress start fails", async () => {
    const testHome = mkdtempSync(
      join(tmpdir(), "luna-agent-runtime-recovery-rollback-test-home-"),
    );
    const previousLunaHome = process.env.LUNA_HOME;
    const previousBunLunaHome = Bun.env.LUNA_HOME;

    mkdirSync(join(testHome, "data"), { recursive: true });
    writeFileSync(
      join(testHome, "config.yaml"),
      `timezone: "Asia/Shanghai"
messaging:
  default_channel_id: ""
  max_visible_steps: 32
  channels: []
`,
      "utf-8",
    );
    process.env.LUNA_HOME = testHome;
    Bun.env.LUNA_HOME = testHome;
    setLunaHome(testHome);

    const { kernel } = await import("../../src/kernel");
    const kernelState = kernel as unknown as {
      _database: unknown;
      _honoServer: unknown;
      _prepareContainerRuntimeForStartup: () => Promise<void>;
      _taskRunSupervisor: unknown;
      _recoverExplicitTaskRuns: () => Promise<void>;
      _recoverTaskRunNotifications: () => Promise<void>;
      _recoverPendingTaskResultEvents: () => Promise<void>;
      _recoverSessionQueue: () => Promise<void>;
      _registerConfiguredLunaChannels: () => Promise<void>;
      _loadInstalledPluginsForBoot: () => Promise<void>;
      _initServer: () => void;
      _refreshMarketplaceAfterServerStart: () => void;
      _lunaMessageIngress: unknown;
      _started: boolean;
      _stopped: boolean;
    };
    const originalState = {
      ...kernelState,
      runnerOperations: kernel.runnerOperations,
      _prepareContainerRuntimeForStartup: kernelState._prepareContainerRuntimeForStartup,
    };
    const stopStarted = createDeferred<void>();
    const releaseStop = createDeferred<void>();
    const events: string[] = [];
    let serverStopped = false;

    try {
      Object.assign(kernelState, {
        async _prepareContainerRuntimeForStartup(): Promise<void> {},
        _database: {
          close(): void {
            events.push("database.close");
          },
        },
        _honoServer: {
          async start(): Promise<void> {
            events.push("server.start");
          },
          async stop(): Promise<void> {
            serverStopped = true;
            events.push("server.stop");
          },
        },
        _taskRunSupervisor: {
          async abortAndWait(): Promise<void> {
            events.push(
              serverStopped
                ? "task.abort:server-stopped"
                : "task.abort:server-running",
            );
          },
        },
        async _registerConfiguredLunaChannels(): Promise<void> {
          events.push("register-channels");
        },
        runnerOperations() { return { recoverPending() { events.push("operation-recovery"); return 0; } }; },
        async _recoverExplicitTaskRuns(): Promise<void> {
          events.push("explicit-recovery");
        },
        async _recoverTaskRunNotifications(): Promise<void> {
          events.push("task-run-notification-recovery");
        },
        async _recoverPendingTaskResultEvents(): Promise<void> {
          events.push("pending-result-recovery");
        },
        async _recoverSessionQueue(): Promise<void> {
          events.push("session-queue-recovery");
        },
        async _loadInstalledPluginsForBoot(): Promise<void> {
          events.push("plugin-load");
        },
        _initServer(): void {
          events.push("server.init");
        },
        _refreshMarketplaceAfterServerStart(): void {
          events.push("marketplace.refresh");
        },
        _lunaMessageIngress: {
          async start(): Promise<void> {
            events.push("ingress.start");
            throw new Error("ingress failed after recovery");
          },
          async stop(): Promise<void> {
            events.push("ingress.stop.start");
            stopStarted.resolve();
            await releaseStop.promise;
            events.push("ingress.stop.done");
            throw new AggregateError(
              [new Error("recovered queue worker failed")],
              "Session queue worker failed.",
            );
          },
        },
        _started: false,
        _stopped: false,
      });

      const startPromise = kernel.start();
      await stopStarted.promise;
      expect(events).not.toContain("database.close");

      releaseStop.resolve();
      await expect(startPromise).rejects.toThrow("ingress failed after recovery");

      expect(events).toEqual([
        "plugin-load",
        "server.init",
        "server.start",
        "marketplace.refresh",
        "register-channels",
        "explicit-recovery",
        "operation-recovery",
        "task-run-notification-recovery",
        "pending-result-recovery",
        "session-queue-recovery",
        "ingress.start",
        "ingress.stop.start",
        "ingress.stop.done",
        "task.abort:server-running",
        "server.stop",
        "database.close",
      ]);
      expect(kernelState._started).toBe(false);
      expect(kernelState._stopped).toBe(true);
    } finally {
      Object.assign(kernelState, originalState);
      await stopAgentRuntime();
      if (previousLunaHome === undefined) {
        delete process.env.LUNA_HOME;
      } else {
        process.env.LUNA_HOME = previousLunaHome;
      }
      if (previousBunLunaHome === undefined) {
        delete Bun.env.LUNA_HOME;
      } else {
        Bun.env.LUNA_HOME = previousBunLunaHome;
      }
      setLunaHome(
        previousBunLunaHome ?? previousLunaHome ?? join(homedir(), ".luna"),
      );
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("kernel rollback drains recovered queue when channel stop fails", async () => {
    const testHome = mkdtempSync(
      join(tmpdir(), "luna-agent-runtime-channel-stop-rollback-test-home-"),
    );
    const previousLunaHome = process.env.LUNA_HOME;
    const previousBunLunaHome = Bun.env.LUNA_HOME;
    const events: string[] = [];
    const workerStarted = createDeferred<void>();
    const releaseWorker = createDeferred<void>();

    mkdirSync(join(testHome, "data"), { recursive: true });
    writeFileSync(
      join(testHome, "config.yaml"),
      `timezone: "Asia/Shanghai"
messaging:
  default_channel_id: ""
  max_visible_steps: 32
  channels: []
`,
      "utf-8",
    );
    process.env.LUNA_HOME = testHome;
    Bun.env.LUNA_HOME = testHome;
    setLunaHome(testHome);
    reloadConfig();

    class FailingStartAndStopIngress extends LunaMessageIngress {
      override async start(): Promise<void> {
        events.push("ingress.start");
        throw new Error("ingress failed after recovery");
      }

      override async stop(): Promise<void> {
        events.push("ingress.stop.start");
        try {
          await super.stop();
        } finally {
          events.push("ingress.stop.done");
        }
      }
    }

    class FailingStopChannel extends FakeFeishuChannel {
      async stop(): Promise<void> {
        events.push("channel.stop");
        throw new Error("channel stop failed");
      }
    }

    const { kernel } = await import("../../src/kernel");
    const kernelState = kernel as unknown as {
      _database: DataConnection<typeof lunaSchema>;
      _honoServer: unknown;
      _prepareContainerRuntimeForStartup: () => Promise<void>;
      _recoverExplicitTaskRuns: () => Promise<void>;
      _recoverTaskRunNotifications: () => Promise<void>;
      _recoverPendingTaskResultEvents: () => Promise<void>;
      _recoverSessionQueue: () => Promise<void>;
      _registerConfiguredLunaChannels: () => Promise<void>;
      _loadInstalledPluginsForBoot: () => Promise<void>;
      _initServer: () => void;
      _refreshMarketplaceAfterServerStart: () => void;
      _lunaMessageIngress: LunaMessageIngress;
      _started: boolean;
      _stopped: boolean;
    };
    const originalState = {
      ...kernelState,
      runnerOperations: kernel.runnerOperations,
      _prepareContainerRuntimeForStartup: kernelState._prepareContainerRuntimeForStartup,
    };

    try {
      const database = new DataConnection(lunaSchema);
      const queue = new SessionQueue({
        db: database.db,
        config: SessionConfigForTests,
        executeTurn: async () => undefined,
      });
      (
        queue as unknown as {
          _runSessionWorker: (sessionId: string) => Promise<void>;
        }
      )._runSessionWorker = async () => {
        events.push("queue.worker.start");
        workerStarted.resolve();
        await releaseWorker.promise;
        events.push("queue.worker.done");
      };
      const ingress = new FailingStartAndStopIngress({
        db: database.db,
        runnerType: "mock",
        mainRunner: createDeterministicMainRunner(database.db),
        sessionQueue: queue,
      });
      fixtureSessionOwnership(database.db, "feishu", "feishu-main");
      await ingress.registerChannel(new FailingStopChannel("feishu-main"));
      queue.schedule("recovered-session-rollback");
      await workerStarted.promise;

      Object.assign(kernelState, {
        async _prepareContainerRuntimeForStartup(): Promise<void> {},
        _database: {
          close(): void {
            events.push("database.close");
            database.close();
          },
        },
        _honoServer: {
          async start(): Promise<void> {
            events.push("server.start");
          },
          async stop(): Promise<void> {
            events.push("server.stop");
          },
        },
        async _registerConfiguredLunaChannels(): Promise<void> {
          events.push("register-channels");
        },
        runnerOperations() { return { recoverPending() { events.push("operation-recovery"); return 0; } }; },
        async _recoverExplicitTaskRuns(): Promise<void> {
          events.push("explicit-recovery");
        },
        async _recoverTaskRunNotifications(): Promise<void> {
          events.push("task-run-notification-recovery");
        },
        async _recoverPendingTaskResultEvents(): Promise<void> {
          events.push("pending-result-recovery");
        },
        async _recoverSessionQueue(): Promise<void> {
          events.push("session-queue-recovery");
        },
        async _loadInstalledPluginsForBoot(): Promise<void> {
          events.push("plugin-load");
        },
        _initServer(): void {
          events.push("server.init");
        },
        _refreshMarketplaceAfterServerStart(): void {
          events.push("marketplace.refresh");
        },
        _lunaMessageIngress: ingress,
        _started: false,
        _stopped: false,
      });

      const startPromise = kernel.start();
      await waitForEvent(events, "ingress.stop.start");
      expect(events).not.toContain("database.close");

      releaseWorker.resolve();
      await expect(startPromise).rejects.toThrow("ingress failed after recovery");

      expect(events).toEqual([
        "queue.worker.start",
        "plugin-load",
        "server.init",
        "server.start",
        "marketplace.refresh",
        "register-channels",
        "explicit-recovery",
        "operation-recovery",
        "task-run-notification-recovery",
        "pending-result-recovery",
        "session-queue-recovery",
        "ingress.start",
        "ingress.stop.start",
        "channel.stop",
        "queue.worker.done",
        "ingress.stop.done",
        "server.stop",
        "database.close",
      ]);
    } finally {
      Object.assign(kernelState, originalState);
      await stopAgentRuntime();
      if (previousLunaHome === undefined) {
        delete process.env.LUNA_HOME;
      } else {
        process.env.LUNA_HOME = previousLunaHome;
      }
      if (previousBunLunaHome === undefined) {
        delete Bun.env.LUNA_HOME;
      } else {
        Bun.env.LUNA_HOME = previousBunLunaHome;
      }
      setLunaHome(
        previousBunLunaHome ?? previousLunaHome ?? join(homedir(), ".luna"),
      );
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("up script defaults to server-only and rejects web modes early", () => {
    const script = readFileSync(
      join(import.meta.dir, "../../scripts/agent/up.sh"),
      "utf-8",
    );
    const rejectionIndex = script.indexOf(
      'Web mode is not available until the dashboard migration task.',
    );

    expect(script).toContain('MODE="${1:-server-only}"');
    expect(rejectionIndex).toBeGreaterThan(-1);
    expect(rejectionIndex).toBeLessThan(script.indexOf("server-main.ts"));
  });

  test("down script runs under macOS system bash without associative arrays", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-down-script-"));
    const scriptDir = join(testRoot, "scripts", "agent");
    const binDir = join(testRoot, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(scriptDir, "down.sh"),
      readFileSync(
        join(import.meta.dir, "../../scripts/agent/down.sh"),
        "utf-8",
      ),
      "utf-8",
    );
    writeFileSync(
      join(binDir, "bun"),
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' \"$*\" > \"$LUNA_SCRIPT_TEST_ARGS\"",
        "",
      ].join("\n"),
      "utf-8",
    );
    Bun.spawnSync(["chmod", "+x", join(binDir, "bun")]);
    const argsPath = join(testRoot, "args.txt");

    try {
      const result = Bun.spawnSync({
        cmd: ["bash", join(scriptDir, "down.sh"), "server-only"],
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          LUNA_SCRIPT_TEST_ARGS: argsPath,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).not.toContain("declare: -A");
      const args = readFileSync(argsPath, "utf-8");
      expect(args).toContain("src/cli/server-main.ts");
      expect(args).toContain("stop");
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("up script delegates to CLI agent start instead of starting a second server manager", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "luna-up-script-"));
    const scriptDir = join(testRoot, "scripts", "agent");
    const binDir = join(testRoot, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(scriptDir, "up.sh"),
      readFileSync(
        join(import.meta.dir, "../../scripts/agent/up.sh"),
        "utf-8",
      ),
      "utf-8",
    );
    writeFileSync(
      join(binDir, "bun"),
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' \"$*\" > \"$LUNA_SCRIPT_TEST_ARGS\"",
        "printf '%s\\n' \"${LUNA_DASHBOARD_TOKEN:-}\" > \"$LUNA_SCRIPT_TEST_TOKEN\"",
        "",
      ].join("\n"),
      "utf-8",
    );
    Bun.spawnSync(["chmod", "+x", join(binDir, "bun")]);
    const argsPath = join(testRoot, "args.txt");
    const tokenPath = join(testRoot, "token.txt");

    try {
      const result = Bun.spawnSync({
        cmd: ["bash", join(scriptDir, "up.sh"), "server-only"],
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          LUNA_SERVICE_PORT: "9000",
          LUNA_SCRIPT_TEST_ARGS: argsPath,
          LUNA_SCRIPT_TEST_TOKEN: tokenPath,
          LUNA_DASHBOARD_TOKEN: "",
        },
      });

      expect(result.exitCode).toBe(0);
      const args = readFileSync(argsPath, "utf-8");
      expect(args).toContain("src/cli/server-main.ts");
      expect(args).toContain("start");
      expect(args).not.toContain("--port");
      expect(readFileSync(tokenPath, "utf-8").trim()).toBe("");
      expect(readFileSync(join(scriptDir, "up.sh"), "utf-8")).not.toContain(
        "bun run dev:server",
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("kernel routes two Feishu applications in the same group to their own Shadow", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "luna-dual-channel-test-"));
    mkdirSync(join(testHome, "data"), { recursive: true });
    setLunaHome(testHome);
    const database = new DataConnection(lunaSchema);
    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: createDeterministicMainRunner(database.db),
      sessionConfig: SessionConfigForTests,
    });
    const fakeChannel = new FakeFeishuChannel("feishu-fake");
    const feishuChannel = new FeishuMessageChannel("feishu-real", {
      chatId: "oc_real_chat",
      appId: "test:feishu:feishu-real",
      appSecret: "app-secret",
      botOpenId: "ou_bot",
      developerId: "shared-developer",
    });
    const feishuReplies: unknown[] = [];
    (feishuChannel as unknown as { _client: unknown })._client = {
      im: {
        message: {
          async create(input: unknown): Promise<unknown> {
            feishuReplies.push(input);
            return { data: { message_id: "real-command-reply-1" } };
          },
          async reply(input: unknown): Promise<unknown> {
            feishuReplies.push(input);
            return { data: { message_id: "real-reply-1", thread_id: "real-thread-1" } };
          },
        },
        v1: {
          messageReaction: {
            async create(): Promise<unknown> {
              return { data: { reaction_id: "reaction-1" } };
            },
            async delete(): Promise<void> {
              return undefined;
            },
          },
        },
      },
    };
    let feishuStarted = false;
    let feishuStopped = false;
    (feishuChannel as unknown as { _inboundClient: unknown })._inboundClient = {
      async start(): Promise<void> {
        feishuStarted = true;
      },
      close(): void {
        feishuStopped = true;
      },
    };
    const { kernel } = await import("../../src/kernel");
    const kernelState = kernel as unknown as {
      _lunaMessageIngress: LunaMessageIngress;
      _lunaChannels: Map<string, unknown>;
    };
    const originalState = {
      _lunaMessageIngress: kernelState._lunaMessageIngress,
      _lunaChannels: kernelState._lunaChannels,
    };

    try {
      Object.assign(kernelState, {
        _lunaMessageIngress: ingress,
        _lunaChannels: new Map<string, unknown>(),
      });
      const owner = "fixture-owner";
      const {agent_id: agentId} = fixtureSessionOwnership(database.db, "feishu", fakeChannel.id, owner);
      fixtureSessionOwnership(database.db, "feishu", feishuChannel.id, owner);

      await kernel.registerLunaInboundChannel(fakeChannel);
      await kernel.registerLunaInboundChannel(feishuChannel);
      await ingress.start();

      const firstInbound = normalizedInboundFromDirectCallForTest({
        id: "fake-dual-message-1",
        channelType: "feishu",
        channelId: fakeChannel.id,
        senderUserId: "ou_fake_user",
        senderProfile: {externalUserId: "ou_fake_user", unionId: "on_shared"},
        text: "hello",
        chatType: "group",
        groupId: "oc_real_chat",
        addressing: { addressedToBot: true, reason: "mention" },
      }, {environment: "feishu", appId: "test:feishu:feishu-fake", developerId: "shared-developer"});
      const observed = new ChannelDirectoryStore(database.db).upsertIdentity({
        channel: firstInbound.channel, identity: firstInbound.sender,
      });
      const binding = database.db.select().from(lunaSchema.channelUserBindings)
        .where(eq(lunaSchema.channelUserBindings.channelIdentityId, observed.id)).get();
      expect(binding).toBeDefined();
      await fakeChannel.emitNormalizedInbound(firstInbound);
      await (
        feishuChannel as unknown as {
          _handleMessageReceive(event: unknown): Promise<void>;
        }
      )._handleMessageReceive({
        sender: {
          sender_id: { open_id: "ou_real_user", union_id: "on_shared" },
          sender_type: "user",
        },
        message: {
          message_id: "real-dual-message-1",
          create_time: "1780370000000",
          chat_id: "oc_real_chat",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 hello" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Luna" }],
        },
      });
      await ingress.waitForIdle();

      expect(feishuStarted).toBe(true);
      expect(fakeChannel.outbound).toHaveLength(1);
      expect(fakeChannel.outbound[0]?.channelId).toBe("feishu-fake");
      expect(feishuReplies).toHaveLength(1);
      const senderIds = database.db.select({id: lunaSchema.messages.senderUserId})
        .from(lunaSchema.messages).where(eq(lunaSchema.messages.role, "user")).all();
      expect(senderIds).toEqual([{id: binding!.userId}, {id: binding!.userId}]);
      const sessions = database.db.select().from(sessionRowsTable).all()
        .sort((left, right) => left.channel_id.localeCompare(right.channel_id));
      expect(sessions.map(row => [row.channel_id, row.group_id]))
        .toEqual([["feishu-fake", "oc_real_chat"], ["feishu-real", "oc_real_chat"]]);
      expect(sessions.every(row => row.agent_id === agentId)).toBe(true);
      expect(new Set(sessions.map(row => row.shadow_id)).size).toBe(2);
      expect(new Set(sessions.map(row => row.binding_id)).size).toBe(2);
    } finally {
      await ingress.stop().catch(() => undefined);
      expect(feishuStopped).toBe(true);
      Object.assign(kernelState, originalState);
      database.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("kernel registers configured channels through the adapter registry", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/kernel/kernel.ts"),
      "utf-8",
    );

    expect(source).toContain("ChannelAdapterRegistry");
    expect(source).toContain("channelStore.runtimeConfigs()");
    expect(source).toContain("this._channelAdapterRegistry.create");
    expect(source).toContain("this._lunaMessageIngress.registerChannel");
    expect(source).toContain("registerFeishuChannelAdapterFactory");
    expect(source).not.toContain("unsupported messaging channel skipped");
    expect(source).not.toContain("configured real Feishu");
    expect(source).not.toContain("channels stay disabled");
  });

  test("channel adapter registry rejects unknown runtime channel types", () => {
    const registry = new ChannelAdapterRegistry();

    expect(() =>
      registry.create(
        { type: "unknown", id: "unknown-main" },
        {},
      ),
    ).toThrow(
      'Unknown channel type "unknown" for channel "unknown-main". Registered channel types: (none). Configure a matching ChannelAdapterFactory before runtime startup.',
    );
  });

});

async function _resolveAvailablePort(): Promise<number> {
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

function _getTableColumns(
  database: SQLiteDatabase,
  tableName: string,
): Array<{ name: string; notnull: number; type: string }> {
  return database
    .query<{ name: string; notnull: number; type: string }, [string]>(
      "SELECT name, type, \"notnull\" FROM pragma_table_info(?)",
    )
    .all(tableName);
}

async function _dashboardCookie(
  server: {
    readonly app: {
      fetch(request: Request): Response | Promise<Response>;
    };
  },
  token: string,
): Promise<string> {
  const response = await Promise.resolve(server.app.fetch(
    new Request("http://luna.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  ));
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}

function _writeDashboardDistFixture(
  root: string,
  input: {
    readonly script: string;
    readonly css?: string;
  },
): void {
  const distRoot = join(root, "apps", "dashboard", "dist");
  mkdirSync(distRoot, { recursive: true });
  writeFileSync(
    join(distRoot, "index.html"),
    [
      "<!doctype html>",
      '<div id="root"></div>',
      '<link rel="stylesheet" href="/agent/main.css" />',
      '<script type="module" src="/agent/main.js"></script>',
    ].join(""),
    "utf-8",
  );
  writeFileSync(
    join(distRoot, "artifact-preview.html"),
    [
      "<!doctype html>",
      '<div id="artifact-preview-root"></div>',
      '<link rel="stylesheet" href="/agent/main.css" />',
      '<script type="module" src="/agent/artifact-preview.js"></script>',
    ].join(""),
    "utf-8",
  );
  writeFileSync(join(distRoot, "main.js"), input.script, "utf-8");
  writeFileSync(join(distRoot, "artifact-preview.js"), input.script, "utf-8");
  writeFileSync(
    join(distRoot, "main.css"),
    input.css ?? ".flex { display: flex; }\n",
    "utf-8",
  );
}

function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitForEvent(
  events: readonly string[],
  eventName: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.includes(eventName)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for event "${eventName}".`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface RuntimeAcceptanceEnv {
  readonly database: DataConnection<typeof lunaSchema>;
  readonly fakeFeishu: FakeFeishuChannel & {
    sendInbound(input: { readonly text: string }): Promise<void>;
  };
  readonly waitForIdle: () => Promise<void>;
  readonly cleanup: () => void;
}

interface RuntimeTestEnvironment {
  readonly database: DataConnection<typeof lunaSchema> & {
    readonly sqlite: SQLiteDatabase;
  };
  readonly cleanup: () => void;
}

function createRuntimeTestEnvironment(): RuntimeTestEnvironment {
  const testHome = mkdtempSync(join(tmpdir(), "luna-runtime-test-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  const previousHome = config.paths.home;
  setLunaHome(testHome);
  const database = new DataConnection(lunaSchema) as DataConnection<
    typeof lunaSchema
  > & { readonly sqlite: SQLiteDatabase };
  Object.defineProperty(database, "sqlite", {
    get(): SQLiteDatabase {
      return (database as unknown as { readonly _sqlite: SQLiteDatabase })
        ._sqlite;
    },
  });

  return {
    database,
    cleanup: () => {
      database.close();
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    },
  };
}

const FEISHU_PROCESSING_REACTION_CANDIDATES = [
  "OneSecond",
  "Typing",
  "OnIt",
  "THINKING",
  "StatusFlashOfInspiration",
] as const;

function feishuReactionCreateEmojiType(input: unknown): string | undefined {
  const emojiType = (input as {
    data?: { reaction_type?: { emoji_type?: unknown } };
  } | undefined)?.data?.reaction_type?.emoji_type;
  return typeof emojiType === "string"
    ? emojiType
    : undefined;
}

function feishuInboundForChannel(
  message: InboundChannelMessage,
): NormalizedInboundMessage {
  return {
    id: message.id,
    channel: {
      type: message.channelType,
      id: message.channelId,
    },
    surface: {
      externalId: message.groupId ?? message.channelId,
      kind:
        message.chatType === "p2p"
          ? "p2p"
          : message.chatType === "group" || message.groupId !== undefined
            ? "group"
            : "unknown",
    },
    ...(message.threadId !== undefined
      ? {
          thread: {
            externalId: message.threadId,
            ...(message.rootMessageId !== undefined
              ? { rootMessageExternalId: message.rootMessageId }
              : {}),
          },
        }
      : {}),
    sender: {
      externalId: message.senderUserId,
      kind: "user",
    },
    text: message.text,
    mentions: [],
    addressing: message.addressing ?? {
      addressedToBot: true,
      reason: message.chatType === "group" ? "mention" : "p2p",
    },
    rawPayload: message.rawPayload ?? message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function _createRuntimeAcceptanceEnv(input: {
  readonly taskRunSupervisor?: (
    database: DataConnection<typeof lunaSchema>,
  ) => TaskRunSupervisor;
} = {}): Promise<RuntimeAcceptanceEnv> {
  const testHome = mkdtempSync(join(tmpdir(), "luna-feishu-e2e-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  const previousHome = config.paths.home;
  setLunaHome(testHome);
  const database = new DataConnection(lunaSchema);
  const channel = new FakeFeishuChannel("feishu-main");
  const agentOwner = "runtime-acceptance-owner";
  fixtureSessionOwnership(database.db, "feishu", channel.id, agentOwner);
  const ingress = new LunaMessageIngress({
    db: database.db,
    runnerType: "mock",
    mainRunner: createDeterministicMainRunner(database.db),
    ...(input.taskRunSupervisor !== undefined
      ? { taskRunSupervisor: input.taskRunSupervisor(database) }
      : {}),
  });
  await ingress.registerChannel(channel);

  let nextMessageSequence = 1;
  const fakeFeishu = Object.assign(channel, {
    async sendInbound(message: { readonly text: string }): Promise<void> {
      const id = `feishu-message-${nextMessageSequence++}`;
      const incoming = {
        id,
        channelType: "feishu",
        channelId: channel.id,
        groupId: "group-acceptance",
        rootMessageId: id,
        senderUserId: "user-acceptance",
        senderProfile: {
          externalUserId: "user-acceptance",
          openId: "user-acceptance",
          displayName: "Acceptance User",
        },
        text: message.text,
      } satisfies InboundChannelMessage;
      const inbound = normalizeInboundForFakeFeishuTest(incoming);
      await channel.emitNormalizedInbound(inbound);
    },
  });

  return {
    database,
    fakeFeishu,
    waitForIdle: () => ingress.waitForIdle(),
    cleanup: () => {
      database.close();
      setLunaHome(previousHome);
      rmSync(testHome, { recursive: true, force: true });
    },
  };
}
