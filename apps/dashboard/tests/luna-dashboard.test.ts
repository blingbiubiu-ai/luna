import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskDetailView } from "../src/app/tasks/task-detail-view";
import { SessionDetailView } from "../src/app/sessions/session-detail-view";
import { logoutDashboard } from "../src/lib/api";
import { isActiveTaskStatus } from "../src/lib/tasks";
import type {
  DashboardContextPack,
  DashboardRunnerContextSeedRecord,
  DashboardUser,
  DashboardTask,
  DashboardTaskRunContextSummary,
  DashboardRuntimeStatus,
  DashboardSession,
  DashboardSessionMessage,
  DashboardSessionTimelineItem,
  DashboardGroup,
  DashboardAccessToken,
  DashboardPluginDetail,
} from "../src/lib/api";
import type { AuthorizationSubjectOption } from "../src/components/subject-picker";

import { AgentStore } from "../../../src/agents/agent-store";
import { BotBindingStore } from "../../../src/agents/bot-binding-store";
import { SessionStore } from "../../../src/sessions/session-store";
import { AgentMemoryStore } from "../../../src/agents/agent-memory-store";
import { DataConnection } from "../../../src/data";
import * as schema from "../../../src/data/schema";
import { HonoServer } from "../../../src/server/server";
import { config, setLunaHome } from "../../../src/shared/config";
import { fixtureOwnerUserId, fixturePlatformAdmin, fixtureScope, fixtureSessionOwnership } from "../../../tests/helpers/platform-fixtures";

const now = Date.parse("2026-05-30T10:00:00.000Z");
const senderColumn = ["sender", "user", "id"].join("_");
const latestSenderColumn = ["latest", "sender", "user", "id"].join("_");
const latestSenderProperty = ["latest", "Sender", "User", "Id"].join("");
const latestSenderDisplayColumn = ["latest", "sender", "display", "name"].join("_");
const latestSenderDisplayProperty = ["latest", "Sender", "Display", "Name"].join("");
const senderDisplayColumn = ["sender", "display", "name"].join("_");
const senderDisplayProperty = ["sender", "Display", "Name"].join("");
const turnSenderProperty = ["sender", "User", "Id"].join("");
const nestedMentionIdentityProperty = ["target", "Identity"].join("");
const longReportLine =
  "Root cause: " + "edge-cache-miss-with-origin-timeout ".repeat(24);
let fixtureHome = "";
const longRunInputPrompt =
  "Playback is failing for EU users. " +
  "Include recent alerts, raw symptoms, customer impact, suspected CDN layers, and next action owners. ".repeat(
    8,
  );
const longTimelineSummary =
  "Runner produced investigation report. " +
  "The timeline row should stay scannable while exposing the full conclusion in a hover preview with copy support. ".repeat(
    6,
  );
const markdownReportSection = [
  "## Evidence",
  "",
  "- `edge-cache` returned 502",
  "- **Origin timeout** exceeded 5s",
].join("\n");

let app: { fetch: (request: Request) => Response | Promise<Response> };
let sqlite: Database;
let connection: DataConnection<typeof schema>;
let previousLunaHome: string;
let fixtureAgentId = "";
const fixtureOwnerId = "local-dashboard-user";
let dashboardCookie = "";
let previousDashboardToken: string | undefined;
let previousBunDashboardToken: string | undefined;

async function getJson<T>(path: string): Promise<T> {
  const response = await app.fetch(
    new Request(fixtureUrl(path), {
      headers: { cookie: dashboardCookie },
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function getUsersJson(): Promise<DashboardUser[]> {
  const response = await getJson<{ users: DashboardUser[] }>(`/api/users?agentId=${fixtureAgentId}`);
  return response.users;
}

beforeAll(async () => {
  previousDashboardToken = process.env.LUNA_DASHBOARD_TOKEN;
  previousBunDashboardToken = Bun.env.LUNA_DASHBOARD_TOKEN;
  process.env.LUNA_DASHBOARD_TOKEN = "dashboard-test-secret";
  Bun.env.LUNA_DASHBOARD_TOKEN = "dashboard-test-secret";

  const testHome = mkdtempSync(join(tmpdir(), "luna-dashboard-"));
  fixtureHome = testHome;
  mkdirSync(join(testHome, "data"), { recursive: true });
  writeFileSync(
    join(testHome, "config.yaml"),
    "{}\n",
  );

  previousLunaHome = config.paths.home;
  setLunaHome(testHome);
  connection = new DataConnection(schema);
  fixturePlatformAdmin(connection.db, fixtureOwnerId);
  fixtureAgentId = fixtureScope(connection.db, fixtureOwnerId).agentId;
  connection.db.insert(schema.users).values({
    id: "luna-system", agentId: fixtureAgentId, kind: "system", displayName: "Luna System", status: "active",
    createdAt: String(now), updatedAt: String(now),
  }).onConflictDoNothing().run();
  app = new HonoServer({ db: connection.db }).app;
  const login = await app.fetch(
    new Request("http://luna.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "dashboard-test-secret" }),
    }),
  );
  expect(login.status).toBe(200);
  dashboardCookie = login.headers.get("set-cookie") ?? "";

  sqlite = new Database(join(testHome, "data", "luna.db"));
  installDashboardFixtureWriteShim(sqlite);
  seedLunaFixture(sqlite, testHome);
});

afterAll(async () => {
  sqlite?.close();
  connection?.close();
  if (previousLunaHome) setLunaHome(previousLunaHome);
  if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
  if (previousDashboardToken === undefined) {
    delete process.env.LUNA_DASHBOARD_TOKEN;
  } else {
    process.env.LUNA_DASHBOARD_TOKEN = previousDashboardToken;
  }
  if (previousBunDashboardToken === undefined) {
    delete Bun.env.LUNA_DASHBOARD_TOKEN;
  } else {
    Bun.env.LUNA_DASHBOARD_TOKEN = previousBunDashboardToken;
  }
});

describe("luna dashboard api", () => {
  test("the platform home and Agent detail work without a bare Dashboard root", async () => {
    for (const path of ["/agent", "/agent/", "/agent?agentId=" + fixtureAgentId]) {
      const response = await app.fetch(new Request("http://luna.test" + path, {
        headers: { cookie: dashboardCookie },
      }));
      expect(response.status).toBe(404);
    }
    for (const path of ["/", "/agent/" + fixtureAgentId, `/agent/${fixtureAgentId}/sessions`, `/agent/${fixtureAgentId}/tasks/task_1`]) {
      const response = await app.fetch(new Request("http://luna.test" + path, {
        headers: { cookie: dashboardCookie },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    }
  });

  test("Agent-scoped detail requests reject records owned by a different Agent", async () => {
    const other = new AgentStore(connection.db).create(fixtureOwnerId, { name: "Other Agent" }, "detail-route-other-agent");
    const paths = [
      "/api/sessions/conv-primary",
      "/api/sessions/conv-primary/timeline",
      "/api/tasks/task_1",
      "/api/tasks/task_1/timeline",
      "/api/tasks/task_1/runs",
      "/api/tasks/task_1/artifacts",
    ];
    for (const path of paths) {
      for (const [agentId, status] of [[fixtureAgentId, 200], [other.id, 404]] as const) {
        const response = await app.fetch(new Request(`http://luna.test${path}?agentId=${agentId}`, {
          headers: { cookie: dashboardCookie },
        }));
        expect(response.status).toBe(status);
      }
    }
  });

  test("dashboard auth protects routes and accepts the configured local token", async () => {
    const anonymousApi = await app.fetch(
      new Request("http://luna.test/api/sessions"),
    );
    expect(anonymousApi.status).toBe(401);
    expect(await anonymousApi.json()).toEqual({
      status: "error",
      code: "unauthorized",
      message: "authentication required",
    });

    const anonymousPage = await app.fetch(
      new Request("http://luna.test/agent/"),
    );
    expect(anonymousPage.status).toBe(302);
    expect(anonymousPage.headers.get("location")).toBe(
      "/login?next=%2Fagent%2F",
    );

    const anonymousSession = await app.fetch(
      new Request("http://luna.test/api/auth/session"),
    );
    expect(anonymousSession.status).toBe(200);
    expect(await anonymousSession.json()).toEqual({
      authenticated: false,
      account: null,
    });

    const invalidLogin = await app.fetch(
      new Request("http://luna.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wrong-token" }),
      }),
    );
    expect(invalidLogin.status).toBe(401);
    expect(await invalidLogin.json()).toEqual({ error: "invalid_token" });

    const validLogin = await app.fetch(
      new Request("http://luna.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "dashboard-test-secret" }),
      }),
    );
    expect(validLogin.status).toBe(200);
    const cookie = validLogin.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("luna_dashboard_session=");
    expect(await validLogin.json()).toEqual({
      authenticated: true,
      account: {
        id: "local-dashboard-user",
        name: "Local dashboard user",
        provider: "local-token",
      },
    });

    const authenticatedSession = await app.fetch(
      new Request("http://luna.test/api/auth/session", {
        headers: { cookie },
      }),
    );
    expect(authenticatedSession.status).toBe(200);
    expect(await authenticatedSession.json()).toEqual({
      authenticated: true,
      account: {
        id: "local-dashboard-user",
        name: "Local dashboard user",
        provider: "local-token",
      },
    });

    const authenticatedApi = await app.fetch(
      new Request(fixtureUrl("/api/sessions"), {
        headers: { cookie },
      }),
    );
    expect(authenticatedApi.status).toBe(200);
  });

  test("/api/sessions returns sessions", async () => {
    const sessions = await getJson<
      Array<{
        id: string;
        title: string | null;
        channel_type: string;
        channelType: string;
        message_count: number;
        thread_anchor_preview: string | null;
        threadAnchorPreview: string | null;
        latest_message_preview: string | null;
        latestMessagePreview: string | null;
        latest_message_at: number | null;
        latestMessageAt: number | null;
        linked_tasks: Array<{ id: string; title: string }>;
        linkedTasks: Array<{ id: string; title: string }>;
      }>
    >("/api/sessions");

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: "conv-primary",
      title: "Playback investigation thread",
      channel_type: "feishu",
      channelType: "feishu",
      message_count: 3,
      latest_message_preview: "Please include raw logs.",
      latestMessagePreview: "Please include raw logs.",
      latest_message_at: now + 2_000,
      latestMessageAt: now + 2_000,
      linked_tasks: [
        { id: "task_1", title: "Playback failure investigation" },
      ],
      linkedTasks: [
        { id: "task_1", title: "Playback failure investigation" },
      ],
    });
    expect(sessions[1]).toMatchObject({
      id: "conv-secondary",
      latest_message_preview: "Please include raw logs.",
      latestMessagePreview: "Please include raw logs.",
      latest_message_at: now + 2_000,
      latestMessageAt: now + 2_000,
      linked_tasks: [
        { id: "task_1", title: "Playback failure investigation" },
      ],
      linkedTasks: [
        { id: "task_1", title: "Playback failure investigation" },
      ],
    });
    expect(sessions[0]).toMatchObject({
      id: "conv-primary",
      thread_anchor_preview: "Playback is failing for EU users",
      threadAnchorPreview: "Playback is failing for EU users",
    });
    expect(sessions[1]).toMatchObject({
      id: "conv-secondary",
      thread_anchor_preview: "Playback is failing for EU users",
      threadAnchorPreview: "Playback is failing for EU users",
    });
    expect(Object.hasOwn(sessions[0] ?? {}, latestSenderColumn)).toBe(false);
    expect(Object.hasOwn(sessions[0] ?? {}, latestSenderProperty)).toBe(true);
    expect(Object.hasOwn(sessions[0] ?? {}, latestSenderDisplayColumn)).toBe(false);
    expect(Object.hasOwn(sessions[0] ?? {}, latestSenderDisplayProperty)).toBe(false);
    expect(sessions[0]).toMatchObject({
      latestSenderUserId: "directory-user-requester",
      latestSenderUser: {
        id: "directory-user-requester",
        displayName: "示例用户",
        status: "active",
      },
    });
  });

  test("/api/sessions exposes launch context packs and seed records", async () => {
    const sessions = await getJson<DashboardSession[]>("/api/sessions");
    const primary = sessions.find((session) => session.id === "conv-primary");
    const secondary = sessions.find((session) => session.id === "conv-secondary");

    expect(primary).toMatchObject({
      id: "conv-primary",
      contextPacks: [
        expect.objectContaining({
          id: "session-group-activation-pack",
          kind: "group_activation",
          selectionStrategy: "deterministic_window",
          triggerEntryId: "entry-conv-primary-msg-user-2-message",
          triggerMessageId: "msg-user-2",
          items: [
            expect.objectContaining({
              id: "session-group-activation-item",
              contextPackId: "session-group-activation-pack",
              itemKind: "message",
              itemId: "msg-user-1",
              role: "delta_context",
              reason: "recent silent group context",
              sourceSessionId: "conv-primary",
              sourceEntryId: "entry-conv-primary-msg-user-1-message",
              sourceMessageId: "msg-user-1",
              messagePreview: "Playback is failing for EU users",
              contextMessage: expect.objectContaining({
                id: "msg-user-1",
                entryId: "entry-conv-primary-msg-user-1-message",
                sessionId: "conv-primary",
              }),
            }),
          ],
        }),
      ],
      launchContextPacks: [],
      seedRecords: [],
    });
    expect(secondary).toMatchObject({
      id: "conv-secondary",
      contextPacks: [
        expect.objectContaining({
          id: "session-thread-launch-pack",
          kind: "thread_launch",
        }),
      ],
      launchContextPacks: [
        expect.objectContaining({
          id: "session-thread-launch-pack",
          kind: "thread_launch",
          selectionStrategy: "anchor_turn",
          items: expect.arrayContaining([
            expect.objectContaining({
              id: "session-thread-launch-anchor-item",
              itemKind: "timeline_entry",
              itemId: "ref-projected-anchor",
              role: "launch_context",
              sourceEntryId: "entry-conv-primary-msg-user-1-message",
              sourceMessageId: "msg-user-1",
              messagePreview: "Playback is failing for EU users",
            }),
            expect.objectContaining({
              id: "session-thread-launch-followup-item",
              sourceEntryId: "entry-conv-primary-msg-user-2-message",
              sourceMessageId: "msg-user-2",
              contextMessage: expect.objectContaining({
                id: "msg-user-2",
                sessionId: "conv-primary",
              }),
            }),
          ]),
        }),
      ],
      seedRecords: [
        expect.objectContaining({
          id: "seed-session-thread-launch",
          runnerContextId: "runner-context-session-thread",
          seedContextPackId: "session-thread-launch-pack",
          seedEntryIds: [
            "entry-conv-primary-msg-user-1-message",
            "entry-conv-primary-msg-user-2-message",
          ],
          seedContextItemIds: [
            "session-thread-launch-anchor-item",
            "session-thread-launch-followup-item",
          ],
        }),
      ],
    });
  });

  test("/api/sessions keeps old context pack metadata local paths as text", async () => {
    const packPath = join(
      fixtureHome,
      "workspace",
      "context-pack",
      "session-note.md",
    );
    const itemPath = join(
      fixtureHome,
      "workspace",
      "context-pack",
      "message-note.md",
    );

    sqlite.run(
      `UPDATE context_packs SET metadata_json = ? WHERE id = ?`,
      [
        JSON.stringify({ sourcePath: packPath }),
        "session-group-activation-pack",
      ],
    );
    sqlite.run(
      `UPDATE context_pack_items SET metadata_json = ? WHERE id = ?`,
      [
        JSON.stringify({ evidencePath: itemPath }),
        "session-group-activation-item",
      ],
    );

    try {
      const sessions = await getJson<DashboardSession[]>("/api/sessions");
      const primary = sessions.find((session) => session.id === "conv-primary");
      const pack = primary?.contextPacks.find(
        (item) => item.id === "session-group-activation-pack",
      );
      const packItem = pack?.items.find(
        (item) => item.id === "session-group-activation-item",
      );

      expect(JSON.stringify(primary)).toContain(fixtureHome);
      expect(pack?.metadata).toEqual({
        sourcePath: packPath,
      });
      expect(packItem?.metadata).toEqual({
        evidencePath: itemPath,
      });
    } finally {
      sqlite.run(`UPDATE context_packs SET metadata_json = NULL WHERE id = ?`, [
        "session-group-activation-pack",
      ]);
      sqlite.run(
        `UPDATE context_pack_items SET metadata_json = NULL WHERE id = ?`,
        ["session-group-activation-item"],
      );
    }
  });

  test("Agent user list hides deleted and other Agents' Shadow identities", async () => {
    const agents = new AgentStore(connection.db);
    const live = agents.createShadow(fixtureOwnerId, fixtureAgentId, { name: "Listed Shadow" }, "user-list-live");
    const removed = agents.createShadow(fixtureOwnerId, fixtureAgentId, { name: "Deleted Shadow" }, "user-list-deleted");
    const other = agents.create(fixtureOwnerId, { name: "Other user list Agent" }, "user-list-other");
    sqlite.run("UPDATE agent_shadows SET status = 'deleted' WHERE id = ?", [removed.id]);

    const { users } = await getJson<{ users: DashboardUser[] }>(`/api/users?agentId=${fixtureAgentId}`);
    const ids = users.map(user => user.id);
    expect(ids).toContain(live.replyUserId);
    expect(ids).toContain(fixtureOwnerUserId(fixtureOwnerId));
    expect(ids).not.toContain(removed.replyUserId);
    expect(ids).not.toContain(agents.shadow(other.defaultShadowId).replyUserId);
    const historical = await getJson<DashboardUser>(`/api/users/${removed.replyUserId}?agentId=${fixtureAgentId}`);
    expect(historical.id).toBe(removed.replyUserId);
  });

  test("/api/users summarizes users across channels of one Agent", async () => {
    insertFixtureSessions(sqlite, [
      "conv-users-secondary-owned",
      "feishu:chat:group-users:thread-owned",
      "feishu",
      "chat",
      "group-users",
      "thread-owned",
      "root-owned",
      "Owned newer activity",
      now + 6_000,
      now + 7_000,
      "conv-users-other-channel",
      "feishu:other-chat:group-users:thread-other",
      "feishu",
      "other-chat",
      "group-users-other",
      "thread-other",
      "root-other",
      "Other channel activity",
      now + 8_000,
      now + 9_000,
    ]);
    sqlite.run(
      `INSERT INTO channel_surfaces
        (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-chat-users-group",
        "feishu",
        "chat",
        "group-users",
        "group",
        "用户测试群",
        null,
        JSON.stringify({ providerSurfaceId: "group-users" }),
        JSON.stringify({ source: "users-fixture" }),
        now + 6_000,
        now + 7_000,
        now + 7_000,
        now + 6_000,
        now + 7_000,
        "directory-chat-users-p2p",
        "feishu",
        "chat",
        "group-users-p2p",
        "p2p",
        null,
        null,
        JSON.stringify({ providerSurfaceId: "group-users-p2p" }),
        JSON.stringify({ source: "users-p2p-fixture" }),
        now + 9_000,
        now + 9_000,
        now + 9_000,
        now + 9_000,
        now + 9_000,
      ],
    );
    sqlite.run(
      `INSERT INTO channel_identities
        (id, channel_type, channel_id, external_id, identity_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-user-users-p2p",
        "feishu",
        "chat",
        "ou_users_p2p",
        "user",
        "李四",
        null,
        JSON.stringify({ providerAccountId: "user_users_p2p" }),
        JSON.stringify({ source: "users-p2p-fixture" }),
        now + 9_000,
        now + 9_500,
        now + 9_500,
        now + 9_000,
        now + 9_500,
      ],
    );
    insertCanonicalUserFixture(sqlite, {
      userId: "directory-user-users-p2p",
      channelIdentityId: "directory-user-users-p2p",
      kind: "human",
      displayName: "李四",
      avatarUrl: null,
      identityValue: "ou_users_p2p",
      createdAt: now + 9_000,
    });
    insertFixtureSessions(sqlite, [
      "conv-users-p2p-owned",
      "feishu:chat:group-users-p2p",
      "feishu",
      "chat",
      "group-users-p2p",
      null,
      null,
      "P2P fallback title should not win",
      now + 9_000,
      now + 9_500,
    ]);
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-users-secondary-owned",
        "conv-users-secondary-owned",
        "m-users-owned",
        "directory-user-requester",
        "user",
        JSON.stringify([{ type: "text", text: "New owned follow-up" }]),
        JSON.stringify({ text: "New owned follow-up" }),
        now + 6_500,
        "msg-users-internal-same-sender",
        "conv-users-secondary-owned",
        "main-runner-action:conv-users-secondary-owned:marker:selected",
        "directory-user-requester",
        "assistant",
        JSON.stringify([]),
        JSON.stringify({ origin: "main_runner_action_marker" }),
        now + 7_500,
        "msg-users-other-channel",
        "conv-users-other-channel",
        "m-users-other",
        "ou_requester",
        "user",
        JSON.stringify([{ type: "text", text: "Other channel message" }]),
        JSON.stringify({ text: "Other channel message" }),
        now + 8_500,
        "msg-users-p2p-owned",
        "conv-users-p2p-owned",
        "m-users-p2p",
        "ou_users_p2p",
        "user",
        JSON.stringify([{ type: "text", text: "P2P hello" }]),
        JSON.stringify({ text: "P2P hello" }),
        now + 9_250,
      ],
    );

    const users = await getUsersJson();

    const requester = users.find((user) => user.id === "directory-user-requester");
    expect(requester).toMatchObject({
      kind: "human",
      displayName: "示例用户",
      linkedIdentities: [
        expect.objectContaining({
          identityNamespace: "lark",
          identityKind: "open_id",
          identityValue: "ou_requester",
          channelIdentity: expect.objectContaining({
            channelType: "feishu",
            channelId: "chat",
          }),
        }),
      ],
      messageCount: 3,
      sessionCount: 2,
      latestSessionId: "conv-users-secondary-owned",
      latestSessionTitle: "用户测试群",
    });

    const wrongChannel = users.find((user) => user.displayName === "错误频道用户");
    expect(wrongChannel).toMatchObject({
      id: "directory-user-wrong-channel",
      messageCount: 1,
      sessionCount: 1,
      latestSessionId: "conv-users-other-channel",
    });
    const p2pUser = users.find((user) => user.id === "directory-user-users-p2p");
    expect(p2pUser).toMatchObject({
      displayName: "李四",
      messageCount: 1,
      sessionCount: 1,
      latestSessionId: "conv-users-p2p-owned",
      latestSessionTitle: "李四",
    });
    const bot = users.find((user) => user.id === "directory-identity-luna-bot");
    expect(bot).toMatchObject({
      kind: "bot",
      displayName: "Monkey King",
      linkedIdentities: [
        expect.objectContaining({
          identityValue: "ou_luna_bot",
        }),
      ],
    });
  });

  test("/api/sessions scopes thread anchor root preview to the owning session", async () => {
    insertFixtureSessions(sqlite, [
      "conv-root-collision-source",
      "feishu:other-chat:group-ops:thread-collision-source",
      "feishu",
      "other-chat",
      "group-ops",
      "thread-collision-source",
      null,
      "Collision source",
      now + 10_000,
      now + 10_000,
      "conv-root-target",
      "feishu:chat:group-ops:thread-root-target",
      "feishu",
      "chat",
      "group-ops",
      "thread-root-target",
      "shared-root-channel-id",
      "Root target",
      now + 11_000,
      now + 11_000,
      "conv-root-fallback-target",
      "feishu:chat:group-ops:thread-root-fallback-target",
      "feishu",
      "chat",
      "group-ops",
      "thread-root-fallback-target",
      "external-only-root-channel-id",
      "Root fallback target",
      now + 12_000,
      now + 12_000,
    ]);
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-root-colliding-channel-id",
        "conv-root-collision-source",
        "shared-root-channel-id",
        "ou_requester",
        "user",
        JSON.stringify([{ type: "text", text: "Wrong collision root preview" }]),
        JSON.stringify({ text: "Wrong collision root preview" }),
        now + 10_100,
        "msg-root-external-only-collision",
        "conv-root-collision-source",
        "external-only-root-channel-id",
        "ou_requester",
        "user",
        JSON.stringify([{ type: "text", text: "Wrong external-only root preview" }]),
        JSON.stringify({ text: "Wrong external-only root preview" }),
        now + 10_200,
        "msg-root-target-channel-id",
        "conv-root-target",
        "shared-root-channel-id",
        "ou_requester",
        "user",
        JSON.stringify([{ type: "text", text: "Target root preview wins" }]),
        JSON.stringify({ text: "Target root preview wins" }),
        now + 11_100,
      ],
    );
    sqlite.run(
      `INSERT INTO fixture_message_refs
        (id, session_id, message_id, source_session_id, relation, include_in_context, created_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?)`,
      [
        "ref-root-target-anchor-fallback",
        "conv-root-target",
        "msg-user-1",
        "conv-primary",
        "thread_anchor",
        1,
        now + 11_200,
        "ref-root-fallback-target-anchor",
        "conv-root-fallback-target",
        "msg-user-1",
        "conv-primary",
        "thread_anchor",
        1,
        now + 12_200,
      ],
    );

    try {
      const sessions = await getJson<
        Array<{
          id: string;
          thread_anchor_preview: string | null;
          threadAnchorPreview: string | null;
        }>
      >("/api/sessions");

      expect(sessions).toContainEqual(
        expect.objectContaining({
          id: "conv-root-target",
          thread_anchor_preview: "Target root preview wins",
          threadAnchorPreview: "Target root preview wins",
        }),
      );
      expect(sessions).toContainEqual(
        expect.objectContaining({
          id: "conv-root-fallback-target",
          thread_anchor_preview: "Playback is failing for EU users",
          threadAnchorPreview: "Playback is failing for EU users",
        }),
      );
    } finally {
      sqlite.run(
        `DELETE FROM fixture_message_refs WHERE id IN (?, ?)`,
        ["ref-root-target-anchor-fallback", "ref-root-fallback-target-anchor"],
      );
      sqlite.run(
        `DELETE FROM fixture_messages WHERE id IN (?, ?, ?)`,
        [
          "msg-root-colliding-channel-id",
          "msg-root-external-only-collision",
          "msg-root-target-channel-id",
        ],
      );
      sqlite.run(
        `DELETE FROM sessions WHERE id IN (?, ?, ?)`,
        [
          "conv-root-collision-source",
          "conv-root-target",
          "conv-root-fallback-target",
        ],
      );
    }
  });

  test("/api/sessions does not show projected thread anchors on rootless sessions", async () => {
    insertFixtureSessions(sqlite, [
      "conv-rootless-p2p",
      "feishu:chat:group-rootless-p2p:channel-rootless",
      "feishu",
      "chat",
      "group-rootless-p2p",
      null,
      null,
      null,
      now + 13_000,
      now + 15_000,
    ]);
    sqlite.run(
      `INSERT INTO channel_surfaces
        (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-chat-rootless-p2p",
        "feishu",
        "chat",
        "group-rootless-p2p",
        "p2p",
        null,
        null,
        JSON.stringify({ providerSurfaceId: "group-rootless-p2p" }),
        JSON.stringify({ source: "rootless-p2p-fixture" }),
        now + 13_000,
        now + 15_000,
        now + 15_000,
        now + 13_000,
        now + 15_000,
      ],
    );
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-rootless-user",
        "conv-rootless-p2p",
        "m-rootless-user",
        "ou_requester",
        "user",
        JSON.stringify([{ type: "text", text: "天上什么最亮" }]),
        JSON.stringify({ text: "天上什么最亮" }),
        now + 14_000,
        "msg-rootless-assistant",
        "conv-rootless-p2p",
        "m-rootless-assistant",
        null,
        "assistant",
        JSON.stringify([{ type: "text", text: "白天是太阳最亮。" }]),
        JSON.stringify({ text: "白天是太阳最亮。" }),
        now + 15_000,
      ],
    );
    sqlite.run(
      `INSERT INTO fixture_message_refs
        (id, session_id, message_id, source_session_id, relation, include_in_context, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "ref-rootless-thread-anchor",
        "conv-rootless-p2p",
        "msg-user-1",
        "conv-primary",
        "thread_anchor",
        1,
        now + 15_100,
      ],
    );

    try {
      const sessions = await getJson<
        Array<{
          id: string;
          thread_anchor_preview: string | null;
          threadAnchorPreview: string | null;
          latest_message_preview: string | null;
        }>
      >("/api/sessions");

      expect(sessions).toContainEqual(
        expect.objectContaining({
          id: "conv-rootless-p2p",
          thread_anchor_preview: null,
          threadAnchorPreview: null,
          latest_message_preview: "白天是太阳最亮。",
        }),
      );
    } finally {
      sqlite.run(`DELETE FROM fixture_message_refs WHERE id = ?`, [
        "ref-rootless-thread-anchor",
      ]);
      sqlite.run(`DELETE FROM fixture_messages WHERE session_id = ?`, [
        "conv-rootless-p2p",
      ]);
      sqlite.run(`DELETE FROM channel_surfaces WHERE id = ?`, [
        "directory-chat-rootless-p2p",
      ]);
      sqlite.run(`DELETE FROM sessions WHERE id = ?`, [
        "conv-rootless-p2p",
      ]);
    }
  });

  test("session list separates retired Feishu bindings from current conversations", async () => {
    const channelId = "session-history-test";
    const scope = fixtureSessionOwnership(connection.db, "feishu", channelId, fixtureOwnerId);
    const store = new SessionStore(connection.db);
    const bindings = new BotBindingStore(connection.db);
    const surface = { channelType: "feishu", channelId, groupId: "history-test-group" };
    const previous = store.resolveByChannelSurface(surface);
    bindings.retire(fixtureOwnerId, scope.binding_id!);
    bindings.bind(fixtureOwnerId, scope.shadow_id, channelId);
    const current = store.resolveByChannelSurface(surface);
    const sessions = await getJson<DashboardSession[]>(`/api/sessions?agentId=${fixtureAgentId}&shadowId=${scope.shadow_id}`);
    expect(sessions).toHaveLength(2);
    expect(sessions.find(row => row.id === previous.id)?.bindingStatus).toBe("retired");
    expect(sessions.find(row => row.id === current.id)?.bindingStatus).toBe("active");
    const historical = await getJson<DashboardSession>(`/api/sessions/${previous.id}?agentId=${fixtureAgentId}`);
    expect(historical.bindingStatus).toBe("retired");

    const { SessionsListForTest } = await import("../src/app/sessions/sessions-list");
    const html = renderToStaticMarkup(createElement(SessionsListForTest, { sessions, query: "", loading: false, error: null }));
    expect(html).toContain(current.id);
    expect(html).not.toContain(previous.id);
    expect(html).toContain("历史绑定 (1)");
  });

  test("session list renders and searches latest message preview", async () => {
    const sessions = await getJson<DashboardSession[]>(
      "/api/sessions",
    );

    const { SessionsListForTest } = await import(
      "../src/app/sessions/sessions-list"
    );
    const html = renderToStaticMarkup(
      createElement(SessionsListForTest, {
        sessions,
        query: "raw logs",
        loading: false,
        error: null,
      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };

    expect(renderedMarkupText(html)).toContain(
      "示例用户 : Please include raw logs.",
    );
    expect(
      document.querySelector('a[href="/agent/users/directory-user-requester"]')
        ?.textContent,
    ).toContain("示例用户");
    expect(html).toContain("conv-primary");
  });

  test("home overview renders live runtime channel status", async () => {
    const { HomeOverviewForTest } = await import(
      "../src/app/home-overview"
    );
    const runtimeStatus: DashboardRuntimeStatus = {
      status: "ok",
      uptime: 42,
      agent: {
        type: "codex",
        model: "gpt-5",
      },
      channels: [
        {
          id: "feishu-default",
          type: "feishu",
          inbound: {
            state: "connected",
            lastConnectAt: now,
            reconnectAttempts: 0,
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(HomeOverviewForTest, {
        tasks: [],
        sessions: [],
        runtimeStatus,
        runtimeLoading: false,
        runtimeError: null,
      }),
    );
    const text = renderedMarkupText(html);

    expect(text).toContain("Runtime ok");
    expect(text).toContain("Feishu connected");
    expect(text).toContain("1 channel");
    expect(text).toContain("Service running");
    expect(text).not.toContain("Mock MCP");
    expect(text).not.toContain("Runtime online");
  });

  test("session list renders and searches thread anchor preview", async () => {
    const sessions = await getJson<DashboardSession[]>(
      "/api/sessions",
    );
    const { SessionsListForTest } = await import(
      "../src/app/sessions/sessions-list"
    );
    const html = renderToStaticMarkup(
      createElement(SessionsListForTest, {
        sessions,
        query: "EU users",
        loading: false,
        error: null,
      }),
    );

    expect(html).toContain("锚点：Playback is failing for EU users");
    expect(html).toContain("conv-secondary");
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const sessionLink = document.querySelector(
      'a[href="/agent/sessions/conv-secondary"]',
    );
    expect(sessionLink?.textContent).toContain(
      "Ops escalation 锚点：Playback is failing for EU users",
    );
  });

  test("session list avoids repeating the surface name when it is already the title", async () => {
    const sessions = await getJson<DashboardSession[]>(
      "/api/sessions",
    );
    const { SessionsListForTest } = await import(
      "../src/app/sessions/sessions-list"
    );
    const html = renderToStaticMarkup(
      createElement(SessionsListForTest, {
        sessions,
        query: "播放排查群",
        loading: false,
        error: null,
      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const sessionLink = document.querySelector(
      'a[href="/agent/sessions/conv-primary"]',
    );

    expect(sessionLink?.textContent).toContain("播放排查群");
    expect(sessionLink?.textContent).not.toContain(
      "播放排查群 · group: 播放排查群",
    );
    const tableHeads = Array.from(document.querySelectorAll("th")).map(
      (node) => node.textContent ?? "",
    );
    expect(tableHeads).not.toContain("Surface");
  });

  test("session list does not render p2p raw surface identifiers as titles", async () => {
    const sessions: DashboardSession[] = [
      {
        id: "conv-p2p-thread",
        channel_type: "feishu",
        channelType: "feishu",
        channel_id: "feishu-default",
        group_id: "oc_private_chat",
        thread_id: "omt_private_thread",
        root_message_id: "om_private_root",
        title: null,
        display_title: "示例用户",
        displayTitle: "示例用户",
        surface: {
          id: "surface-p2p",
          externalId: "oc_private_chat",
          kind: "p2p",
          displayName: "Test Group",
          avatarUrl: null,
        },
        message_count: 2,
        thread_anchor_preview: "晚上好，今晚会下雨吗",
        threadAnchorPreview: "晚上好，今晚会下雨吗",
        latest_message_preview: "广州今晚会下雨。",
        latestMessagePreview: "广州今晚会下雨。",
        latestSender: null,
        latest_message_at: now,
        latestMessageAt: now,
        linked_tasks: [],
        linkedTasks: [],
        contextPacks: [],
        launchContextPacks: [],
        seedRecords: [],
        created_at: now,
        updated_at: now,
      },
    ];
    const { SessionsListForTest } = await import(
      "../src/app/sessions/sessions-list"
    );
    const html = renderToStaticMarkup(
      createElement(SessionsListForTest, {
        sessions,
        query: "",
        loading: false,
        error: null,
      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const sessionLink = document.querySelector(
      'a[href="/agent/sessions/conv-p2p-thread"]',
    );

    expect(sessionLink?.textContent).toContain(
      "示例用户 锚点：晚上好，今晚会下雨吗",
    );
    expect(sessionLink?.textContent).not.toContain("oc_private_chat");
    expect(sessionLink?.textContent).not.toContain("p2p:");
    expect(sessionLink?.textContent).not.toContain("Test Group");
  });

  test("users dashboard renders global user directory", async () => {
    const users: DashboardUser[] = [
      {
        id: "user-ou-requester",
        kind: "human",
        displayName: "示例用户",
        avatarUrl: "https://avatar.example/ou_requester.png",
        status: "active",
        profileSource: "channel",
        linkedIdentities: [
          {
            id: "link-user-ou-requester",
            channelIdentityId: "directory-user-requester",
            identityNamespace: "lark",
            identityKind: "open_id",
            identityValue: "ou_requester",
            identityScope: "",
            confidence: "verified",
            isPrimary: true,
            createdAt: String(now),
            updatedAt: String(now),
            channelIdentity: {
              id: "directory-user-requester",
              channelType: "feishu",
              channelId: "chat",
              externalId: "ou_requester",
              identityKind: "user",
              displayName: "示例用户",
              avatarUrl: "https://avatar.example/ou_requester.png",
            },
          },
        ],
        messageCount: 3,
        sessionCount: 2,
        latestSessionId: "conv-users-secondary-owned",
        latestSessionTitle: "Owned newer activity",
        groups: [],
        directGrants: [],
        indirectGrants: [],
      },
      {
        id: "user-wrong-channel",
        kind: "human",
        displayName: "错误频道用户",
        avatarUrl: null,
        status: "active",
        profileSource: "channel",
        linkedIdentities: [
          {
            id: "link-user-wrong-channel",
            channelIdentityId: "directory-user-wrong-channel",
            identityNamespace: "lark",
            identityKind: "open_id",
            identityValue: "ou_wrong",
            identityScope: "",
            confidence: "verified",
            isPrimary: true,
            createdAt: String(now),
            updatedAt: String(now),
            channelIdentity: {
              id: "directory-user-wrong-channel",
              channelType: "feishu",
              channelId: "other-chat",
              externalId: "ou_wrong",
              identityKind: "user",
              displayName: "错误频道用户",
              avatarUrl: null,
            },
          },
        ],
        messageCount: 1,
        sessionCount: 1,
        latestSessionId: "conv-users-other-channel",
        latestSessionTitle: "Other channel activity",
        groups: [],
        directGrants: [],
        indirectGrants: [],
      },
      {
        id: "user-luna-bot",
        kind: "bot",
        displayName: "Luna Bot",
        avatarUrl: null,
        status: "active",
        profileSource: "channel",
        linkedIdentities: [
          {
            id: "link-user-luna-bot-open",
            channelIdentityId: "directory-identity-luna-bot",
            identityNamespace: "lark",
            identityKind: "open_id",
            identityValue: "ou_luna_bot",
            identityScope: "",
            confidence: "verified",
            isPrimary: true,
            createdAt: String(now),
            updatedAt: String(now),
            channelIdentity: {
              id: "directory-identity-luna-bot",
              channelType: "feishu",
              channelId: "chat",
              externalId: "ou_luna_bot",
              identityKind: "bot",
              displayName: "Luna Bot",
              avatarUrl: null,
            },
          },
          {
            id: "link-user-luna-bot-app",
            channelIdentityId: null,
            identityNamespace: "lark",
            identityKind: "app_id",
            identityValue: "cli_luna_bot",
            identityScope: "",
            confidence: "verified",
            isPrimary: false,
            createdAt: String(now),
            updatedAt: String(now),
            channelIdentity: null,
          },
        ],
        messageCount: 0,
        sessionCount: 0,
        latestSessionId: null,
        latestSessionTitle: null,
        groups: [],
        directGrants: [],
        indirectGrants: [],
      },
    ];
    const { UsersListForTest } = await import(
      "../src/app/users/users-list"
    );
    const html = renderToStaticMarkup(
      createElement(UsersListForTest, {
        users,
        query: "示例用户",
        loading: false,
        error: null,
      }),
    );

    expect(html).toContain("示例用户");
    expect(html).toContain("https://avatar.example/ou_requester.png");
    expect(html).toContain("feishu/chat");
    expect(html).toContain("3 messages");
    expect(html).toContain("2 sessions");
    expect(html).toContain("Owned newer activity");
    expect(html).toContain("human");
    expect(html).toContain("1 identity");
    expect(html).not.toContain("错误频道用户");
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const identityCell = document.querySelector(
      '[data-testid="user-list-identity-user-ou-requester"]',
    );
    expect(identityCell?.getAttribute("class") ?? "").toContain("items-center");

    const botHtml = renderToStaticMarkup(
      createElement(UsersListForTest, {
        users,
        query: "Luna",
        loading: false,
        error: null,
      }),
    );
    expect(botHtml).toContain("Luna Bot");
    expect(botHtml).toContain("bot");
    expect(botHtml).toContain("2 identities");
  });

  test("platform rail opens account menu from the user avatar", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/components/platform-rail.tsx"),
      "utf-8",
    );

    expect(source).toContain("function RailUserMenu");
    expect(source).toContain('data-testid="sidebar-user-menu-trigger"');
    expect(source).toContain('data-testid="sidebar-user-menu-profile"');
    expect(source).toContain('data-testid="sidebar-settings-menu-item"');
    expect(source).toContain('data-testid="sidebar-logout-button"');
    expect(source).toContain("<DropdownMenuTrigger asChild>");
    expect(source).toContain("<DropdownMenuContent");
    expect(source).toContain('side="right"');
    expect(source).toContain("<DropdownMenuSeparator");
    expect(source).toContain("Settings");
    expect(source).toContain("Log out");
    expect(source).toContain("<RailUserMenu isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} />");
    expect(source).not.toContain("<SidebarLogoutButton />");
  });

  test("logout helper clears auth session", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const previousFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (
      input: unknown,
      init?: RequestInit,
    ) => {
      fetchCalls.push({ url: String(input), init });
      return new Response(JSON.stringify({ authenticated: false, account: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await logoutDashboard();
      expect(fetchCalls).toEqual([
        {
          url: "/api/auth/logout",
          init: { method: "POST" },
        },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("dashboard hooks use flat /api namespace", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/lib/api/hooks.ts"),
      "utf-8",
    );

    expect(source).toContain('useDashboardResourceList<DashboardSession>("sessions", scope)');
    expect(source).toContain('`/users?agentId=');
    expect(source).toContain('useDashboardResourceList<DashboardTask>("tasks", scope)');
    expect(source).toContain('new URLSearchParams({ agentId: agentId! })');
    expect(source).not.toContain('"/agent/sessions"');
    expect(source).not.toContain('"/agent/users"');
    expect(source).not.toContain('"/agent/tasks"');
  });

  test("unified dashboard exposes Knowledge Operations Marketplace and Groups management routes", () => {
    const hooks = readFileSync(
      join(import.meta.dir, "../src/lib/api/hooks.ts"),
      "utf-8",
    );
    const usersList = readFileSync(
      join(import.meta.dir, "../src/app/users/users-list.tsx"),
      "utf-8",
    );
    const userProfile = readFileSync(
      join(import.meta.dir, "../src/app/users/user-profile.tsx"),
      "utf-8",
    );
    const groupsDashboard = readFileSync(
      join(import.meta.dir, "../src/app/groups/groups-dashboard.tsx"),
      "utf-8",
    );
    const sidebar = readFileSync(
      join(import.meta.dir, "../src/components/app-sidebar.tsx"),
      "utf-8",
    );
    const routeTree = readFileSync(
      join(import.meta.dir, "../src/routeTree.gen.ts"),
      "utf-8",
    );

    expect(hooks).toContain("/workspaces/${encodeURIComponent(workspaceId)}/${operation}");
    expect(hooks).toContain('workspaceId, "glob"');
    expect(hooks).toContain("useOperations");
    expect(hooks).toContain('`/operations?${params}`');
    expect(hooks).toContain('"/groups"');
    // Users and Groups pages grant on the Agent, never on the platform.
    expect(hooks).not.toContain('"/authorization-rules"');
    expect(hooks).not.toContain('"/authorization-rules/batch"');
    expect(hooks).toContain("/authorization-rules/batch?agentId=");
    expect(hooks).toContain('method: "DELETE"');
    expect(hooks).not.toContain('"/principals"');
    expect(hooks).toContain('apiFetch<{ users: DashboardUser[] }>(`/users?agentId=');
    expect(hooks).toContain("return json.users");
    expect(hooks).toContain("kind:");
    expect(hooks).toContain("linkedIdentities");
    expect(hooks).toContain("groups:");
    expect(hooks).toContain("directGrants:");
    expect(hooks).toContain("indirectGrants:");
    expect(hooks).not.toContain("Principal");
    expect(hooks).not.toContain("identityKind: string");
    expect(usersList).toContain("linkedIdentities");
    expect(usersList).toContain("user.kind");
    expect(usersList).not.toContain("user.externalId");
    expect(userProfile).toContain("linkedIdentities");
    expect(userProfile).toContain("Identities");
    expect(userProfile).toContain("Luna User ID");
    expect(userProfile).toContain("Direct grants");
    expect(userProfile).toContain("Indirect grants");
    expect(userProfile).not.toContain("Principal ID");
    expect(userProfile).not.toContain("user.externalId");
    expect(groupsDashboard).toContain("Group directory");
    expect(groupsDashboard).toContain("memberCount");
    expect(groupsDashboard).toContain("directGrants");
    expect(sidebar).toContain("Knowledge");
    expect(sidebar).not.toContain("Operations");
    expect(sidebar).toContain('title: "Plugins"');
    expect(sidebar).not.toContain('title: "Marketplace"');
    expect(sidebar).toContain("Groups");
    expect(sidebar).toContain("Tokens");
    expect(sidebar).toContain("/settings/tokens");
    expect(sidebar).not.toContain("Principals");
    expect(routeTree).toContain("'/$agentId/knowledge/'");
    expect(routeTree).not.toContain("'/operations/'");
    expect(routeTree).toContain("'/$agentId/plugins/'");
    // Plugin installation lives on the platform shell, not inside an Agent.
    expect(routeTree).not.toContain("'/$agentId/plugins/$pluginId'");
    expect(routeTree).toContain("'/$agentId/groups/'");
    expect(routeTree).toContain("'/$agentId/groups/$groupId'");
    expect(routeTree).toContain("'/$agentId/settings/tokens/'");
    expect(readFileSync(
      join(import.meta.dir, "../src/app/settings/tokens.tsx"),
      "utf-8",
    )).toContain('createFileRoute("/$agentId/settings/tokens/")');
    const groupRoute = readFileSync(
      join(import.meta.dir, "../src/app/groups/$groupId.tsx"),
      "utf-8",
    );
    expect(groupRoute).toContain('createFileRoute("/$agentId/groups/$groupId")');
    expect(routeTree).not.toContain("'/legacy-plugin/'");
    expect(routeTree).not.toContain("'/principals/'");
  });

  test("Marketplace dashboard surfaces load errors instead of an empty registry", async () => {
    const { PluginsDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginsDashboard, {
        error: new Error("unauthorized"),
        plugins: [],
      }),
    );

    expect(html).toContain("Failed to load plugins: unauthorized");
    expect(html).not.toContain("No marketplace plugins indexed.");
  });

  test("Marketplace dashboard renders marketplace plugins and refresh action", async () => {
    const { PluginsDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginsDashboard, {
        plugins: [
          {
            id: "echo",
            displayName: "Echo",
            source: "marketplace",
            status: "enabled",
            latestVersion: "0.2.0",
            latestRelease: {
              id: "trusted:echo:0.2.0",
              marketplaceId: "trusted",
              pluginId: "echo",
              version: "0.2.0",
              releasePath: "plugins/echo/release/0.2.0",
              manifestSha256: "a2",
              pluginJsSha256: "b2",
              releaseSha256: "c2",
              lunaApiVersion: "^0.1.0",
              validationStatus: "valid",
              discoveredAt: now,
            },
            installation: null,
            latestLoadError: null,
          },
        ],
        onRefreshMarketplace: () => undefined,
      }),
    );

    expect(html).toContain("Plugins");
    expect(html).toContain("Echo");
    expect(html).toContain("0.2.0");
    expect(html).not.toContain("plugins/echo/release/0.1.0");
    expect(html).not.toContain("Available Plugins");
    expect(html).not.toContain("Marketplace Releases");
    expect(html).toContain("Refresh");
  });

  test("Marketplace dashboard omits duplicated plugin contribution metrics", async () => {
    const { PluginsDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginsDashboard, {
        plugins: [
          {
            id: "echo",
            displayName: "Echo",
            source: "marketplace",
            status: "enabled",
            latestVersion: "0.1.0",
            latestRelease: {
              id: "trusted:echo:0.1.0",
              marketplaceId: "trusted",
              pluginId: "echo",
              version: "0.1.0",
              releasePath: "plugins/echo/release/0.1.0",
              manifestSha256: "a",
              pluginJsSha256: "b",
              releaseSha256: "c",
              lunaApiVersion: "^0.1.0",
              validationStatus: "valid",
              discoveredAt: now,
            },
            installation: null,
            latestLoadError: null,
          },
        ],
      }),
    );

    expect(html).toContain("Echo");
    expect(html).not.toContain(
      'class="grid grid-cols-4 gap-2 text-center text-xs"',
    );
  });

  test("Marketplace dashboard enables a marketplace plugin and shows pending restart", async () => {
    const { PluginsDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginsDashboard, {
        plugins: [
          {
            id: "echo",
            displayName: "echo",
            source: "marketplace",
            latestVersion: "0.1.0",
            status: "enabled",
            latestRelease: {
              id: "trusted:echo:0.1.0",
              marketplaceId: "trusted",
              pluginId: "echo",
              version: "0.1.0",
              releasePath: "plugins/echo/release/0.1.0",
              manifestSha256: "a",
              pluginJsSha256: "b",
              releaseSha256: "c",
              lunaApiVersion: "^0.1.0",
              validationStatus: "valid",
              discoveredAt: now,
            },
            installation: {
              pluginId: "echo",
              desiredState: "enabled",
              desiredVersion: "0.1.0",
              desiredReleaseSha256: "c",
              desiredInstalledPath: "/tmp/echo",
              activeState: "disabled",
              pendingAction: "enable",
            },
            latestLoadError: null,
          },
        ],
      }),
    );

    expect(html).toContain("enable pending restart");
    expect(html).toContain("Disable");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Disabled");
    expect(html).toContain('aria-label="Search plugins"');
    expect(html).not.toContain("plugins/echo/release/0.1.0");
  });

  test("Marketplace dashboard links marketplace-only plugins to detail", async () => {
    const { PluginsDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginsDashboard, {
        plugins: [
          {
            id: "echo",
            displayName: "echo",
            source: "marketplace",
            latestVersion: "0.1.0",
            status: "disabled",
            latestRelease: {
              id: "trusted:echo:0.1.0",
              marketplaceId: "trusted",
              pluginId: "echo",
              version: "0.1.0",
              releasePath: "plugins/echo/release/0.1.0",
              manifestSha256: "a",
              pluginJsSha256: "b",
              releaseSha256: "c",
              lunaApiVersion: "^0.1.0",
              validationStatus: "valid",
              discoveredAt: now,
            },
            installation: null,
            latestLoadError: null,
          },
        ],
      }),
    );

    expect(html).toContain("Details");
    expect(html).toContain("/platform/plugins/echo");
  });

  test("Marketplace dashboard renders the latest version action for each plugin", async () => {
    const { PluginsDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const baseRelease = {
      marketplaceId: "trusted",
      pluginId: "echo",
      releasePath: "plugins/echo/release",
      manifestSha256: "a",
      pluginJsSha256: "b",
      releaseSha256: "c",
      lunaApiVersion: "^0.1.0",
      validationStatus: "valid" as const,
      discoveredAt: now,
    };
    const html = renderToStaticMarkup(
      createElement(PluginsDashboard, {
        plugins: [
          {
            id: "echo",
            displayName: "echo",
            source: "marketplace",
            latestVersion: "0.3.0",
            status: "enabled",
            latestRelease: {
              ...baseRelease,
              id: "trusted:echo:0.3.0",
              version: "0.3.0",
            },
            installation: {
              pluginId: "echo",
              desiredState: "enabled",
              desiredVersion: "0.2.0",
              desiredReleaseSha256: "d",
              desiredInstalledPath: "/tmp/echo-0.2.0",
              activeState: "enabled",
              activeVersion: "0.2.0",
              pendingAction: "none",
            },
            latestLoadError: null,
          },
        ],
        onRollbackPlugin: () => undefined,
        onUpgradePlugin: () => undefined,
      }),
    );

    expect(html).toContain("Upgrade");
    expect(html).not.toContain("Rollback");
  });

  test("Marketplace dashboard renders invalid and incompatible release states", async () => {
    const { PluginsDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginsDashboard, {
        plugins: [
          {
            id: "bad",
            displayName: "bad",
            source: "marketplace",
            latestVersion: "0.1.0",
            status: "disabled",
            latestRelease: {
              id: "trusted:bad:0.1.0",
              marketplaceId: "trusted",
              pluginId: "bad",
              version: "0.1.0",
              releasePath: "plugins/bad/release/0.1.0",
              manifestSha256: "a",
              pluginJsSha256: "b",
              releaseSha256: "c",
              lunaApiVersion: "^9.0.0",
              validationStatus: "invalid",
              validationError: "incompatible Luna API",
              discoveredAt: now,
            },
            installation: null,
            latestLoadError: null,
          },
        ],
      }),
    );

    expect(html).toContain("invalid");
    expect(html).toContain("incompatible Luna API");
  });

  test("Plugin detail renders active desired and marketplace version state", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginDetailDashboard, {
        plugin: {
          id: "echo",
          displayName: "Echo",
          version: "0.1.0",
          source: "marketplace",
          status: "enabled",
          requestedHostPermissions: [],
          operations: [
            {
              id: "echo.old",
              title: "Old Echo",
              description: "old operation",
            },
          ],
          commands: [],
          tools: [],
          skills: [],
          installation: {
            pluginId: "echo",
            desiredState: "enabled",
            desiredVersion: "0.1.0",
            activeState: "disabled",
            pendingAction: "enable",
          },
          marketplaceVersions: [
            {
              id: "trusted:echo:0.1.0",
              marketplaceId: "trusted",
              pluginId: "echo",
              version: "0.1.0",
              releasePath: "plugins/echo/release/0.1.0",
              manifestSha256: "a",
              pluginJsSha256: "b",
              releaseSha256: "c",
              lunaApiVersion: "^0.1.0",
              validationStatus: "valid",
              discoveredAt: now,
              manifest: {
                id: "echo",
                displayName: "Echo",
                version: "0.1.0",
                source: "marketplace",
                requestedHostPermissions: [],
                operations: [
                  {
                    id: "echo.old",
                    title: "Old Echo",
                    description: "old operation",
                  },
                ],
                commands: [],
                tools: [],
                skills: [],
              },
            },
            {
              id: "trusted:echo:0.2.0",
              marketplaceId: "trusted",
              pluginId: "echo",
              version: "0.2.0",
              releasePath: "plugins/echo/release/0.2.0",
              manifestSha256: "a2",
              pluginJsSha256: "b2",
              releaseSha256: "c2",
              lunaApiVersion: "^0.1.0",
              validationStatus: "valid",
              discoveredAt: now,
              manifest: {
                id: "echo",
                displayName: "Echo",
                version: "0.2.0",
                source: "marketplace",
                requestedHostPermissions: [],
                operations: [
                  {
                    id: "echo.new",
                    title: "New Echo",
                    description: "new operation",
                  },
                ],
                commands: [
                  {
                    path: ["echo", "new"],
                    operationId: "echo.new",
                  },
                ],
                tools: [],
                skills: [],
              },
            },
          ],
        },
      }),
    );

    expect(html).toContain("desired enabled 0.1.0");
    expect(html).toContain("active disabled");
    expect(html).toContain("Versions");
    expect(html).toContain("0.2.0");
    expect(html).toContain("New Echo");
    expect(html).not.toContain("Old Echo");
  });

  test("Plugin detail switches contribution details when a version is selected", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const view = await renderInteractivePluginDetail(
      createElement(PluginDetailDashboard, {
        plugin: pluginDetailWithVersions(),
      }),
    );

    expect(view.text()).toContain("New Echo");
    expect(view.text()).not.toContain("Old Echo");

    await view.click('[data-testid="plugin-version-0.1.0"]');

    expect(view.text()).toContain("Old Echo");
    expect(view.text()).not.toContain("New Echo");
    view.cleanup();
  });

  test("Plugin detail keeps the entity header stable when switching versions", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const view = await renderInteractivePluginDetail(
      createElement(PluginDetailDashboard, {
        plugin: pluginDetailWithVersions(),
      }),
    );

    expect(view.text()).toContain("Echo");
    expect(view.text()).toContain("echo");
    expect(view.text()).toContain("active 0.1.0");
    expect(view.text()).toContain("latest 0.2.0");
    expect(view.text()).toContain("New Echo");

    await view.click('[data-testid="plugin-version-0.1.0"]');

    expect(view.text()).toContain("Echo");
    expect(view.text()).toContain("echo");
    expect(view.text()).toContain("active 0.1.0");
    expect(view.text()).toContain("latest 0.2.0");
    expect(view.text()).toContain("Old Echo");
    expect(view.text()).not.toContain("New Echo");
    view.cleanup();
  });

  test("Plugin detail renders the version strip horizontally with installation state nearby", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginDetailDashboard, {
        plugin: pluginDetailWithVersions(),
      }),
    );

    expect(html).toContain('data-testid="plugin-version-strip"');
    expect(html).toContain('data-testid="plugin-version-0.2.0"');
    expect(html).toContain('data-testid="plugin-version-0.1.0"');
    expect(html).toContain("Viewing version");
    expect(html).toContain("desired enabled 0.1.0");
    expect(html).toContain("active enabled 0.1.0");
  });

  test("Plugin detail version tags render only version labels", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const view = await renderInteractivePluginDetail(
      createElement(PluginDetailDashboard, {
        plugin: pluginDetailWithVersions(),
      }),
    );

    expect(view.query('[data-testid="plugin-version-0.2.0"]')?.textContent)
      .toBe("0.2.0");
    expect(view.query('[data-testid="plugin-version-0.1.0"]')?.textContent)
      .toBe("0.1.0");

    await view.click('[data-testid="plugin-version-0.1.0"]');

    expect(view.query('[data-testid="plugin-version-0.2.0"]')?.textContent)
      .toBe("0.2.0");
    expect(view.query('[data-testid="plugin-version-0.1.0"]')?.textContent)
      .toBe("0.1.0");
    view.cleanup();
  });

  test("Plugin detail derives upgrade rollback enable and disable actions from selected version", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const view = await renderInteractivePluginDetail(
      createElement(PluginDetailDashboard, {
        plugin: pluginDetailWithVersions(),
        onDisablePlugin: () => undefined,
        onEnablePlugin: () => undefined,
        onRollbackPlugin: () => undefined,
        onUpgradePlugin: () => undefined,
      }),
    );

    expect(view.text()).toContain("Upgrade to this version");

    await view.click('[data-testid="plugin-version-0.1.0"]');

    expect(view.text()).toContain("Disable");
    expect(view.text()).not.toContain("Upgrade to this version");
    view.cleanup();
  });

  test("Plugin detail disables selected version actions for invalid releases", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const invalidPlugin = {
      ...pluginDetailWithVersions(),
      marketplaceVersions: [
        {
          id: "trusted:echo:9.0.0",
          marketplaceId: "trusted",
          pluginId: "echo",
          version: "9.0.0",
          releasePath: "plugins/echo/release/9.0.0",
          manifestSha256: "bad",
          pluginJsSha256: "bad",
          releaseSha256: "bad",
          lunaApiVersion: "^9.0.0",
          validationStatus: "invalid" as const,
          validationError: "incompatible Luna API",
          discoveredAt: now,
        },
        ...pluginDetailWithVersions().marketplaceVersions!,
      ],
    };
    const html = renderToStaticMarkup(
      createElement(PluginDetailDashboard, {
        plugin: invalidPlugin,
        onUpgradePlugin: () => undefined,
      }),
    );

    expect(html).toContain("incompatible Luna API");
    expect(html).toContain("disabled");
  });

  test("Plugin detail renders contribution tabs instead of four stacked sections", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginDetailDashboard, {
        plugin: pluginDetailWithVersions(),
      }),
    );

    expect(html).toContain('data-testid="plugin-tab-operations"');
    expect(html).toContain('data-testid="plugin-tab-commands"');
    expect(html).toContain("New Echo");
    expect(html).not.toContain("No runner tools contributed.");
    expect(html).not.toContain("No skills contributed.");
  });

  test("Plugin detail omits the duplicated selected version metrics block", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(PluginDetailDashboard, {
        plugin: pluginDetailWithVersions(),
      }),
    );

    expect(html).not.toContain(
      'class="border-b px-5 py-4"><div class="grid grid-cols-4 gap-2 text-center text-xs"',
    );
  });

  test("Plugin detail keeps selected tab while switching versions", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const view = await renderInteractivePluginDetail(
      createElement(PluginDetailDashboard, {
        plugin: pluginDetailWithVersions(),
      }),
    );

    await view.click('[data-testid="plugin-tab-commands"]');
    expect(view.text()).toContain("echo new");

    await view.click('[data-testid="plugin-version-0.1.0"]');
    expect(view.text()).toContain("No commands contributed.");
    expect(view.text()).not.toContain("Old Echo");
    view.cleanup();
  });

  test("Plugin detail shows a no manifest message instead of active contributions", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const plugin = {
      ...pluginDetailWithVersions(),
      marketplaceVersions: [
        {
          id: "trusted:echo:0.3.0",
          marketplaceId: "trusted",
          pluginId: "echo",
          version: "0.3.0",
          releasePath: "plugins/echo/release/0.3.0",
          manifestSha256: "a3",
          pluginJsSha256: "b3",
          releaseSha256: "c3",
          lunaApiVersion: "^0.1.0",
          validationStatus: "valid" as const,
          discoveredAt: now,
        },
        ...pluginDetailWithVersions().marketplaceVersions!,
      ],
    };
    const html = renderToStaticMarkup(
      createElement(PluginDetailDashboard, {
        plugin,
      }),
    );

    expect(html).toContain("No manifest details available for this version.");
    expect(html).not.toContain("Old Echo");
    expect(html).not.toContain("New Echo");
  });

  test("Plugin detail renders selected version permissions without plugin-level installation", async () => {
    const { PluginDetailDashboard } = await import(
      "../src/app/plugins/plugins-dashboard"
    );
    const plugin = pluginDetailWithVersions();
    const html = renderToStaticMarkup(
      createElement(PluginDetailDashboard, {
        plugin: {
          ...plugin,
          recentAudits: [
            {
              id: "audit-plugin-1",
              operationId: "echo.new",
              providerType: "plugin",
              pluginId: "echo",
              source: "dashboard",
              status: "success",
            },
          ],
          marketplaceVersions: plugin.marketplaceVersions?.map((release) =>
            release.version === "0.2.0" && release.manifest !== undefined
              ? {
                ...release,
                manifest: {
                  ...release.manifest,
                  requestedHostPermissions: ["network.internal"],
                },
              }
              : release
          ),
        },
      }),
    );

    expect(html).toContain("Selected version permissions");
    expect(html).toContain("Host permissions");
    expect(html).toContain("network.internal");
    expect(html).not.toContain("Installation");
    expect(html).not.toContain("desired:");
    expect(html).not.toContain("active:");
    expect(html).not.toContain("pending:");
    expect(html).not.toContain("Recent Invocations");
    expect(html).not.toContain("audit-plugin-1");
    expect(html).not.toContain("echo.new");
  });

  test("Knowledge dashboard renders a managed workspace browser", async () => {
    const { KnowledgeDashboardForTest } = await import(
      "../src/app/knowledge/knowledge-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(KnowledgeDashboardForTest, {
        entries: [
          {
            path: "wiki/secure.md",
            sizeBytes: 128,
            modifiedAt: "2026-06-23T00:00:00.000Z",
            kind: "markdown",
          },
          {
            path: "archive/seed.md",
            sizeBytes: 64,
            modifiedAt: "2026-06-23T00:00:00.000Z",
            kind: "markdown",
          },
        ],
        grepMatches: [
          {
            path: "wiki/secure.md",
            line: 3,
            column: 1,
            text: "Playback body",
          },
        ],
        selectedFile: {
          workspaceId: "knowledge",
          path: "wiki/secure.md",
          sizeBytes: 128,
          modifiedAt: "2026-06-23T00:00:00.000Z",
          kind: "markdown",
          content: "# Secure Playback\n\nPlayback body\n",
        },
        gitStatus: {
          workspaceId: "knowledge",
          clean: false,
          entries: [
            {
              path: "knowledge/wiki/secure.md",
              status: "M",
            },
          ],
        },
        gitDiff: "diff --git a/knowledge/wiki/secure.md b/knowledge/wiki/secure.md",
      }),
    );

    expect(html).toContain("Workspace browser");
    expect(html).toContain("wiki");
    expect(html).toContain("Secure Playback");
    expect(html).toContain("archive/seed.md");
    expect(html).toContain("Playback body");
    expect(html).toContain("Line 3");
    expect(html).toContain("Copy path");
    expect(html).toContain("Copy full text");
    expect(html).toContain("Git status");
    expect(html).toContain("knowledge/wiki/secure.md");
    expect(html).toContain("Git diff");
  });

  test("Knowledge search filters Chinese filenames and reports pending and failed searches", async () => {
    const { KnowledgeDashboardForTest } = await import("../src/app/knowledge/knowledge-dashboard");
    const props = { entries: [
      {path: "wiki/中文检索.md", sizeBytes: 10, modifiedAt: "", kind: "markdown" as const},
      {path: "other.md", sizeBytes: 10, modifiedAt: "", kind: "markdown" as const},
    ], grepMatches: [], query: "中文" };
    const html = renderToStaticMarkup(createElement(KnowledgeDashboardForTest, props));
    expect(html).toContain("中文检索.md");
    expect(html).not.toContain("other.md");
    expect(html).toContain('type="submit"');
    expect(renderToStaticMarkup(createElement(KnowledgeDashboardForTest, {...props, searching: true}))).toContain("Searching…");
    expect(renderToStaticMarkup(createElement(KnowledgeDashboardForTest, {...props, searchError: "Request denied"}))).toContain("Search failed: Request denied");
  });

  test("Groups dashboard renders directory summaries and dialog entry points", async () => {
    const { GroupsDashboardForTest } = await import(
      "../src/app/groups/groups-dashboard"
    );
    const html = renderToStaticMarkup(
      createElement(GroupsDashboardForTest, {
        groups: [
          {
            id: "playback-oncall",
            slug: "playback-oncall",
            displayName: "Playback Oncall",
            description: "Playback escalation group",
            avatarUrl: null,
            status: "active",
            memberCount: 1,
            createdAt: String(now),
            updatedAt: String(now),
            members: [
              {
                id: "member-user-1",
                groupId: "playback-oncall",
                userId: "user_1",
                role: "member",
                createdAt: String(now),
                updatedAt: String(now),
                displayName: "Contributor",
                avatarUrl: null,
                status: "active",
              },
            ],
            directGrants: [
              { matchType: "exact",
                id: "grant-group-1",
                subjectType: "group",
                subjectId: "playback-oncall",
                target: "media.playback.trace.query",
                effect: "allow",
                createdAt: String(now),
                updatedAt: String(now),
              },
            ],
          },
        ],
      }),
    );

    expect(html).toContain("Group directory");
    expect(html).toContain("Playback Oncall");
    expect(html).toContain('/agent/groups/playback-oncall');
    expect(html).toContain("playback-oncall");
    expect(html).toContain("Playback escalation group");
    expect(html).toContain("1 member");
    expect(html).toContain("1 direct grant");
    expect(html).toContain("Create group");
    expect(html).not.toContain("Assign membership");
    expect(html).not.toContain("Add authorization rule");
    expect(html).not.toContain("Member user");
    expect(html).not.toContain("Search users");
    expect(html).not.toContain('data-testid="operation-picker"');
    expect(html).not.toContain("Search operations");
    expect(html).not.toContain("Principal");
    expect(html).not.toContain("<table");
  });

  test("Group detail renders overview members permissions and dialog actions", async () => {
    const { GroupProfileForTest } = await import(
      "../src/app/groups/group-profile"
    );
    const group: DashboardGroup = {
      id: "playback-oncall",
      slug: "playback-oncall",
      displayName: "Playback Oncall",
      description: "Playback escalation group",
      avatarUrl: null,
      status: "active",
      memberCount: 1,
      createdAt: String(now),
      updatedAt: String(now),
      members: [
        {
          id: "member-user-1",
          groupId: "playback-oncall",
          userId: "user_1",
          role: "member",
          createdAt: String(now),
          updatedAt: String(now),
          displayName: "Contributor",
          avatarUrl: null,
          status: "active",
        },
      ],
      directGrants: [
        { matchType: "exact",
          id: "grant-group-1",
          subjectType: "group",
          subjectId: "playback-oncall",
          target: "media.playback.trace.query",
          effect: "allow",
          createdAt: String(now),
          updatedAt: String(now),
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(GroupProfileForTest, {
        operations: [
          {
            id: "media.playback.trace.query",
            namespace: "media",
            operationKind: "read",
            riskLevel: "low",
            defaultDecision: "deny",
            allowedSubjectTypes: ["user", "group"],
          },
        ],
        group,
        users: [],
      }),
    );

    expect(html).toContain("Playback Oncall");
    expect(html).toContain("Overview");
    expect(html).toContain("Members");
    expect(html).toContain("Permissions");
    expect(html).toContain("Playback escalation group");
    expect(html).toContain("Add member");
    expect(html).toContain("Add authorization rule");
    expect(html).toMatch(
      /data-testid="group-members-section"[\s\S]*Add member[\s\S]*data-relation-kind="group-members"/,
    );
    expect(html).toMatch(
      /data-testid="group-direct-grants-section"[\s\S]*Add authorization rule[\s\S]*data-relation-kind="group-direct-grants"/,
    );
    expect(html).toContain("Contributor");
    expect(html).toContain('/agent/users/user_1');
    expect(html).toContain('aria-label="Remove member Contributor"');
    expect(html).toContain("media.playback.trace.query");
    expect(html).toContain('aria-label="Remove grant media.playback.trace.query"');
    expect(html).toContain("Group members");
    expect(html).toContain('data-testid="relation-card-list"');
    expect(html).toContain('data-relation-kind="group-members"');
    expect(html).toContain('data-relation-kind="group-direct-grants"');
    expect(html).not.toContain("lg:grid-cols-2");
  });

  test("subject picker filters users and groups by query and type", async () => {
    const { filterSubjectsForPicker } = await import(
      "../src/components/subject-picker"
    );
    const subjects: AuthorizationSubjectOption[] = [
      {
        subjectType: "user",
        subjectId: "user_z",
        displayName: "Zoe",
        kind: "human",
        avatarUrl: null,
        status: "active",
        directGrants: [],
      },
      {
        subjectType: "group",
        subjectId: "playback-oncall",
        displayName: "Playback Oncall",
        kind: "group",
        avatarUrl: null,
        status: "active",
        directGrants: [],
      },
      {
        subjectType: "user",
        subjectId: "user_a",
        displayName: "Alice",
        kind: "human",
        avatarUrl: null,
        status: "active",
        directGrants: [],
      },
    ];

    expect(
      filterSubjectsForPicker(subjects, "play", ["group"]).map(
        (subject) => `${subject.subjectType}:${subject.subjectId}`,
      ),
    ).toEqual(["group:playback-oncall"]);
    expect(filterSubjectsForPicker(subjects, "play", ["user"])).toEqual(
      [],
    );
    expect(filterSubjectsForPicker(subjects, "contributor", ["group"])).toEqual(
      [],
    );
    expect(
      filterSubjectsForPicker(subjects, "", undefined, [
        "user:user_z",
        "group:playback-oncall",
      ]).map((subject) => `${subject.subjectType}:${subject.subjectId}`),
    ).toEqual(["user:user_a"]);
    expect(
      filterSubjectsForPicker(subjects, "").map(
        (subject) => `${subject.subjectType}:${subject.subjectId}`,
      ),
    ).toEqual([
      "user:user_z",
      "group:playback-oncall",
      "user:user_a",
    ]);
  });

  test("subject picker renders selected subject as an inline token", async () => {
    const { SubjectPicker, subjectKey } = await import(
      "../src/components/subject-picker"
    );
    const users: DashboardUser[] = [
      {
        id: "user_1",
        kind: "human",
        displayName: "Contributor",
        avatarUrl: "https://example.test/avatar.png",
        status: "active",
        profileSource: "channel",
        linkedIdentities: [
          {
            id: "link_user_1",
            channelIdentityId: "identity_user_1",
            identityNamespace: "lark",
            identityKind: "user_id",
            identityScope: "tenant:tenant_1",
            identityValue: "Example Contributor",
            confidence: "verified",
            isPrimary: true,
            createdAt: "2026-05-30T10:00:00.000Z",
            updatedAt: "2026-05-30T10:00:00.000Z",
            channelIdentity: {
              id: "identity_user_1",
              channelType: "lark",
              channelId: "tenant_1",
              externalId: "ou_1",
              identityKind: "user",
              displayName: "Contributor",
              avatarUrl: "https://example.test/avatar.png",
            },
          },
        ],
        messageCount: 0,
        sessionCount: 0,
        latestSessionId: null,
        latestSessionTitle: null,
        groups: [],
        directGrants: [],
        indirectGrants: [],
      },
    ];

    const html = renderToStaticMarkup(
      createElement(SubjectPicker, {
        label: "Review 人",
        onSelectedSubjectKeyChange: () => {},
        users,
        groups: [],
        selectedSubjectKey: subjectKey("user", "user_1"),
      }),
    );

    expect(html).toContain('data-testid="single-entity-picker-control"');
    expect(html).toContain('data-testid="single-entity-picker-token"');
    expect(html).toContain('data-testid="single-entity-picker-chevron"');
    expect(html).toContain("ml-auto");
    expect(html).toContain('aria-label="Clear Review 人"');
    expect(html).toContain("Contributor");
    expect(html).toContain("Example Contributor");
    expect(html).not.toContain(">Clear<");
  });

  test("authorization rule dialog supports operation paths and pure matching", async () => {
    const source = await Bun.file(new URL("../src/components/grant-operation-dialog.tsx", import.meta.url)).text();
    expect(source).toContain('aria-label={t("Operation path")}');
    expect(source).toContain('aria-label={t("Match")}');
    expect(source).toContain('value="exact"');
    expect(source).toContain('value="prefix"');
    expect(source).toContain("Deny overrides allow");
    expect(source).not.toContain("inputSchema");
  });

  test("relation cards constrain long metadata inside narrow profile sections", async () => {
    const { RelationCard, RelationCardList } = await import(
      "../src/components/relation-card-list"
    );
    const longProviderValue =
      "feishu/feishu-default · 示例用户 · ou_f487103cd58b2c0871be21a0f6fafb69 · tenant:736588c9260f175d";
    const html = renderToStaticMarkup(
      createElement(RelationCardList, {
        columns: "one",
        emptyText: "No channel accounts.",
        items: [longProviderValue],
        relationKind: "channel-accounts",
        renderItem: (value: unknown) => {
          const metadata = String(value);
          return createElement(
            RelationCard,
            {
              avatarAlt: "Lark",
              fallbackIcon: createElement("span", null, "L"),
              key: "lark",
              subtitle: metadata,
              title: createElement("span", null, "Lark"),
            },
            createElement(
              "div",
              { "data-testid": "long-claim", className: "break-all" },
              metadata,
            ),
          );
        },
      }),
    );

    expect(html).toContain('data-relation-kind="channel-accounts"');
    expect(html).toContain('data-testid="relation-card"');
    expect(html).toContain("min-w-0 max-w-full");
  });

  test("relation card string subtitles expose long metadata through hover copy controls", async () => {
    const { RelationCard } = await import(
      "../src/components/relation-card-list"
    );
    const longMetadata =
      "feishu/feishu-default · 示例用户 · ou_f487103cd58b2c0871be21a0f6fafb69 · tenant:736588c9260f175d";
    const html = renderToStaticMarkup(
      createElement(RelationCard, {
        avatarAlt: "Lark",
        fallbackIcon: createElement("span", null, "L"),
        subtitle: longMetadata,
        title: createElement("span", null, "Lark"),
      }),
    );

    expect(html).toContain('data-testid="inspectable-text-preview"');
    expect(html).toContain('data-testid="inspectable-text-popover"');
    expect(html).toContain("Copy full Metadata");
    expect(html).toContain("...");
    expect(html).toContain(longMetadata);
    expect(html).toContain("data-contained-popover");
  });

  test("Tokens page renders a create-token entry point without scope language", async () => {
    const { AccessTokensView } = await import(
      "../src/app/settings/tokens"
    );
    const tokens = [
      {
        id: "token_1",
        userId: "user_1",
        source: "cli",
        name: "Luna CLI",
        role: "user",
        issuedAt: now,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: now,
        metadata: null,
      },
    ] satisfies DashboardAccessToken[];

    const html = renderToStaticMarkup(
      createElement(AccessTokensView, {
        loading: false,
        onCreate: async () => ({
          accessToken: "luna_test_token",
          expiresAt: now + 7 * 24 * 60 * 60 * 1000,
          token: tokens[0]!,
        }),
        onRevoke: async () => undefined,
        tokens,
      }),
    );

    expect(html).toContain("Create token");
    expect(html).toContain("Runtime permissions come from current user and group grants");
    expect(html).toContain(">Role<");
    expect(html).not.toContain(">Scopes<");
    expect(html).not.toContain("Requested scopes");
    expect(html).not.toContain("Requested targets");
  });

  test("Create token dialog exposes expiry choices and one-time token copy", async () => {
    const { CreateAccessTokenDialog, CreatedTokenResult } = await import(
      "../src/app/settings/tokens"
    );
    const source = readFileSync(
      join(import.meta.dir, "../src/app/settings/tokens.tsx"),
      "utf-8",
    );
    const token = {
      id: "token_1",
      userId: "user_1",
      source: "cli",
      name: "Luna CLI",
      role: "user",
      issuedAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now,
      metadata: null,
    } satisfies DashboardAccessToken;

    const dialogHtml = renderToStaticMarkup(
      createElement(CreateAccessTokenDialog, {
        createdToken: {
          accessToken: "luna_test_token",
          expiresAt: token.expiresAt,
          token,
        },
        creating: false,
        error: null,
        onCreate: async () => ({
          accessToken: "luna_test_token",
          expiresAt: token.expiresAt,
          token,
        }),
      }),
    );
    const resultHtml = renderToStaticMarkup(
      createElement(CreatedTokenResult, {
        result: {
          accessToken: "luna_test_token",
          expiresAt: token.expiresAt,
          token,
        },
      }),
    );

    expect(dialogHtml).toContain("Create token");
    expect(source).toContain("7 days");
    expect(source).toContain("30 days");
    expect(source).toContain("90 days");
    expect(source).toContain("Custom");
    expect(resultHtml).toContain("Copy access token");
    expect(resultHtml).toContain("luna_test_token");
    expect(resultHtml).toContain("Only shown once");
  });

  test("operation picker renders selected operation as an inline token", async () => {
    const { OperationPicker } = await import(
      "../src/components/operation-picker"
    );
    const operations = [
      {
        id: "media.logs.decrypt",
        namespace: "media",
        operationKind: "decrypt",
        riskLevel: "high",
        defaultDecision: "deny",
        allowedSubjectTypes: ["user", "group"],
      },
    ];

    const html = renderToStaticMarkup(
      createElement(OperationPicker, {
        operations,
        label: "Operation",
        onSelectedOperationChange: () => {},
        selectedOperationId: "media.logs.decrypt",
      }),
    );

    expect(html).toContain('data-testid="operation-picker"');
    expect(html).toContain('data-testid="single-entity-picker-control"');
    expect(html).toContain('data-testid="single-entity-picker-token"');
    expect(html).toContain('aria-label="Clear Operation"');
    expect(html).toContain("max-w-full");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("media.logs.decrypt");
    expect(html).toContain("decrypt");
    expect(html).toContain("high");
    expect(html).toContain("deny");
    expect(html).not.toContain("requires_approval");
  });

  test("action dialogs constrain long picker content within the modal", async () => {
    const { OperationMultiPicker } = await import(
      "../src/components/operation-picker"
    );
    const actionDialogSource = readFileSync(
      join(process.cwd(), "apps/dashboard/src/components/action-dialog.tsx"),
      "utf8",
    );
    const operations = [
      {
        id: "media.logs.file_download.with.a.very.long.permission.name",
        namespace: "media",
        operationKind: "download",
        riskLevel: "high",
        defaultDecision: "deny",
        allowedSubjectTypes: ["user", "group"],
      },
    ];
    const html = renderToStaticMarkup(
      createElement(OperationMultiPicker, {
        operations,
        label: "Operation *",
        onSelectedOperationsChange: () => undefined,
        selectedOperationIds: [operations[0]!.id],
      }),
    );

    expect(actionDialogSource).toContain("data-testid=\"action-dialog-content\"");
    expect(actionDialogSource).toContain("min-w-0 overflow-visible sm:max-w-2xl");
    expect(actionDialogSource).toContain("data-testid=\"action-dialog-form\"");
    expect(actionDialogSource).toContain("grid min-w-0 gap-4");
    expect(actionDialogSource).toContain("data-testid=\"action-dialog-body\"");
    expect(actionDialogSource).toContain("grid min-w-0 gap-3");
    expect(html).toContain('data-testid="multi-entity-picker-control"');
    expect(html).toContain("max-w-full");
    expect(html).toContain('data-testid="multi-entity-picker-token"');
    expect(html).toContain(operations[0]!.id);
  });

  test("operation picker filters operation policies by canonical fields", async () => {
    const { filterOperationsForPicker } = await import(
      "../src/components/operation-picker"
    );
    const operations = [
      {
        id: "media.playback.trace.query",
        namespace: "media",
        operationKind: "read",
        riskLevel: "low",
        defaultDecision: "deny",
        allowedSubjectTypes: ["user", "group"],
      },
      {
        id: "custom.tool.read",
        namespace: "internal",
        operationKind: "write",
        riskLevel: "medium",
        defaultDecision: "deny",
        allowedSubjectTypes: ["user", "group"],
      },
      {
        id: "system.admin",
        namespace: "system",
        operationKind: "admin",
        riskLevel: "high",
        defaultDecision: "deny",
        allowedSubjectTypes: ["user"],
      },
    ];

    expect(filterOperationsForPicker(operations, "internal")).toEqual([
      operations[1]!,
    ]);
    expect(filterOperationsForPicker(operations, "admin")).toEqual([
      operations[2]!,
    ]);
    expect(filterOperationsForPicker(operations, "requires")).toEqual([]);
    expect(filterOperationsForPicker(operations, "", [
      "media.playback.trace.query",
      "custom.tool.read",
    ])).toEqual([operations[2]!]);
    expect(filterOperationsForPicker(operations, "")).toEqual([
      operations[0]!,
      operations[1]!,
      operations[2]!,
    ]);
  });

  test("user detail renders profile summary with avatar metadata groups and grants", async () => {
    const user: DashboardUser = {
      id: "user-ou-requester",
      kind: "human",
      displayName: "示例用户",
      avatarUrl: "https://avatar.example/ou_requester.png",
      status: "active",
      profileSource: "channel",
      linkedIdentities: [
        {
          id: "link-user-ou-requester",
          channelIdentityId: "directory-user-requester",
          identityNamespace: "lark",
          identityKind: "open_id",
          identityValue: "ou_requester",
          identityScope: "",
          confidence: "verified",
          isPrimary: true,
          createdAt: String(now),
          updatedAt: String(now),
          channelIdentity: {
            id: "directory-user-requester",
            channelType: "feishu",
            channelId: "chat",
            externalId: "ou_requester",
            identityKind: "user",
            displayName: "示例用户",
            avatarUrl: "https://avatar.example/ou_requester.png",
          },
        },
        {
          id: "link-user-union-requester",
          channelIdentityId: "directory-user-requester",
          identityNamespace: "lark",
          identityKind: "union_id",
          identityValue: "on_requester",
          identityScope: "",
          confidence: "verified",
          isPrimary: false,
          createdAt: String(now),
          updatedAt: String(now),
          channelIdentity: {
            id: "directory-user-requester",
            channelType: "feishu",
            channelId: "chat",
            externalId: "ou_requester",
            identityKind: "user",
            displayName: "示例用户",
            avatarUrl: "https://avatar.example/ou_requester.png",
          },
        },
        {
          id: "link-user-id-requester",
          channelIdentityId: "directory-user-requester",
          identityNamespace: "lark",
          identityKind: "user_id",
          identityValue: "dg_requester",
          identityScope: "tenant:tenant-1",
          confidence: "verified",
          isPrimary: false,
          createdAt: String(now),
          updatedAt: String(now),
          channelIdentity: {
            id: "directory-user-requester",
            channelType: "feishu",
            channelId: "chat",
            externalId: "ou_requester",
            identityKind: "user",
            displayName: "示例用户",
            avatarUrl: "https://avatar.example/ou_requester.png",
          },
        },
      ],
      messageCount: 3,
      sessionCount: 2,
      latestSessionId: "conv-users-secondary-owned",
      latestSessionTitle: "Owned newer activity",
      groups: [
        {
          id: "playback-oncall",
          slug: "playback-oncall",
          displayName: "Playback Oncall",
          avatarUrl: null,
          status: "active",
        },
      ],
      directGrants: [
        { matchType: "exact",
          id: "grant-user-direct",
          subjectType: "user",
          subjectId: "user-ou-requester",
          target: "media.read",
          effect: "allow",
          createdAt: String(now),
          updatedAt: String(now),
        },
      ],
      indirectGrants: [
        { matchType: "exact",
          id: "grant-user-indirect",
          subjectType: "group",
          subjectId: "playback-oncall",
          target: "media.playback.trace.query",
          effect: "allow",
          createdAt: String(now),
          updatedAt: String(now),
          sourceGroup: {
            id: "playback-oncall",
            slug: "playback-oncall",
            displayName: "Playback Oncall",
            avatarUrl: null,
            status: "active",
          },
        },
      ],
    };
    const { UserProfileForTest } = await import(
      "../src/app/users/user-profile"
    );
    const html = renderToStaticMarkup(
      createElement(UserProfileForTest, {
        user,
        groups: [
          {
            id: "playback-oncall",
            slug: "playback-oncall",
            displayName: "Playback Oncall",
            description: null,
            avatarUrl: null,
            status: "active",
            memberCount: 1,
            createdAt: String(now),
            updatedAt: String(now),
            members: [],
            directGrants: [],
          },
        ],
      }),
    );

    expect(html).toContain("https://avatar.example/ou_requester.png");
    expect(html).toContain("示例用户");
    expect(html).toContain("user");
    expect(html).toContain("<span>Luna User ID: user-ou-requester</span>");
    expect(html.match(/user-ou-requester/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("lark:open_id:ou_requester");
    expect(html).toContain("feishu/chat");
    expect(html).toContain("3 messages");
    expect(html).toContain("2 sessions");
    expect(html).toContain("Owned newer activity");
    expect(html).toContain("Identities");
    expect(html).toContain('data-testid="identities-section"');
    expect(html).toContain('data-layout="standalone"');
    expect(html).toContain('data-relation-kind="channel-accounts"');
    expect(html).toContain('data-relation-columns="one"');
    expect(html).toContain('data-testid="channel-account-claims"');
    expect(html).toContain('<details class="space-y-2" data-testid="channel-account-details"');
    expect(html).not.toContain('<details open');
    expect(html).not.toContain("sm:grid-cols-[9rem_1fr]");
    expect(html).toContain("3 claims");
    expect(html).toContain("lark:open_id");
    expect(html).toContain("lark:union_id");
    expect(html).toContain("lark:user_id");
    expect(html).toContain("ou_requester");
    expect(html).toContain("on_requester");
    expect(html).toContain("dg_requester");
    expect(html).toContain("tenant:tenant-1");
    expect(html).toContain("Luna User ID");
    expect(html).toContain("Memberships");
    expect(html).toMatch(
      /data-testid="user-membership-section"[\s\S]*Assign group[\s\S]*data-relation-kind="user-groups"/,
    );
    expect(html).toContain('data-testid="relation-card-list"');
    expect(html).toContain('data-relation-kind="user-groups"');
    expect(html).toContain('aria-label="Remove group Playback Oncall"');
    expect(html).toContain("media.read");
    expect(html).toContain("Playback Oncall");
    expect(html).toContain("media.playback.trace.query");
    expect(html).toContain("Direct grants");
    expect(html).toContain('data-testid="user-direct-grants-section"');
    expect(html).toContain('data-relation-kind="user-direct-grants"');
    expect(html).toContain("Indirect grants");
    expect(html).toContain('data-testid="user-indirect-grants-section"');
    expect(html).toContain('data-relation-kind="user-indirect-grants"');
    expect(html).toContain("via Playback Oncall");
    expect(html).not.toContain('aria-label="Remove grant media.read"');
    expect(html).not.toContain('aria-label="Remove grant media.playback.trace.query"');
    expect(html).toContain("Assign group");
    expect(html).not.toContain('data-testid="user-profile-action-tray"');
    expect(html).not.toContain("Search groups");
    expect(html).not.toContain("Principal ID");
    expect(html).not.toContain("Add authorization rule");
    expect(html).not.toContain("Grant investigation operation");
    expect(html).not.toContain('data-testid="operation-picker"');
    expect(html).not.toContain("Search operations");
  });

  test("user detail membership and grants write to typed group and operation APIs", async () => {
    const groupResponse = await app.fetch(
      new Request("http://luna.test/api/groups", {
        method: "POST",
        headers: {
          cookie: dashboardCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId: fixtureAgentId,
          slug: "dashboard-media-readers",
          displayName: "Dashboard Media Readers",
        }),
      }),
    );
    expect(groupResponse.status).toBe(200);
    const groupBody = (await groupResponse.json()) as { group: { id: string } };
    const otherAgent = new AgentStore(connection.db).create(fixtureOwnerId, {name: "Other Agent"}, "other-group-agent");
    const groupsInAgent = (agentId: string) => getJson<{groups: DashboardGroup[]}>(`/api/groups?agentId=${agentId}`);
    expect((await groupsInAgent(fixtureAgentId)).groups).toContainEqual(expect.objectContaining({id: groupBody.group.id}));
    expect((await groupsInAgent(otherAgent.id)).groups).toEqual([]);
    const groupRules = `/api/groups/${groupBody.group.id}/authorization-rules`;
    const batch = await app.fetch(new Request(fixtureUrl(`${groupRules}/batch`), {
      method: "POST",
      headers: {cookie: dashboardCookie, "content-type": "application/json"},
      body: JSON.stringify({items: [{target: "workspace.knowledge.read", effect: "allow"}]}),
    }));
    expect(batch.status).toBe(200);
    const {grants: groupGrants} = await batch.json() as {grants: Array<{id: string; subjectId: string}>};
    expect(groupGrants[0]?.subjectId).toBe(groupBody.group.id);
    const removedRule = await app.fetch(new Request(fixtureUrl(`${groupRules}/${groupGrants[0]!.id}`), {
      method: "DELETE",
      headers: {cookie: dashboardCookie},
    }));
    expect(removedRule.status).toBe(200);

    const membershipResponse = await app.fetch(
      new Request(
        "http://luna.test/api/users/directory-user-requester/group-memberships",
        {
          method: "POST",
          headers: {
            cookie: dashboardCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            groupId: groupBody.group.id,
            role: "member",
          }),
        },
      ),
    );
    expect(membershipResponse.status).toBe(200);

    const grantResponse = await app.fetch(
      new Request(
        fixtureUrl(`/api/agents/${fixtureAgentId}/authorization-rules`),
        {
          method: "POST",
          headers: {
            cookie: dashboardCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ matchType: "exact",
            subjectType: "user",
            subjectId: "directory-user-requester",
            target: "workspace.knowledge.read",
            effect: "allow",
          }),
        },
      ),
    );
    expect(grantResponse.status).toBe(201);

    const user = await getJson<DashboardUser>(
      `/api/users/directory-user-requester?agentId=${fixtureAgentId}`,
    );
    expect(user.groups.map((group) => group.displayName)).toContain(
      "Dashboard Media Readers",
    );
    const {grants} = await getJson<{grants: DashboardUser["directGrants"]}>(
      `/api/agents/${fixtureAgentId}/authorization-rules`,
    );
    expect(grants).toContainEqual(
      expect.objectContaining({ matchType: "exact",
        subjectType: "user",
        subjectId: "directory-user-requester",
        target: "workspace.knowledge.read",
        effect: "allow",
      }),
    );

    const channelRows = sqlite
      .query(
        "SELECT raw_profile_json FROM channel_identities WHERE id = 'directory-user-requester'",
      )
      .all() as Array<{ raw_profile_json: string }>;
    expect(channelRows[0]?.raw_profile_json).toBe(
      JSON.stringify({ source: "fixture" }),
    );
  });

  test("Agent memory lists entries with their origin for the owner", async () => {
    new AgentMemoryStore(connection.db).add(
      { agentId: fixtureAgentId, kind: "owner", trusted: true, userId: fixtureOwnerUserId(fixtureOwnerId), shadowId: null },
      { type: "feedback", title: "Fixture memory", description: "Fixture description", body: "Fixture body" },
    );
    const memory = await getJson<{ memories: Array<Record<string, unknown>> }>(
      `/api/agents/${fixtureAgentId}/memories`,
    );
    expect(memory.memories).toMatchObject([{ title: "Fixture memory", body: "Fixture body", originKind: "owner", status: "active", revision: 1 }]);
    expect(JSON.stringify(memory)).not.toContain(fixtureHome);
  });

  test("removed usage APIs return 404", async () => {
    for (const path of ["/api/usage/claude", "/api/agent/usage/claude"]) {
      const response = await app.fetch(new Request(`http://luna.test${path}`, {
        headers: { cookie: dashboardCookie },
      }));
      expect(response.status).toBe(404);
    }
  });

  test("/api/sessions/:id/messages returns fixture_messages without raw runner logs", async () => {
    const messages = await getJson<
      Array<{
        id: string;
        role: string;
        content: Array<{ type: string; text: string }>;
        linked_tasks: Array<{ id: string; title: string }>;
        linkedTasks: Array<{ id: string; title: string }>;
      }>
    >("/api/sessions/conv-primary/messages");

    expect(messages.map((message) => message.id)).toEqual([
      "msg-user-1",
      "msg-assistant-1",
      "msg-user-2",
    ]);
    expect(Object.hasOwn(messages[0] ?? {}, "runnerDecisions")).toBe(false);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Playback is failing for EU users" }],
      linked_tasks: [
        { id: "task_1", title: "Playback failure investigation" },
      ],
      linkedTasks: [
        { id: "task_1", title: "Playback failure investigation" },
      ],
    });
    expect(Object.hasOwn(messages[0] ?? {}, senderColumn)).toBe(false);
    expect(Object.hasOwn(messages[0] ?? {}, senderDisplayColumn)).toBe(false);
    expect(Object.hasOwn(messages[0] ?? {}, senderDisplayProperty)).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("RAW_RUNNER_LOG_LINE");
  });

  test("/api/sessions/:id/messages exposes history_backfill ingest metadata", async () => {
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-backfill-1",
        "conv-primary",
        "om_backfill_1",
        "ou_requester",
        "user",
        JSON.stringify([{ type: "text", text: "Imported group history" }]),
        JSON.stringify({
          lunaIngest: {
            mode: "history_backfill",
            source: "group_join_backfill",
            importedAt: 1_720_000_100_000,
            joinEventId: "evt_bot_added_1",
          },
        }),
        now + 4_600,
      ],
    );

    try {
      const messages = await getJson<DashboardSessionMessage[]>(
        "/api/sessions/conv-primary/messages",
      );

      expect(
        messages.find((message) => message.id === "msg-backfill-1"),
      ).toMatchObject({
        ingest: {
          mode: "history_backfill",
          source: "group_join_backfill",
          importedAt: 1_720_000_100_000,
          joinEventId: "evt_bot_added_1",
        },
      });
    } finally {
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", ["msg-backfill-1"]);
    }
  });

  test("/api/sessions keeps old local file paths in previews and messages as text", async () => {
    const messageId = "msg-local-path-preview";
    const imagePath = join(
      fixtureHome,
      "workspace",
      "uploads",
      "images",
      "session.jpeg",
    );
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId,
        "conv-primary",
        "m-local-path-preview",
        "ou_requester",
        "user",
        JSON.stringify([{ type: "text", text: `Screenshot: ${imagePath}` }]),
        JSON.stringify({ text: `Screenshot: ${imagePath}` }),
        now + 4_500,
      ],
    );

    try {
      const [sessions, messages] = await Promise.all([
        getJson<DashboardSession[]>("/api/sessions"),
        getJson<DashboardSessionMessage[]>("/api/sessions/conv-primary/messages"),
      ]);
      const primarySession = sessions.find((session) => session.id === "conv-primary");
      const localPathMessage = messages.find((message) => message.id === messageId);

      expect(JSON.stringify(sessions)).toContain(fixtureHome);
      expect(JSON.stringify(messages)).toContain(fixtureHome);
      expect(primarySession?.latestMessagePreview).toContain(imagePath);
      expect(localPathMessage?.content).toEqual([
        {
          type: "text",
          text: `Screenshot: ${imagePath}`,
        },
      ]);
    } finally {
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", [messageId]);
    }
  });

  test("/api/sessions/:id/messages exposes structured mentions and renders user links", async () => {
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-user-mention",
        "conv-primary",
        "m-mention",
        "ou_requester",
        "user",
        JSON.stringify([{ type: "text", text: "@Monkey King 帮我查广州明天的天气" }]),
        JSON.stringify({ text: "@_user_1 帮我查广州明天的天气" }),
        now + 2_100,
      ],
    );
    sqlite.run(
      `INSERT INTO fixture_message_mentions
        (id, session_id, message_id, mention_key, mention_label, target_identity_id, target_external_id, target_kind, raw_mention_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "mention-luna-bot",
        "conv-primary",
        "msg-user-mention",
        "@_user_1",
        "@Monkey King",
        "directory-identity-luna-bot",
        "ou_luna_bot",
        "bot",
        JSON.stringify({ key: "@_user_1", targetKind: "bot" }),
        now + 2_100,
      ],
    );

    try {
      const messages = await getJson<DashboardSessionMessage[]>(
        "/api/sessions/conv-primary/messages",
      );
      const mentionMessage = messages.find((message) => message.id === "msg-user-mention");
      expect(mentionMessage).toMatchObject({
        mentions: [
          {
            key: "@_user_1",
            label: "@Monkey King",
            targetIdentityId: "directory-identity-luna-bot",
            targetExternalId: "ou_luna_bot",
            targetKind: "bot",
            targetIdentity: {
              id: "directory-identity-luna-bot",
              displayName: "Monkey King",
              externalId: "ou_luna_bot",
              identityKind: "bot",
            },
          },
        ],
      });
      expect(
        Object.hasOwn(mentionMessage?.mentions[0] ?? {}, nestedMentionIdentityProperty),
      ).toBe(true);

      const html = renderToStaticMarkup(
        createElement(SessionDetailView, {
          sessionId: "conv-primary",
          session: {
            id: "conv-primary",
            channel_type: "feishu",
            channelType: "feishu",
            channel_id: "chat",
            group_id: "group-primary",
            thread_id: null,
            root_message_id: null,
            title: "Mention session",
            workerId: "worker-1",
            display_title: "Mention session",
            displayTitle: "Mention session",
            surface: null,
            message_count: 1,
            thread_anchor_preview: null,
            threadAnchorPreview: null,
            latest_message_preview: null,
            latestMessagePreview: null,
            latestSender: null,
            latest_message_at: null,
            latestMessageAt: null,
            linked_tasks: [],
            linkedTasks: [],
            contextPacks: [],
            launchContextPacks: [],
            seedRecords: [],
            created_at: now,
            updated_at: now,
          } as DashboardSession,
          messages: mentionMessage === undefined ? [] : [mentionMessage],
          turns: [],
          loading: false,
          error: null,
          showNotFound: false,

        }),
      );
      expect(html).toContain("@Monkey King");
      expect(html).toContain('title="worker-1"');
      expect(html).toContain("/users/directory-identity-luna-bot");
      expect(html).not.toContain("@_user_1");
    } finally {
      sqlite.run("DELETE FROM fixture_message_mentions WHERE id = ?", [
        "mention-luna-bot",
      ]);
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", ["msg-user-mention"]);
    }
  });

  test("session detail preserves duplicate mention labels as separate identity links", () => {
    const duplicateLabelMessage: DashboardSessionMessage = {
      id: "msg-duplicate-label-mentions",
      session_id: "conv-primary",
      owning_session_id: "conv-primary",
      channel_message_key: "m-duplicate-labels",
      senderUserId: "directory-user-requester",
      senderUser: {
        id: "directory-user-requester",
        kind: "human",
        displayName: "示例用户",
        avatarUrl: null,
        status: "active",
        profileSource: "channel",
      },
      role: "user",
      content: [{ type: "text", text: "@Alex 和 @Alex 都看一下" }],
      mentions: [
        {
          key: "@_user_1",
          label: "@Alex",
          targetIdentityId: "directory-identity-alex-one",
          targetUserId: "directory-user-alex-one",
          targetUser: {
            id: "directory-user-alex-one",
            kind: "human",
            displayName: "Alex Chen",
            avatarUrl: null,
            status: "active",
            profileSource: "directory",
          },
          targetIdentity: {
            id: "directory-identity-alex-one",
            channel: { type: "feishu", id: "chat" },
            externalId: "ou_alex_one",
            identityKind: "user",
            displayName: "Alex Chen",
            avatarUrl: null,
            providerIds: {},
          },
          targetExternalId: "ou_alex_one",
          targetKind: "user",
        },
        {
          key: "@_user_2",
          label: "@Alex",
          targetIdentityId: "directory-identity-alex-two",
          targetUserId: "directory-user-alex-two",
          targetUser: {
            id: "directory-user-alex-two",
            kind: "human",
            displayName: "Alex Li",
            avatarUrl: null,
            status: "active",
            profileSource: "directory",
          },
          targetIdentity: {
            id: "directory-identity-alex-two",
            channel: { type: "feishu", id: "chat" },
            externalId: "ou_alex_two",
            identityKind: "user",
            displayName: "Alex Li",
            avatarUrl: null,
            providerIds: {},
          },
          targetExternalId: "ou_alex_two",
          targetKind: "user",
        },
      ],
      linked_tasks: [],
      linkedTasks: [],
      created_at: now,
    };

    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: {
          id: "conv-primary",
          channel_type: "feishu",
          channelType: "feishu",
          channel_id: "chat",
          group_id: "group-primary",
          thread_id: null,
          root_message_id: null,
          title: "Duplicate label session",
          display_title: "Duplicate label session",
          displayTitle: "Duplicate label session",
          surface: null,
          message_count: 1,
          thread_anchor_preview: null,
          threadAnchorPreview: null,
          latest_message_preview: null,
          latestMessagePreview: null,
          latestSender: null,
          latest_message_at: null,
          latestMessageAt: null,
          linked_tasks: [],
          linkedTasks: [],
          contextPacks: [],
          launchContextPacks: [],
          seedRecords: [],
          created_at: now,
          updated_at: now,
        } as DashboardSession,
        messages: [duplicateLabelMessage],
        turns: [],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );

    expect(html).toContain("/users/directory-user-alex-one");
    expect(html).toContain("/users/directory-user-alex-two");
  });

  test("session detail marks history backfill messages in the timeline", () => {
    const message: DashboardSessionMessage = {
      id: "msg-backfill-1",
      session_id: "conv-primary",
      owning_session_id: "conv-primary",
      channel_message_key: "om_backfill_1",
      senderUserId: "directory-user-requester",
      senderUser: {
        id: "directory-user-requester",
        kind: "human",
        displayName: "示例用户",
        avatarUrl: null,
        status: "active",
        profileSource: "channel",
      },
      role: "user",
      content: [{ type: "text", text: "Imported group history" }],
      mentions: [],
      ingest: {
        mode: "history_backfill",
        source: "group_join_backfill",
        importedAt: 1_720_000_100_000,
        joinEventId: "evt_bot_added_1",
      },
      linked_tasks: [],
      linkedTasks: [],
      created_at: now,
    };

    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: {
          id: "conv-primary",
          channel_type: "feishu",
          channelType: "feishu",
          channel_id: "chat",
          group_id: "group-primary",
          thread_id: null,
          root_message_id: null,
          title: "History import session",
          display_title: "History import session",
          displayTitle: "History import session",
          surface: null,
          message_count: 1,
          thread_anchor_preview: null,
          threadAnchorPreview: null,
          latest_message_preview: null,
          latestMessagePreview: null,
          latestSender: null,
          latest_message_at: null,
          latestMessageAt: null,
          linked_tasks: [],
          linkedTasks: [],
          contextPacks: [],
          launchContextPacks: [],
          seedRecords: [],
          created_at: now,
          updated_at: now,
        } as DashboardSession,
        messages: [message],
        turns: [],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );

    expect(html).toContain("History Import");
    expect(html).toContain("group_join_backfill");
  });

  test("/api/sessions/:id/messages includes projected thread context", async () => {
    const messages = await getJson<DashboardSessionMessage[]>(
      "/api/sessions/conv-secondary/messages",
    );

    expect(messages.map((message) => message.id)).toEqual([
      "msg-user-1",
      "msg-user-2",
    ]);
    expect(messages).toMatchObject([
      {
        projection: {
          source_session_id: "conv-primary",
          relation: "reference",
        },
      },
      {
        projection: {
          source_session_id: "conv-primary",
          relation: "reference",
        },
      },
    ]);
  });

  test("/api/sessions/:id/messages derives senderless assistant messages from channel bot identity", async () => {
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-assistant-senderless",
        "conv-primary",
        "m-senderless-assistant",
        null,
        "assistant",
        JSON.stringify([{ type: "text", text: "收到，继续处理。" }]),
        JSON.stringify({ text: "收到，继续处理。" }),
        now + 2_250,
      ],
    );

    try {
      const messages = await getJson<DashboardSessionMessage[]>(
        "/api/sessions/conv-primary/messages",
      );
      const senderless = messages.find(
        (message) => message.id === "msg-assistant-senderless",
      );

      expect(senderless).toMatchObject({
        role: "assistant",
        senderUserId: "directory-identity-luna-bot",
        senderUser: {
          id: "directory-identity-luna-bot",
          displayName: "Monkey King",
          kind: "bot",
        },
      });
    } finally {
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", [
        "msg-assistant-senderless",
      ]);
    }
  });

  test("/api/sessions/:id/messages marks task final notifications as answer cards", async () => {
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, presentation_kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-final-card-api",
        "conv-primary",
        "m-final-card-api",
        "ou_luna_bot",
        "assistant",
        JSON.stringify([
          {
            type: "text",
            text: "EU edge POPs were timing out; mitigation has completed.",
          },
        ]),
        JSON.stringify({
          origin: "task_final_notification",
          sourceTaskId: "task_1",
        }),
        "task_result_card",
        now + 2_500,
      ],
    );

    try {
      const messages = await getJson<
        Array<
          DashboardSessionMessage & {
            presentation?: {
              kind: string;
              task?: { id: string; title: string };
            };
          }
        >
      >("/api/sessions/conv-primary/messages");
      const finalMessage = messages.find(
        (message) => message.id === "msg-final-card-api",
      );

      expect(finalMessage?.presentation).toEqual({
        kind: "task_final_answer",
        task: {
          id: "task_1",
          title: "Playback failure investigation",
        },
      });
    } finally {
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", [
        "msg-final-card-api",
      ]);
    }
  });

  test("/api/sessions/:id/messages marks status cards as status cards", async () => {
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, presentation_kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-status-card-api",
        "conv-primary",
        "m-status-card-api",
        "ou_luna_bot",
        "assistant",
        JSON.stringify([
          {
            type: "card",
            cardKind: "status_card",
            title: "Playback failure investigation\nEU edge POPs are timing out",
            text: "已收到，正在准备问题。",
            payload: {
              taskId: "task_1",
              status: "new",
            },
          },
        ]),
        JSON.stringify({
          origin: "status_card",
          sourceTaskId: "task_1",
          status: "new",
        }),
        "status_card",
        now + 2_550,
      ],
    );

    try {
      const messages = await getJson<
        Array<
          DashboardSessionMessage & {
            presentation?: {
              kind: string;
              status?: string | null;
              title?: string | null;
              text?: string | null;
              task?: { id: string; title: string } | null;
            };
          }
        >
      >("/api/sessions/conv-primary/messages");
      const statusMessage = messages.find(
        (message) => message.id === "msg-status-card-api",
      );

      expect(statusMessage?.presentation).toEqual({
        kind: "status_card",
        status: "new",
        title: "Playback failure investigation\nEU edge POPs are timing out",
        text: "已收到，正在准备问题。",
        task: {
          id: "task_1",
          title: "Playback failure investigation",
        },
      });
    } finally {
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", [
        "msg-status-card-api",
      ]);
    }
  });

  test("/api/sessions/:id/messages marks provider markdown rich cards", async () => {
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, presentation_kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-feishu-markdown-card-api",
        "conv-primary",
        "m-feishu-markdown-card-api",
        "ou_requester",
        "user",
        JSON.stringify([
          {
            type: "text",
            text: "@示例用户 📍 **广州今日天气**\n- 🌧️ 天气：**大雨**\n\n📎 [中央气象台广州天气](http://m.nmc.cn/publish/forecast/AGD/guangzhou.html)",
          },
        ]),
        JSON.stringify({
          id: "m-feishu-markdown-card-api",
          channel: { type: "feishu", id: "feishu-default" },
          surface: { externalId: "oc_group", kind: "group" },
          sender: { externalId: "ou_requester", kind: "user" },
          text: "@示例用户 📍 **广州今日天气**",
          mentions: [],
          addressing: { addressedToBot: false, reason: "silent_group" },
          presentation: {
            kind: "rich_markdown_card",
          },
        }),
        "provider_rich_card",
        now + 2_600,
      ],
    );
    sqlite.run(
      `INSERT INTO fixture_message_mentions
        (id, session_id, message_id, mention_key, mention_label, target_identity_id, target_external_id, target_kind, raw_mention_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "mention-feishu-markdown-card-api",
        "conv-primary",
        "msg-feishu-markdown-card-api",
        "@_user_1",
        "@示例用户",
        "directory-identity-requester",
        "ou_requester",
        "user",
        JSON.stringify({ key: "@_user_1" }),
        now + 2_600,
      ],
    );

    try {
      const messages = await getJson<
        Array<
          DashboardSessionMessage & {
            presentation?: { kind: string };
          }
        >
      >("/api/sessions/conv-primary/messages");
      const cardMessage = messages.find(
        (message) => message.id === "msg-feishu-markdown-card-api",
      );

      expect(cardMessage?.presentation).toEqual({
        kind: "rich_markdown_card",
      });
      expect(JSON.stringify(cardMessage?.content)).toContain("@示例用户");
      expect(JSON.stringify(cardMessage?.content)).toContain("广州今日天气");
    } finally {
      sqlite.run("DELETE FROM fixture_message_mentions WHERE id = ?", [
        "mention-feishu-markdown-card-api",
      ]);
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", [
        "msg-feishu-markdown-card-api",
      ]);
    }
  });

  test("dashboard sessions and fixture_messages use channel directory names", async () => {
    const sessions = await getJson<Array<DashboardSession & {
      display_title: string;
      displayTitle: string;
      surface: { displayName: string | null } | null;
    }>>("/api/sessions");
    insertFixtureSessions(sqlite, [
      "conv-p2p-directory",
      "feishu:chat:group-p2p",
      "feishu",
      "chat",
      "group-p2p",
      null,
      null,
      null,
      now + 7_000,
      now + 7_000,
    ]);
    sqlite.run(
      `INSERT INTO channel_surfaces
        (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-chat-p2p",
        "feishu",
        "chat",
        "group-p2p",
        "p2p",
        null,
        null,
        JSON.stringify({ providerSurfaceId: "group-p2p" }),
        JSON.stringify({ source: "p2p-fixture" }),
        now + 7_000,
        now + 7_000,
        now + 7_000,
        now + 7_000,
        now + 7_000,
      ],
    );
    sqlite.run(
      `INSERT INTO channel_identities
        (id, channel_type, channel_id, external_id, identity_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-user-p2p",
        "feishu",
        "chat",
        "ou_p2p",
        "user",
        "张三",
        null,
        JSON.stringify({ providerAccountId: "user_p2p" }),
        JSON.stringify({ source: "p2p-fixture" }),
        now + 7_000,
        now + 7_000,
        now + 7_000,
        now + 7_000,
        now + 7_000,
      ],
    );
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-p2p-user",
        "conv-p2p-directory",
        "m-p2p",
        "ou_p2p",
        "user",
        JSON.stringify([{ type: "text", text: "hello" }]),
        JSON.stringify({ text: "hello" }),
        now + 7_000,
      ],
    );

    const sessionsWithP2p = await getJson<Array<DashboardSession & {
      displayTitle: string;
    }>>("/api/sessions");
    expect(
      sessionsWithP2p.find((item) => item.id === "conv-p2p-directory"),
    ).toMatchObject({ displayTitle: "张三" });

    const primary = sessions.find((item) => item.id === "conv-primary");
    expect(primary).toMatchObject({
      display_title: "播放排查群",
      displayTitle: "播放排查群",
      surface: { displayName: "播放排查群" },
    });

    sqlite.run(`DELETE FROM fixture_messages WHERE id = ?`, ["msg-p2p-user"]);
    sqlite.run(`DELETE FROM sessions WHERE id = ?`, ["conv-p2p-directory"]);
    sqlite.run(`DELETE FROM channel_surfaces WHERE id = ?`, ["directory-chat-p2p"]);
    sqlite.run(`DELETE FROM channel_identities WHERE id = ?`, ["directory-user-p2p"]);

    const messages = await getJson<DashboardSessionMessage[]>(
      "/api/sessions/conv-primary/messages",
    );
    expect(messages[0]).toMatchObject({
      senderUser: { displayName: "示例用户", id: "directory-user-requester" },
    });
    expect(messages[0]?.senderUser?.displayName).not.toBe("错误频道用户");

    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: primary,
        messages,
        turns: [],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const renderedText = renderedMarkupText(html);
    expect(renderedText).toContain("播放排查群");
    expect(renderedText).toContain("示例用户");
  });

  test("/api/sessions titles p2p root sessions from projected user messages", async () => {
    try {
      insertFixtureSessions(sqlite, [
        "conv-p2p-root-projected",
        "feishu:chat:group-p2p-projected",
        "feishu",
        "chat",
        "group-p2p-projected",
        null,
        null,
        null,
        now + 8_000,
        now + 8_000,
        "conv-p2p-thread-projected",
        "feishu:chat:group-p2p-projected:thread",
        "feishu",
        "chat",
        "group-p2p-projected",
        "thread-p2p-projected",
        "root-p2p-projected",
        null,
        now + 8_500,
        now + 8_500,
      ]);
      sqlite.run(
        `INSERT INTO channel_surfaces
          (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "directory-chat-p2p-projected",
          "feishu",
          "chat",
          "group-p2p-projected",
          "p2p",
          null,
          null,
          JSON.stringify({ providerSurfaceId: "group-p2p-projected" }),
          JSON.stringify({ source: "p2p-projected-fixture" }),
          now + 8_000,
          now + 8_500,
          now + 8_500,
          now + 8_000,
          now + 8_500,
        ],
      );
      sqlite.run(
        `INSERT INTO fixture_messages
          (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
          VALUES
          (?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "msg-p2p-projected-user",
          "conv-p2p-thread-projected",
          "root-p2p-projected",
          "ou_requester",
          "user",
          JSON.stringify([{ type: "text", text: "今晚会下雨吗" }]),
          JSON.stringify({ text: "今晚会下雨吗" }),
          now + 8_100,
          "msg-p2p-root-marker",
          "conv-p2p-root-projected",
          "main-runner-action:conv-p2p-root-projected:marker:selected",
          null,
          "assistant",
          JSON.stringify([]),
          JSON.stringify({ origin: "main_runner_action_marker" }),
          now + 8_200,
        ],
      );
      sqlite.run(
        `INSERT INTO fixture_message_refs
          (id, session_id, message_id, source_session_id, relation, include_in_context, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          "ref-p2p-projected-user",
          "conv-p2p-root-projected",
          "msg-p2p-projected-user",
          "conv-p2p-thread-projected",
          "thread_anchor",
          1,
          now + 8_300,
        ],
      );

      const sessions = await getJson<Array<DashboardSession & {
        displayTitle: string;
      }>>("/api/sessions");

      expect(
        sessions.find((item) => item.id === "conv-p2p-root-projected"),
      ).toMatchObject({ displayTitle: "示例用户" });
    } finally {
      sqlite.run(`DELETE FROM fixture_message_refs WHERE id = ?`, [
        "ref-p2p-projected-user",
      ]);
      sqlite.run(`DELETE FROM fixture_messages WHERE id IN (?, ?)`, [
        "msg-p2p-projected-user",
        "msg-p2p-root-marker",
      ]);
      sqlite.run(`DELETE FROM sessions WHERE id IN (?, ?)`, [
        "conv-p2p-root-projected",
        "conv-p2p-thread-projected",
      ]);
      sqlite.run(`DELETE FROM channel_surfaces WHERE id = ?`, [
        "directory-chat-p2p-projected",
      ]);
    }
  });

  test("/api/sessions and /api/users derive titles from current directory profiles", async () => {
    try {
      insertFixtureSessions(sqlite, [
        "conv-group-profile-title",
        "feishu:chat:group-profile-title",
        "feishu",
        "chat",
        "group-profile-title",
        null,
        null,
        "Group fallback title should not win",
        now + 14_000,
        now + 14_000,
        "conv-p2p-profile-title",
        "feishu:chat:group-p2p-profile-title",
        "feishu",
        "chat",
        "group-p2p-profile-title",
        null,
        null,
        "P2P fallback title should not win",
        now + 14_500,
        now + 14_500,
      ]);
      sqlite.run(
        `INSERT INTO channel_surfaces
          (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
          VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "directory-chat-group-profile-title",
          "feishu",
          "chat",
          "group-profile-title",
          "group",
          null,
          null,
          JSON.stringify({ providerSurfaceId: "group-profile-title" }),
          JSON.stringify({ name: "群聊初始名" }),
          now + 14_000,
          now + 14_000,
          now + 14_000,
          now + 14_000,
          now + 14_000,
          "directory-chat-p2p-profile-title",
          "feishu",
          "chat",
          "group-p2p-profile-title",
          "p2p",
          null,
          null,
          JSON.stringify({ providerSurfaceId: "group-p2p-profile-title" }),
          JSON.stringify({ source: "p2p-profile-title-fixture" }),
          now + 14_500,
          now + 14_500,
          now + 14_500,
          now + 14_500,
          now + 14_500,
        ],
      );
      sqlite.run(
        `INSERT INTO channel_identities
          (id, channel_type, channel_id, external_id, identity_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
          VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "directory-user-group-profile-sender",
          "feishu",
          "chat",
          "ou_group_profile_sender",
          "user",
          "发送者不应作为群标题",
          null,
          JSON.stringify({ providerAccountId: "user_group_profile_sender" }),
          JSON.stringify({ source: "group-profile-title-fixture" }),
          now + 14_000,
          now + 14_000,
          now + 14_000,
          now + 14_000,
          now + 14_000,
          "directory-user-p2p-profile-title",
          "feishu",
          "chat",
          "ou_p2p_profile_title",
          "user",
          null,
          null,
          JSON.stringify({ providerAccountId: "user_p2p_profile_title" }),
          JSON.stringify({ name: "联系人初始名" }),
          now + 14_500,
          now + 14_500,
          now + 14_500,
          now + 14_500,
          now + 14_500,
        ],
      );
      insertCanonicalUserFixture(sqlite, {
        userId: "directory-user-p2p-profile-title",
        channelIdentityId: "directory-user-p2p-profile-title",
        kind: "human",
        displayName: "联系人初始名",
        avatarUrl: null,
        identityValue: "ou_p2p_profile_title",
        createdAt: now + 14_500,
      });
      sqlite.run(
        `INSERT INTO fixture_messages
          (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
          VALUES
          (?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "msg-group-profile-title",
          "conv-group-profile-title",
          "m-group-profile-title",
          "ou_group_profile_sender",
          "user",
          JSON.stringify([{ type: "text", text: "群聊消息" }]),
          JSON.stringify({ text: "群聊消息" }),
          now + 14_100,
          "msg-p2p-profile-title",
          "conv-p2p-profile-title",
          "m-p2p-profile-title",
          "ou_p2p_profile_title",
          "user",
          JSON.stringify([{ type: "text", text: "单聊消息" }]),
          JSON.stringify({ text: "单聊消息" }),
          now + 14_600,
        ],
      );

      const initialSessions = await getJson<Array<DashboardSession & {
        displayTitle: string;
      }>>("/api/sessions");
      expect(
        initialSessions.find((item) => item.id === "conv-group-profile-title"),
      ).toMatchObject({ displayTitle: "群聊初始名" });
      expect(
        initialSessions.find((item) => item.id === "conv-group-profile-title")
          ?.displayTitle,
      ).not.toBe("发送者不应作为群标题");
      expect(
        initialSessions.find((item) => item.id === "conv-p2p-profile-title"),
      ).toMatchObject({ displayTitle: "联系人初始名" });

      sqlite.run(
        `UPDATE channel_surfaces
          SET display_name = ?, profile_updated_at = ?, updated_at = ?
          WHERE id = ?`,
        [
          "群聊改名后",
          now + 15_000,
          now + 15_000,
          "directory-chat-group-profile-title",
        ],
      );
      sqlite.run(
        `UPDATE channel_identities
          SET display_name = ?, profile_updated_at = ?, updated_at = ?
          WHERE id = ?`,
        [
          "联系人改名后",
          now + 15_000,
          now + 15_000,
          "directory-user-p2p-profile-title",
        ],
      );
      sqlite.run(
        `UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`,
        [
          "联系人改名后",
          String(now + 15_000),
          "directory-user-p2p-profile-title",
        ],
      );

      const updatedSessions = await getJson<Array<DashboardSession & {
        displayTitle: string;
      }>>("/api/sessions");
      expect(
        updatedSessions.find((item) => item.id === "conv-group-profile-title"),
      ).toMatchObject({ displayTitle: "群聊改名后" });
      expect(
        updatedSessions.find((item) => item.id === "conv-p2p-profile-title"),
      ).toMatchObject({ displayTitle: "联系人改名后" });

      const users = await getUsersJson();
      expect(
        users.find((item) => item.id === "directory-user-p2p-profile-title"),
      ).toMatchObject({
        displayName: "联系人改名后",
        latestSessionId: "conv-p2p-profile-title",
        latestSessionTitle: "联系人改名后",
      });
    } finally {
      sqlite.run(`DELETE FROM fixture_messages WHERE id IN (?, ?)`, [
        "msg-group-profile-title",
        "msg-p2p-profile-title",
      ]);
      sqlite.run(`DELETE FROM channel_identities WHERE id IN (?, ?)`, [
        "directory-user-group-profile-sender",
        "directory-user-p2p-profile-title",
      ]);
      sqlite.run(`DELETE FROM user_identity_links WHERE user_id = ?`, [
        "directory-user-p2p-profile-title",
      ]);
      sqlite.run(`DELETE FROM users WHERE id = ?`, [
        "directory-user-p2p-profile-title",
      ]);
      sqlite.run(`DELETE FROM channel_surfaces WHERE id IN (?, ?)`, [
        "directory-chat-group-profile-title",
        "directory-chat-p2p-profile-title",
      ]);
      sqlite.run(`DELETE FROM sessions WHERE id IN (?, ?)`, [
        "conv-group-profile-title",
        "conv-p2p-profile-title",
      ]);
    }
  });

  test("/api/sessions keeps p2p display title when latest user row is a system task result", async () => {
    insertFixtureSessions(sqlite, [
      "conv-p2p-with-task-result",
      "feishu:chat:group-p2p-task:thread-task",
      "feishu",
      "chat",
      "group-p2p-task",
      "thread-task",
      "m-p2p-task-root",
      null,
      now + 8_000,
      now + 11_000,
    ]);
    sqlite.run(
      `INSERT INTO channel_surfaces
        (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-chat-p2p-task",
        "feishu",
        "chat",
        "group-p2p-task",
        "p2p",
        null,
        null,
        JSON.stringify({ providerSurfaceId: "group-p2p-task" }),
        JSON.stringify({ source: "p2p-task-fixture" }),
        now + 8_000,
        now + 11_000,
        now + 11_000,
        now + 8_000,
        now + 11_000,
      ],
    );
    sqlite.run(
      `INSERT INTO channel_identities
        (id, channel_type, channel_id, external_id, identity_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-user-p2p-task",
        "feishu",
        "chat",
        "ou_p2p_task",
        "user",
        "示例用户",
        null,
        JSON.stringify({ providerAccountId: "user_p2p_task" }),
        JSON.stringify({ source: "p2p-task-fixture" }),
        now + 8_000,
        now + 11_000,
        now + 11_000,
        now + 8_000,
        now + 11_000,
      ],
    );
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-p2p-task-root",
        "conv-p2p-with-task-result",
        "m-p2p-task-root",
        "ou_p2p_task",
        "user",
        JSON.stringify([{ type: "text", text: "帮我查个用户反馈问题" }]),
        JSON.stringify({ text: "帮我查个用户反馈问题" }),
        now + 9_000,
        "msg-p2p-task-result",
        "conv-p2p-with-task-result",
        "task-result:task_1:resolved",
        "luna-system",
        "user",
        JSON.stringify([{ type: "text", text: "任务完成" }]),
        JSON.stringify({ origin: "task_result" }),
        now + 10_000,
      ],
    );

    try {
      const sessions = await getJson<Array<DashboardSession & {
        displayTitle: string;
        threadAnchorPreview: string | null;
      }>>("/api/sessions");

      expect(
        sessions.find((item) => item.id === "conv-p2p-with-task-result"),
      ).toMatchObject({
        displayTitle: "示例用户",
        threadAnchorPreview: "帮我查个用户反馈问题",
      });
    } finally {
      sqlite.run(`DELETE FROM fixture_messages WHERE session_id = ?`, [
        "conv-p2p-with-task-result",
      ]);
      sqlite.run(`DELETE FROM channel_identities WHERE id = ?`, [
        "directory-user-p2p-task",
      ]);
      sqlite.run(`DELETE FROM channel_surfaces WHERE id = ?`, [
        "directory-chat-p2p-task",
      ]);
      sqlite.run(`DELETE FROM sessions WHERE id = ?`, [
        "conv-p2p-with-task-result",
      ]);
    }
  });

  test("/api/sessions derives p2p titles from raw chat mode when stored surface kind is stale", async () => {
    insertFixtureSessions(sqlite, [
      "conv-p2p-stale-surface-kind",
      "feishu:chat:stale-p2p",
      "feishu",
      "chat",
      "stale-p2p",
      null,
      null,
      null,
      now + 8_200,
      now + 8_300,
    ]);
    sqlite.run(
      `INSERT INTO channel_surfaces
        (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-chat-stale-p2p",
        "feishu",
        "chat",
        "stale-p2p",
        "group",
        null,
        null,
        JSON.stringify({ tenant_key: "tenant" }),
        JSON.stringify({ chat_mode: "p2p", chat_id: "stale-p2p" }),
        now + 8_200,
        now + 8_300,
        now + 8_300,
        now + 8_200,
        now + 8_300,
      ],
    );
    sqlite.run(
      `INSERT INTO channel_identities
        (id, channel_type, channel_id, external_id, identity_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-user-stale-p2p",
        "feishu",
        "chat",
        "ou_stale_p2p",
        "user",
        "示例用户",
        null,
        JSON.stringify({ open_id: "ou_stale_p2p" }),
        JSON.stringify({ name: "示例用户" }),
        now + 8_200,
        now + 8_300,
        now + 8_300,
        now + 8_200,
        now + 8_300,
      ],
    );
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-stale-p2p",
        "conv-p2p-stale-surface-kind",
        "m-stale-p2p",
        "ou_stale_p2p",
        "user",
        JSON.stringify([{ type: "text", text: "看一下这张图" }]),
        JSON.stringify({ text: "看一下这张图" }),
        now + 8_250,
      ],
    );

    try {
      const sessions = await getJson<Array<DashboardSession & {
        displayTitle: string;
      }>>("/api/sessions");

      expect(
        sessions.find((item) => item.id === "conv-p2p-stale-surface-kind"),
      ).toMatchObject({ displayTitle: "示例用户" });
    } finally {
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", ["msg-stale-p2p"]);
      sqlite.run("DELETE FROM channel_identities WHERE id = ?", [
        "directory-user-stale-p2p",
      ]);
      sqlite.run("DELETE FROM channel_surfaces WHERE id = ?", [
        "directory-chat-stale-p2p",
      ]);
      sqlite.run("DELETE FROM sessions WHERE id = ?", [
        "conv-p2p-stale-surface-kind",
      ]);
    }
  });

  test("/api/users keeps p2p latest session title when latest user row is a system task result", async () => {
    insertFixtureSessions(sqlite, [
      "conv-users-p2p-with-task-result",
      "feishu:chat:group-users-p2p-task-result",
      "feishu",
      "chat",
      "group-users-p2p-task-result",
      null,
      null,
      "P2P users fallback title should not win",
      now + 12_000,
      now + 13_000,
    ]);
    sqlite.run(
      `INSERT INTO channel_surfaces
        (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-chat-users-p2p-task-result",
        "feishu",
        "chat",
        "group-users-p2p-task-result",
        "p2p",
        null,
        null,
        JSON.stringify({ providerSurfaceId: "group-users-p2p-task-result" }),
        JSON.stringify({ source: "users-p2p-task-fixture" }),
        now + 12_000,
        now + 13_000,
        now + 13_000,
        now + 12_000,
        now + 13_000,
      ],
    );
    sqlite.run(
      `INSERT INTO channel_identities
        (id, channel_type, channel_id, external_id, identity_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "directory-user-users-p2p-task-result",
        "feishu",
        "chat",
        "ou_users_p2p_task_result",
        "user",
        "赵六",
        null,
        JSON.stringify({ providerAccountId: "user_users_p2p_task_result" }),
        JSON.stringify({ source: "users-p2p-task-fixture" }),
        now + 12_000,
        now + 13_000,
        now + 13_000,
        now + 12_000,
        now + 13_000,
      ],
    );
    insertCanonicalUserFixture(sqlite, {
      userId: "directory-user-users-p2p-task-result",
      channelIdentityId: "directory-user-users-p2p-task-result",
      kind: "human",
      displayName: "赵六",
      avatarUrl: null,
      identityValue: "ou_users_p2p_task_result",
      createdAt: now + 12_000,
    });
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-users-p2p-task-root",
        "conv-users-p2p-with-task-result",
        "m-users-p2p-task-root",
        "ou_users_p2p_task_result",
        "user",
        JSON.stringify([{ type: "text", text: "帮我查个反馈" }]),
        JSON.stringify({ text: "帮我查个反馈" }),
        now + 12_500,
        "msg-users-p2p-task-result",
        "conv-users-p2p-with-task-result",
        "task-result:task_users_p2p:resolved",
        "luna-system",
        "user",
        JSON.stringify([{ type: "text", text: "任务完成" }]),
        JSON.stringify({ origin: "task_result" }),
        now + 13_000,
      ],
    );

    try {
      const users = await getUsersJson();
      const user = users.find((item) =>
        item.id === "directory-user-users-p2p-task-result"
      );
      expect(user).toMatchObject({
        displayName: "赵六",
        latestSessionId: "conv-users-p2p-with-task-result",
        latestSessionTitle: "赵六",
      });
    } finally {
      sqlite.run(`DELETE FROM fixture_messages WHERE session_id = ?`, [
        "conv-users-p2p-with-task-result",
      ]);
      sqlite.run(`DELETE FROM channel_identities WHERE id = ?`, [
        "directory-user-users-p2p-task-result",
      ]);
      sqlite.run(`DELETE FROM user_identity_links WHERE user_id = ?`, [
        "directory-user-users-p2p-task-result",
      ]);
      sqlite.run(`DELETE FROM users WHERE id = ?`, [
        "directory-user-users-p2p-task-result",
      ]);
      sqlite.run(`DELETE FROM channel_surfaces WHERE id = ?`, [
        "directory-chat-users-p2p-task-result",
      ]);
      sqlite.run(`DELETE FROM sessions WHERE id = ?`, [
        "conv-users-p2p-with-task-result",
      ]);
    }
  });

  test("session detail marks projected fixture_messages as references", async () => {
    const turns = await getJson<DashboardSessionTurnFixture[]>(
      "/api/sessions/conv-secondary/turns",
    );
    const messages = await getJson<DashboardSessionMessage[]>(
      "/api/sessions/conv-secondary/messages",
    );
    const sessions = await getJson<DashboardSession[]>(
      "/api/sessions",
    );
    const session = sessions.find((item) => item.id === "conv-secondary");

    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-secondary",
        session,
        messages,
        turns,
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const renderedText = renderedMarkupText(html);
    const heading = document.querySelector("h1")?.textContent ?? "";

    expect(renderedText).toContain("引用");
    expect(html).toContain("reference");
    expect(heading).toContain(
      "Ops escalation 锚点：Playback is failing for EU users",
    );
    expect(html).toContain("conv-primary");
  });

  test("session detail exposes turn membership without collapsing messages", async () => {
    const turns = await getJson<DashboardSessionTurnFixture[]>(
      "/api/sessions/conv-primary/turns",
    );
    const messages = await getJson<DashboardSessionMessage[]>(
      "/api/sessions/conv-primary/messages",
    );
    const timeline = await getJson<DashboardSessionTimelineItem[]>(
      "/api/sessions/conv-primary/timeline",
    );
    const sessions = await getJson<DashboardSession[]>(
      "/api/sessions",
    );
    const session = sessions.find((item) => item.id === "conv-primary");

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "turn-batch-1",
      status: "completed",
      messageIds: ["msg-user-1", "msg-user-2"],
      latestMessageId: "msg-user-2",
      materializedPrompt: "# Luna Main Runner Turn Input\n\nPlayback is failing for EU users",
      runnerAttempts: [
        {
          id: "attempt-primary-1",
          attemptKind: "primary",
          attemptIndex: 0,
          status: "parse_failed",
          rawOutput: "I created a task for this playback issue.",
          parseErrorJson: expect.objectContaining({
            code: "main_runner.no_json_object",
          }),
        },
        {
          id: "attempt-repair-1",
          attemptKind: "repair",
          attemptIndex: 1,
          status: "parsed",
          repairSourceAttemptId: "attempt-primary-1",
          parsedActionJson: expect.objectContaining({
            action: "create_task_and_dispatch",
          }),
        },
      ],
      startedAt: now + 2_500,
      completedAt: now + 3_500,
      error: null,
    });
    expect(Object.hasOwn(turns[0] ?? {}, turnSenderProperty)).toBe(false);
    expect(turns[0]?.messageIds).toHaveLength(2);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(messages.map((message) => message.id)).toEqual([
      "msg-user-1",
      "msg-assistant-1",
      "msg-user-2",
    ]);
    expect(
      timeline.map((item) =>
        item.type === "turn"
          ? `${item.turn.id}:${item.messages.map((message) => message.id).join(",")}`
          : item.message.id,
      ),
    ).toEqual([
      "turn-batch-1:msg-user-1",
      "msg-assistant-1",
      "turn-batch-1:msg-user-2",
    ]);
    expect(session).toBeDefined();

    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session,
        timeline,
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const renderedText = renderedMarkupText(html);

    expect(renderedText).toContain("turn turn-batch-1");
    expect(renderedText).toContain("prompt");
    expect(renderedText).toContain("Main Runner Attempts");
    expect(renderedText).toContain("Primary Attempt");
    expect(renderedText).toContain("Repair Attempt");
    expect(renderedText).toContain("Parse Error");
    expect(renderedText).toContain("Raw Output");
    expect(renderedText).toContain("create_task_and_dispatch");
    expect(renderedText).not.toContain("request has enough detail");
    expect(renderedText).toContain("Playback is failing for EU users");
    expect(renderedText).toContain("Please include raw logs.");
    expect(renderedText).toContain("示例用户");
    expect(renderedText).toContain("Monkey King");
    const firstMessageTags = Array.from(
      document.querySelectorAll(
        '[data-testid="session-message-msg-user-1"] [data-header-tag="true"]',
      ),
    ).map((node) => ({
      text: node.textContent ?? "",
      visibility: node.getAttribute("data-tag-visibility"),
      title: node.getAttribute("title"),
    }));
    expect(firstMessageTags).toEqual([
      {
        text: "Playback failure investigation",
        visibility: "always",
        title: null,
      },
      {
        text: "entry entry-conv...ssage",
        visibility: "hover",
        title: expect.stringContaining("timeline entry id:"),
      },
    ]);
    const userLinks = Array.from(
      document.querySelectorAll('a[href^="/agent/users/"]'),
    ).map((node) => ({
      text: node.textContent ?? "",
      href: node.getAttribute("href"),
    }));
    expect(userLinks).toContainEqual({
      text: "示例用户",
      href: "/agent/users/directory-user-requester",
    });
    expect(userLinks).toContainEqual({
      text: "Monkey King",
      href: "/agent/users/directory-identity-luna-bot",
    });
  });

  test("session timeline pages backward without losing or splitting turn groups", async () => {
    const path = "/api/sessions/conv-primary/timeline";
    const timeline = await getJson<DashboardSessionTimelineItem[]>(path);
    type Page = { items: DashboardSessionTimelineItem[]; olderCursor: string | null };
    const newest = await getJson<Page>(`${path}?limit=1`);
    expect(newest.items).toEqual(timeline.slice(-1));
    expect(newest.olderCursor).not.toBeNull();

    const query = new URLSearchParams({ limit: "2", before: newest.olderCursor! });
    const older = await getJson<Page>(`${path}?${query}`);
    expect(older.olderCursor).toBeNull();
    expect([...older.items, ...newest.items]).toEqual(timeline);
  });

  test("/api/sessions/:id/timeline includes conversation control events", async () => {
    insertFixtureSessionTimelineEvent(sqlite, {
      id: "event-focus-shift-api",
      sessionId: "conv-primary",
      entryId: "entry-event-focus-shift-api",
      eventType: "conversation_control",
      controlKind: "followup_interrupted",
      reasonKind: "focus_shifted",
      sourceMessageId: "msg-user-2",
      anchorMessageId: "msg-user-1",
      sessionSourceMessageId: "m-1",
      turnId: "turn-batch-1",
      summary:
        "Detected conversation focus shift; current Luna follow-up chain was interrupted.",
      createdAt: now + 3_100,
    });

    try {
      const timeline = await getJson<DashboardSessionTimelineItem[]>(
        "/api/sessions/conv-primary/timeline",
      );
      const event = timeline.find((item) => item.type === "event");

      expect(event).toMatchObject({
        type: "event",
        event: {
          id: "event-focus-shift-api",
          entryId: "entry-event-focus-shift-api",
          eventType: "conversation_control",
          controlKind: "followup_interrupted",
          reasonKind: "focus_shifted",
          sourceMessageId: "msg-user-2",
          anchorMessageId: "msg-user-1",
          sessionSourceMessageId: "m-1",
          turnId: "turn-batch-1",
          summary:
            "Detected conversation focus shift; current Luna follow-up chain was interrupted.",
          createdAt: now + 3_100,
        },
      });
    } finally {
      sqlite.run(`DELETE FROM session_timeline_events WHERE id = ?`, [
        "event-focus-shift-api",
      ]);
    }
  });

  test("/api/sessions/:id/turns tolerates malformed turn message ids", async () => {
    sqlite.run(
      `UPDATE session_turns SET message_ids = ? WHERE id = ?`,
      ["not-json", "turn-batch-1"],
    );

    try {
      const turns = await getJson<DashboardSessionTurnFixture[]>(
        "/api/sessions/conv-primary/turns",
      );
      const turn = turns.find((item) => item.id === "turn-batch-1");

      expect(turn).toMatchObject({
        id: "turn-batch-1",
        messageIds: ["msg-user-1", "msg-user-2"],
      });
    } finally {
      sqlite.run(
        `UPDATE session_turns SET message_ids = ? WHERE id = ?`,
        [JSON.stringify(["msg-user-1", "msg-user-2"]), "turn-batch-1"],
      );
    }
  });

  test("session detail renders messages as lightweight chat rows", async () => {
    const timeline = await getJson<DashboardSessionTimelineItem[]>(
      "/api/sessions/conv-primary/timeline",
    );
    const sessions = await getJson<DashboardSession[]>(
      "/api/sessions",
    );
    const session = sessions.find((item) => item.id === "conv-primary");

    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session,
        timeline,
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const firstMessage = document.querySelector(
      '[data-testid="session-message-msg-user-1"]',
    );

    expect(firstMessage?.getAttribute("data-message-role")).toBe("user");
    expect(firstMessage?.getAttribute("class") ?? "").toContain(
      "grid-cols-[auto_minmax(0,1fr)]",
    );
    expect(firstMessage?.getAttribute("class") ?? "").not.toContain("bg-card");
    expect(firstMessage?.getAttribute("class") ?? "").not.toContain("border");
    expect(firstMessage?.querySelector('[data-testid="message-avatar"]')).not
      .toBeNull();
    expect(firstMessage?.querySelector('[data-testid="message-header"]'))
      .not.toBeNull();
  });

  test("session detail shows the timeline entry id in the header debug control", async () => {
    const messages = await getJson<DashboardSessionMessage[]>(
      "/api/sessions/conv-primary/messages",
    );
    const firstApiMessage = messages.find((item) => item.id === "msg-user-1");
    const sessions = await getJson<DashboardSession[]>("/api/sessions");
    const session = sessions.find((item) => item.id === "conv-primary");

    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session,
        messages,
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const firstMessage = document.querySelector(
      '[data-testid="session-message-msg-user-1"]',
    );
    const debugId = firstMessage?.querySelector(
      '[data-testid="message-debug-id"]',
    );
    const debugButton = debugId?.querySelector("button");

    expect(firstApiMessage?.entryId).toBeDefined();
    expect(firstApiMessage?.entryId).not.toBe(firstApiMessage?.id);
    expect(debugId?.textContent ?? "").toContain("entry entry-conv...ssage");
    expect(debugId?.getAttribute("class") ?? "").not.toContain("ml-auto");
    expect(debugId?.getAttribute("class") ?? "").toContain("opacity-0");
    expect(debugId?.getAttribute("class") ?? "").toContain(
      "group-hover/message:opacity-100",
    );
    expect(debugButton?.getAttribute("aria-label")).toBe(
      `Copy timeline entry id ${firstApiMessage?.entryId}`,
    );
    expect(debugButton?.getAttribute("title") ?? "").toContain(
      `timeline entry id: ${firstApiMessage?.entryId}`,
    );
    expect(debugButton?.getAttribute("title") ?? "").toContain(
      "message id: msg-user-1",
    );
  });

  test("session detail copies both timeline entry id and message id", async () => {
    const messages = await getJson<DashboardSessionMessage[]>(
      "/api/sessions/conv-primary/messages",
    );
    const firstApiMessage = messages.find((item) => item.id === "msg-user-1");
    expect(firstApiMessage?.entryId).toBeDefined();

    let copiedText = "";
    const previousNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copiedText = text;
          },
        },
      },
    });

    const view = await renderInteractiveSessionDetail("conv-primary");
    try {
      await view.click(
        `[aria-label="Copy timeline entry id ${firstApiMessage?.entryId}"]`,
      );

      expect(copiedText).toBe(
        `timeline entry id: ${firstApiMessage?.entryId}\nmessage id: msg-user-1`,
      );
    } finally {
      view.cleanup();
      if (previousNavigator) {
        Object.defineProperty(globalThis, "navigator", previousNavigator);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    }
  });

  test("session detail falls back to legacy copy when Clipboard API is unavailable", async () => {
    const messages = await getJson<DashboardSessionMessage[]>(
      "/api/sessions/conv-primary/messages",
    );
    const firstApiMessage = messages.find((item) => item.id === "msg-user-1");
    expect(firstApiMessage?.entryId).toBeDefined();

    const previousNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    delete (globalThis as { navigator?: unknown }).navigator;

    const view = await renderInteractiveSessionDetail("conv-primary");
    const testDocument = globalThis.document as unknown as TestDocumentNode & {
      execCommand?: (command: string) => boolean;
    };
    let copiedText = "";
    testDocument.execCommand = (command: string) => {
      expect(command).toBe("copy");
      copiedText =
        (testDocument.querySelector("textarea") as { value?: string } | null)
          ?.value ?? "";
      return true;
    };

    try {
      await view.click(
        `[aria-label="Copy timeline entry id ${firstApiMessage?.entryId}"]`,
      );

      expect(copiedText).toBe(
        `timeline entry id: ${firstApiMessage?.entryId}\nmessage id: msg-user-1`,
      );
    } finally {
      delete testDocument.execCommand;
      view.cleanup();
      if (previousNavigator) {
        Object.defineProperty(globalThis, "navigator", previousNavigator);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    }
  });

  test("session detail renders launch context packs with copyable JSON", async () => {
    let copiedText = "";
    const previousNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copiedText = text;
          },
        },
      },
    });

    const view = await renderInteractiveSessionDetail("conv-secondary");
    try {
      const renderedText = view.text();

      expect(renderedText).toContain("Context");
      expect(renderedText).toContain("Launch Context Packs");
      expect(renderedText).toContain("thread_launch");
      expect(renderedText).toContain("session-thread-launch-pack");
      expect(renderedText).toContain("anchor_turn");
      expect(renderedText).toContain("Playback is failing for EU users");
      expect(renderedText).toContain("Seed Records");
      expect(renderedText).toContain("seed-session-thread-launch");

      await view.click(
        '[aria-label="Copy context pack JSON session-thread-launch-pack"]',
      );

      expect(copiedText).toContain("session-thread-launch-pack");
      expect(copiedText).toContain("Playback is failing for EU users");
    } finally {
      view.cleanup();
      if (previousNavigator) {
        Object.defineProperty(globalThis, "navigator", previousNavigator);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    }
  });

  test("session detail renders conversation control events as low-emphasis system items", async () => {
    insertFixtureSessionTimelineEvent(sqlite, {
      id: "event-focus-shift-render",
      sessionId: "conv-primary",
      entryId: "entry-event-focus-shift-render",
      eventType: "conversation_control",
      controlKind: "followup_interrupted",
      reasonKind: "focus_shifted",
      sourceMessageId: "msg-user-2",
      anchorMessageId: "msg-user-1",
      sessionSourceMessageId: "m-1",
      turnId: "turn-batch-1",
      summary:
        "Detected conversation focus shift; current Luna follow-up chain was interrupted.",
      createdAt: now + 3_100,
    });

    const view = await renderInteractiveSessionDetail("conv-primary");
    try {
      const eventNode = view.query(
        '[data-testid="session-event-entry-event-focus-shift-render"]',
      );

      expect(eventNode).not.toBeNull();
      expect(eventNode?.textContent ?? "").toContain(
        "Detected conversation focus shift; current Luna follow-up chain was interrupted.",
      );
      expect(eventNode?.textContent ?? "").toContain("followup_interrupted");
      expect(eventNode?.textContent ?? "").toContain("focus_shifted");
      expect(eventNode?.getAttribute("class") ?? "").toContain("border-dashed");
      expect(eventNode?.getAttribute("class") ?? "").toContain(
        "text-muted-foreground",
      );
    } finally {
      view.cleanup();
      sqlite.run(`DELETE FROM session_timeline_events WHERE id = ?`, [
        "event-focus-shift-render",
      ]);
    }
  });

  test("session detail renders direct image markdown in ordinary messages", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: undefined,
        messages: [
          {
            id: "msg-direct-image",
            session_id: "conv-primary",
            owning_session_id: "conv-primary",
            channel_message_key: "m-direct-image",
            senderUserId: "directory-user-requester",
            senderUser: {
              id: "directory-user-requester",
              kind: "human",
              displayName: "示例用户",
              avatarUrl: "https://avatar.example/requester.png",
            },
            role: "user",
            content: [
              {
                type: "text",
                text: "![image](/api/artifacts/session-direct-image/content?expires=123&sig=abc)\n这个图片",
              },
            ],
            mentions: [],
            linked_tasks: [],
            linkedTasks: [],
            created_at: now,
          } as DashboardSessionMessage,
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const message = document.querySelector(
      '[data-testid="session-message-msg-direct-image"]',
    );
    const previewImage = Array.from(message?.querySelectorAll("img") ?? [])
      .find((node) =>
        node
          .getAttribute("src")
          ?.startsWith("/api/artifacts/session-direct-image/content?expires=")
      );

    expect(previewImage?.getAttribute("alt")).toBe("image");
    expect(previewImage?.getAttribute("src")).toBe(
      "/api/artifacts/session-direct-image/content?expires=123&sig=abc",
    );
    expect(message?.textContent).toContain("这个图片");
  });

  test("session detail renders structured image blocks in ordinary messages", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: undefined,
        messages: [
          {
            id: "msg-structured-image",
            session_id: "conv-primary",
            owning_session_id: "conv-primary",
            channel_message_key: "m-structured-image",
            senderUserId: "directory-user-requester",
            senderUser: {
              id: "directory-user-requester",
              kind: "human",
              displayName: "示例用户",
              avatarUrl: "https://avatar.example/requester.png",
            },
            role: "user",
            contentKind: "mixed",
            presentationKind: "image_gallery",
            content: [
              { type: "text", text: "这个图片" },
              {
                type: "image",
                url: "/api/artifacts/session-structured-image/content?expires=123&sig=abc",
                alt: "image",
                width: 600,
                height: 1200,
              },
            ],
            mentions: [],
            linked_tasks: [],
            linkedTasks: [],
            created_at: now,
          } as DashboardSessionMessage,
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    expect(html).toContain("aspect-ratio:600 / 1200;max-width:160px");
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const message = document.querySelector(
      '[data-testid="session-message-msg-structured-image"]',
    );
    const previewImage = Array.from(message?.querySelectorAll("img") ?? [])
      .find((node) =>
        node
          .getAttribute("src")
          ?.startsWith("/api/artifacts/session-structured-image/content?expires=")
      );

    expect(previewImage?.getAttribute("alt")).toBe("image");
    expect(previewImage?.getAttribute("src")).toBe(
      "/api/artifacts/session-structured-image/content?expires=123&sig=abc",
    );
    expect(message?.textContent).toContain("这个图片");
  });

  test("/api/sessions/:id/messages resolves runner image artifact references", async () => {
    sqlite.run(
      `INSERT INTO fixture_messages
        (id, session_id, channel_message_key, ${senderColumn}, role, content_json, raw_payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-runner-attachment-image",
        "conv-primary",
        "m-runner-attachment-image",
        "ou_requester",
        "assistant",
        JSON.stringify([
          {
            type: "text",
            text: "老大，收到这张图：\n![image](artifact:task-evidence-image)",
          },
        ]),
        JSON.stringify({ origin: "main_runner_action" }),
        now + 4_500,
      ],
    );

    try {
      const messages = await getJson<DashboardSessionMessage[]>(
        "/api/sessions/conv-primary/messages",
      );
      const imageMessage = messages.find(
        (message) => message.id === "msg-runner-attachment-image",
      );
      const imageText = JSON.stringify(imageMessage?.content);

      expect(imageText).toContain(
        "![image](/api/artifacts/task-evidence-image/content?expires=",
      );
      expect(imageText).not.toContain("artifact:");
    } finally {
      sqlite.run("DELETE FROM fixture_messages WHERE id = ?", [
        "msg-runner-attachment-image",
      ]);
    }
  });

  test("session detail keeps reference and task labels in the message header", async () => {
    const messages = await getJson<DashboardSessionMessage[]>(
      "/api/sessions/conv-secondary/messages",
    );
    const sessions = await getJson<DashboardSession[]>(
      "/api/sessions",
    );
    const session = sessions.find((item) => item.id === "conv-secondary");

    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-secondary",
        session,
        messages,
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const projectedMessage = document.querySelector(
      '[data-testid="session-message-msg-user-1"]',
    );
    const header = projectedMessage?.querySelector(
      '[data-testid="message-header"]',
    );

    expect(header?.textContent).toContain("引用");
    expect(header?.textContent).toContain("Playback failure investigation");
    expect(projectedMessage?.querySelector('[data-testid="message-metadata"]'))
      .toBeNull();
  });

  test("session detail renders task final notifications as linked answer cards", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: undefined,
        messages: [
          {
            id: "msg-final-card-ui",
            session_id: "conv-primary",
            owning_session_id: "conv-primary",
            channel_message_key: "m-final-card-ui",
            senderUserId: "directory-identity-luna-bot",
            senderUser: {
              id: "directory-identity-luna-bot",
              kind: "bot",
              displayName: "Monkey King",
              avatarUrl: "https://avatar.example/luna.png",
            },
            role: "assistant",
            content: [
              {
                type: "text",
                text: "EU edge POPs were timing out; mitigation has completed.",
              },
            ],
            mentions: [],
            linked_tasks: [],
            linkedTasks: [],
            presentation: {
              kind: "task_final_answer",
              task: {
                id: "task_1",
                title: "Playback failure investigation",
              },
            },
            created_at: now,
          } as DashboardSessionMessage,
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const finalMessage = document.querySelector(
      '[data-testid="session-message-msg-final-card-ui"]',
    );
    const answerCard = finalMessage?.querySelector(
      '[data-testid="task-final-answer-card"]',
    );
    const taskLink = answerCard?.querySelector("a");

    expect(answerCard).not.toBeNull();
    expect(answerCard?.getAttribute("data-card-kind")).toBe("task_final_answer");
    expect(answerCard?.getAttribute("data-testid")).toBe("task-final-answer-card");
    expect(answerCard?.textContent).toContain("任务结论");
    expect(answerCard?.textContent).toContain(
      "Playback failure investigation",
    );
    expect(answerCard?.textContent).toContain(
      "EU edge POPs were timing out; mitigation has completed.",
    );
    expect(taskLink?.getAttribute("href")).toBe("/agent/tasks/task_1");
  });

  test("session detail renders provider markdown cards in the shared rich card frame", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: undefined,
        messages: [
          {
            id: "msg-feishu-markdown-card-ui",
            session_id: "conv-primary",
            owning_session_id: "conv-primary",
            channel_message_key: "m-feishu-markdown-card-ui",
            senderUserId: "directory-user-requester",
            senderUser: {
              id: "directory-user-requester",
              kind: "human",
              displayName: "示例用户",
              avatarUrl: "https://avatar.example/requester.png",
            },
            role: "user",
            content: [
              {
                type: "text",
                text: "@ou_requester 📍 **广州今日天气**\n- 🌧️ 天气：**大雨**\n\n![image](/api/artifacts/session-topic-image/content?expires=123&sig=abc)\n示例浏览器\n仙逆144集\n\n📎 [中央气象台广州天气](http://m.nmc.cn/publish/forecast/AGD/guangzhou.html)",
              },
            ],
            mentions: [
              {
                key: "@_sender",
                label: "@ou_requester",
                targetIdentityId: "directory-identity-requester",
                targetUserId: "directory-user-requester",
                targetUser: {
                  id: "directory-user-requester",
                  kind: "human",
                  displayName: "示例用户",
                  avatarUrl: "https://avatar.example/requester.png",
                  status: "active",
                  profileSource: "directory",
                },
                targetIdentity: {
                  id: "directory-identity-requester",
                  channel: { type: "feishu", id: "chat" },
                  externalId: "ou_requester",
                  identityKind: "user",
                  displayName: "示例用户",
                  avatarUrl: "https://avatar.example/requester.png",
                  providerIds: {},
                },
                targetExternalId: "ou_requester",
                targetKind: "user",
              },
            ],
            linked_tasks: [],
            linkedTasks: [],
            presentation: {
              kind: "rich_markdown_card",
            },
            created_at: now,
          } as DashboardSessionMessage,
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const message = document.querySelector(
      '[data-testid="session-message-msg-feishu-markdown-card-ui"]',
    );
    const richCard = message?.querySelector('[data-testid="chat-rich-card"]');
    const richCardSectionCount = richCard?.innerHTML.match(
      /data-rich-card-section=/g,
    )?.length ?? 0;
    const mentionLink = richCard?.querySelector("a[href='/agent/users/directory-user-requester']");
    const weatherLink = richCard?.querySelector(
      "a[href='http://m.nmc.cn/publish/forecast/AGD/guangzhou.html']",
    );
    const previewImage = richCard?.querySelector("img");

    expect(richCard).not.toBeNull();
    expect(richCard?.getAttribute("data-card-kind")).toBe(
      "rich_markdown_card",
    );
    expect(richCard?.getAttribute("data-rich-card-layout")).toBe("layered");
    expect(richCardSectionCount).toBeGreaterThanOrEqual(3);
    expect(richCard?.textContent).not.toContain("富文本卡片");
    expect(richCard?.textContent).toContain("广州今日天气");
    expect(richCard?.textContent).toContain("大雨");
    expect(mentionLink?.textContent).toBe("@示例用户");
    expect(weatherLink?.textContent).toBe("中央气象台广州天气");
    expect(previewImage?.getAttribute("alt")).toBe("image");
    expect(previewImage?.getAttribute("src")).toBe(
      "/api/artifacts/session-topic-image/content?expires=123&sig=abc",
    );
    expect(richCard?.innerHTML).toContain("<strong>");
  });

  test("session detail renders status cards without dropping card content", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: undefined,
        messages: [
          {
            id: "msg-status-card-ui",
            session_id: "conv-primary",
            owning_session_id: "conv-primary",
            channel_message_key: "m-status-card-ui",
            senderUserId: "directory-identity-luna-bot",
            senderUser: {
              id: "directory-identity-luna-bot",
              kind: "bot",
              displayName: "Monkey King",
              avatarUrl: null,
              status: "active",
              profileSource: "channel",
            },
            role: "assistant",
            contentKind: "card",
            presentationKind: "status_card",
            content: [
              {
                type: "card",
                cardKind: "status_card",
                title: "图片色情信息判断\n检查用户刚才发送的图片是否包含色情或性暗示信息",
                text:
                  "结论：有黄色信息，依据来自截图缩略图与标题文字。\n\n任务产物：\n- [完整报告](/artifacts/report-artifact/preview?expires=123&sig=abc)",
                steps: ["Started codex runner.", "完成图像内容判断。"],
                payload: {
                  taskId: "task_1",
                  status: "completed",
                },
              },
            ],
            mentions: [],
            linked_tasks: [],
            linkedTasks: [],
            presentation: {
              kind: "status_card",
              status: "completed",
              title: "图片色情信息判断\n检查用户刚才发送的图片是否包含色情或性暗示信息",
              text:
                "结论：有黄色信息，依据来自截图缩略图与标题文字。\n\n任务产物：\n- [完整报告](/artifacts/report-artifact/preview?expires=123&sig=abc)",
              task: {
                id: "task_1",
                title: "图片色情信息判断",
              },
            },
            created_at: now,
          } as unknown as DashboardSessionMessage,
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const message = document.querySelector(
      '[data-testid="session-message-msg-status-card-ui"]',
    );
    const statusCard = message?.querySelector(
      '[data-testid="status-card"]',
    );
    const taskLink = statusCard?.querySelector("a[href='/agent/tasks/task_1']");
    const reportLink = statusCard?.querySelector(
      "a[href='/artifacts/report-artifact/preview?expires=123&sig=abc']",
    );
    const stepPanel = statusCard?.querySelector(
      '[data-testid="status-card-steps"]',
    );
    const cardHtml = statusCard?.innerHTML ?? "";

    expect(statusCard).not.toBeNull();
    expect(statusCard?.getAttribute("data-card-kind")).toBe("status_card");
    expect(statusCard?.textContent).toContain("图片色情信息判断");
    expect(statusCard?.textContent).toContain(
      "检查用户刚才发送的图片是否包含色情或性暗示信息",
    );
    expect(statusCard?.textContent).toContain("结论：有黄色信息");
    expect(statusCard?.textContent).toContain("任务产物：");
    expect(statusCard?.textContent).toContain("completed");
    expect(statusCard?.textContent).toContain("2 steps");
    expect(statusCard?.textContent).toContain("Started codex runner.");
    expect(statusCard?.textContent).toContain("完成图像内容判断。");
    expect(stepPanel).not.toBeNull();
    expect(stepPanel?.hasAttribute("open")).toBe(false);
    expect(cardHtml.indexOf("2 steps")).toBeLessThan(
      cardHtml.indexOf("结论：有黄色信息"),
    );
    expect(taskLink?.textContent).toContain("图片色情信息判断");
    expect(reportLink?.textContent).toBe("完整报告");
  });

  test("session detail keeps running work status cards step-first when body is empty", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: undefined,
        messages: [
          {
            id: "msg-running-work-status-card-ui",
            session_id: "conv-primary",
            owning_session_id: "conv-primary",
            channel_message_key: "m-running-work-status-card-ui",
            senderUserId: "directory-identity-luna-bot",
            senderUser: {
              id: "directory-identity-luna-bot",
              kind: "bot",
              displayName: "Monkey King",
              avatarUrl: null,
              status: "active",
              profileSource: "channel",
            },
            role: "assistant",
            contentKind: "card",
            presentationKind: "status_card",
            content: [
              {
                type: "card",
                cardKind: "status_card",
                title: "工作会话",
                text: "",
                steps: ["工作会话执行已开始。"],
                payload: {
                  status: "in_progress",
                },
              },
            ],
            mentions: [],
            linked_tasks: [],
            linkedTasks: [],
            presentation: {
              kind: "status_card",
              status: "in_progress",
              title: "工作会话",
              text: null,
              task: null,
            },
            created_at: now,
          } as unknown as DashboardSessionMessage,
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const statusCard = document.querySelector(
      '[data-testid="status-card"]',
    );
    const stepPanel = statusCard?.querySelector(
      '[data-testid="status-card-steps"]',
    );

    expect(statusCard?.textContent).toContain("1 step");
    expect(statusCard?.textContent).toContain("工作会话执行已开始。");
    expect(stepPanel?.hasAttribute("open")).toBe(true);
  });

  test("session detail shows real running status card body when data provides one", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: undefined,
        messages: [
          {
            id: "msg-running-status-card-body-ui",
            session_id: "conv-primary",
            owning_session_id: "conv-primary",
            channel_message_key: "m-running-status-card-body-ui",
            senderUserId: "directory-identity-luna-bot",
            senderUser: {
              id: "directory-identity-luna-bot",
              kind: "bot",
              displayName: "Monkey King",
              avatarUrl: null,
              status: "active",
              profileSource: "channel",
            },
            role: "assistant",
            contentKind: "card",
            presentationKind: "status_card",
            content: [
              {
                type: "card",
                cardKind: "status_card",
                title: "运行中任务",
                text: "正在下载依赖，预计还需要一分钟。",
                steps: ["创建运行环境。"],
                payload: {
                  status: "in_progress",
                },
              },
            ],
            mentions: [],
            linked_tasks: [],
            linkedTasks: [],
            presentation: {
              kind: "status_card",
              status: "in_progress",
              title: "运行中任务",
              text: "正在下载依赖，预计还需要一分钟。",
              task: null,
            },
            created_at: now,
          } as unknown as DashboardSessionMessage,
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const statusCard = document.querySelector(
      '[data-testid="status-card"]',
    );
    const stepPanel = statusCard?.querySelector(
      '[data-testid="status-card-steps"]',
    );

    expect(statusCard?.textContent).toContain("1 step");
    expect(statusCard?.textContent).toContain("创建运行环境。");
    expect(statusCard?.textContent).toContain("正在下载依赖，预计还需要一分钟。");
    expect(stepPanel?.hasAttribute("open")).toBe(false);
  });

  test("session detail omits turn role badges from the message header", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-primary",
        session: undefined,
        messages: [
          {
            id: "msg-skipped-context",
            session_id: "conv-primary",
            owning_session_id: "conv-primary",
            channel_message_key: "m-skipped-context",
            senderUserId: "directory-user-requester",
            senderUser: {
              id: "directory-user-requester",
              kind: "human",
              displayName: "示例用户",
              avatarUrl: null,
              status: "active",
              profileSource: "channel",
            },
            role: "user",
            content: [{ type: "text", text: "旁路群聊消息" }],
            mentions: [],
            turnRoles: ["skipped", "context", "input"],
            turnStatus: "completed",
            turnReason: "silent_group",
            linked_tasks: [],
            linkedTasks: [],
            created_at: now,
          } as DashboardSessionMessage,
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const header = document.querySelector('[data-testid="message-header"]');

    expect(header?.textContent).not.toContain("未进 Main Runner");
    expect(header?.textContent).not.toContain("上下文");
    expect(header?.textContent).not.toContain("input");
  });

  test("session detail renders senderless assistant messages with neutral bot fallback", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        sessionId: "conv-assistant-fallback",
        session: undefined,
        messages: [
          {
            id: "msg-assistant-fallback",
            session_id: "conv-assistant-fallback",
            owning_session_id: "conv-assistant-fallback",
            channel_message_key: null,
            senderUserId: "directory-identity-luna-bot",
            senderUser: {
              id: "directory-identity-luna-bot",
              kind: "bot",
              displayName: "",
              avatarUrl: null,
              status: "active",
              profileSource: "channel",
            },
            role: "assistant",
            content: [{ type: "text", text: "收到，继续处理。" }],
            mentions: [],
            linked_tasks: [],
            linkedTasks: [],
            created_at: now,
          },
        ],
        loading: false,
        error: null,
        showNotFound: false,

      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const message = document.querySelector(
      '[data-testid="session-message-msg-assistant-fallback"]',
    );

    expect(message?.querySelector('[data-testid="message-avatar"]')?.textContent)
      .not.toBe("U");
    expect(renderedMarkupText(html)).toContain("Bot");
    expect(renderedMarkupText(html)).not.toContain("Unknown bot");
    expect(renderedMarkupText(html)).not.toContain("Luna");
  });

  test("session timeline groups only adjacent turn messages", async () => {
    sqlite.run(
      `UPDATE session_turns
        SET message_ids = ?, latest_message_id = ?
        WHERE id = ?`,
      [
        JSON.stringify(["msg-user-1", "msg-assistant-1"]),
        "msg-assistant-1",
        "turn-batch-1",
      ],
    );
    try {
      const timeline = await getJson<DashboardSessionTimelineItem[]>(
        "/api/sessions/conv-primary/timeline",
      );
      expect(
        timeline.map((item) =>
          item.type === "turn"
            ? `${item.turn.id}:${item.messages.map((message) => message.id).join(",")}`
            : item.message.id,
        ),
      ).toEqual([
        "turn-batch-1:msg-user-1,msg-assistant-1",
        "msg-user-2",
      ]);
      expect(timeline[0]).toMatchObject({
        type: "turn",
        turn: {
          id: "turn-batch-1",
          messageCount: 2,
          visibleMessageCount: 2,
          latestMessageId: "msg-assistant-1",
        },
        messages: [{ id: "msg-user-1" }, { id: "msg-assistant-1" }],
      });
      const sessions = await getJson<DashboardSession[]>("/api/sessions");
      const session = sessions.find((item) => item.id === "conv-primary");
      const html = renderToStaticMarkup(
        createElement(SessionDetailView, {
          sessionId: "conv-primary",
          session,
          timeline,
          loading: false,
          error: null,
          showNotFound: false,

        }),
      );
      const { document } = parseHTML(html) as unknown as {
        document: TestDocumentNode;
      };
      const turnGroup = document.querySelector(
        '[data-testid="session-turn-group-turn-batch-1"]',
      );

      expect(turnGroup?.getAttribute("class") ?? "").toContain("relative");
      expect(turnGroup?.getAttribute("class") ?? "").not.toContain("pl-3");
      expect(turnGroup?.querySelector('[data-testid="turn-hover-rail"]')).not
        .toBeNull();
      const turnDetails = turnGroup?.querySelector(
        '[data-testid="turn-hover-details"]',
      );
      expect(turnDetails).not.toBeNull();
      expect(turnDetails?.getAttribute("class") ?? "").toContain("absolute");
      expect(turnDetails?.getAttribute("class") ?? "").toContain("z-");
      expect(turnDetails?.getAttribute("class") ?? "").toContain("whitespace-nowrap");
      expect(turnDetails?.getAttribute("class") ?? "").toContain("-top-4");
      expect(turnDetails?.getAttribute("class") ?? "").not.toContain("top-0");
      expect(turnDetails?.getAttribute("class") ?? "").not.toContain("max-h-0");
    } finally {
      sqlite.run(
        `UPDATE session_turns
          SET message_ids = ?, latest_message_id = ?
          WHERE id = ?`,
        [
          JSON.stringify(["msg-user-1", "msg-user-2"]),
          "msg-user-2",
          "turn-batch-1",
        ],
      );
    }
  });

  test("session timeline does not group single-input turns with adjacent output", async () => {
    insertFixtureSessions(sqlite, [
      "conv-single-output",
      "feishu:chat:group-playback:thread-single-output",
      "feishu",
      "chat",
      "group-playback",
      "thread-single-output",
      "root-single-output",
      "Single output turn",
      now + 7_000,
      now + 8_000,
    ]);
    insertFixtureMessage(sqlite, {
      id: "msg-single-output-user",
      sessionId: "conv-single-output",
      channelMessageKey: "m-single-output-user",
      senderUserId: "ou_requester",
      role: "user",
      content: [{ type: "text", text: "在吗" }],
      rawPayload: { text: "在吗" },
      createdAt: now + 7_000,
    });
    insertFixtureMessage(sqlite, {
      id: "msg-single-output-assistant",
      sessionId: "conv-single-output",
      channelMessageKey: "m-single-output-assistant",
      senderUserId: "ou_luna_bot",
      role: "assistant",
      content: [{ type: "text", text: "在，老大。" }],
      rawPayload: { text: "在，老大。" },
      createdAt: now + 8_000,
    });
    sqlite.run(
      `INSERT INTO session_turns
        (id, session_id, turn_kind, status, runner_invoked, reason, started_at, completed_at, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "turn-single-output",
        "conv-single-output",
        "execution",
        "completed",
        1,
        "addressed",
        now + 7_100,
        now + 8_100,
        null,
        now + 7_100,
        now + 8_100,
      ],
    );
    insertFixtureTurnEntry(sqlite, {
      id: "turn-entry-single-output-trigger",
      turnId: "turn-single-output",
      sessionId: "conv-single-output",
      entryId: "entry-conv-single-output-msg-single-output-user-message",
      role: "trigger",
      createdAt: now + 7_101,
    });
    insertFixtureTurnEntry(sqlite, {
      id: "turn-entry-single-output-output",
      turnId: "turn-single-output",
      sessionId: "conv-single-output",
      entryId: "entry-conv-single-output-msg-single-output-assistant-message",
      role: "output",
      createdAt: now + 8_101,
    });

    const timeline = await getJson<DashboardSessionTimelineItem[]>(
      "/api/sessions/conv-single-output/timeline",
    );

    expect(
      timeline.map((item) =>
        item.type === "turn"
          ? `${item.turn.id}:${item.messages.map((message) => message.id).join(",")}`
          : item.message.id,
      ),
    ).toEqual([
      "turn-single-output:msg-single-output-user,msg-single-output-assistant",
    ]);
  });

  test("session timeline does not group historical context entries into the current turn", async () => {
    sqlite.run(
      `INSERT INTO session_turns
        (id, session_id, turn_kind, status, runner_invoked, reason, started_at, completed_at, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "turn-context-latest",
        "conv-primary",
        "execution",
        "completed",
        1,
        "addressed",
        now + 4_500,
        now + 5_000,
        null,
        now + 4_500,
        now + 5_000,
      ],
    );
    insertFixtureTurnEntry(sqlite, {
      id: "turn-context-latest-context-user-1",
      turnId: "turn-context-latest",
      sessionId: "conv-primary",
      entryId: "entry-conv-primary-msg-user-1-message",
      role: "context",
      createdAt: now + 4_501,
    });
    insertFixtureTurnEntry(sqlite, {
      id: "turn-context-latest-context-assistant-1",
      turnId: "turn-context-latest",
      sessionId: "conv-primary",
      entryId: "entry-conv-primary-msg-assistant-1-message",
      role: "context",
      createdAt: now + 4_502,
    });
    insertFixtureTurnEntry(sqlite, {
      id: "turn-context-latest-trigger-user-2",
      turnId: "turn-context-latest",
      sessionId: "conv-primary",
      entryId: "entry-conv-primary-msg-user-2-message",
      role: "trigger",
      createdAt: now + 4_503,
    });

    try {
      const timeline = await getJson<DashboardSessionTimelineItem[]>(
        "/api/sessions/conv-primary/timeline",
      );

      expect(
        timeline.map((item) =>
          item.type === "turn"
            ? `${item.turn.id}:${item.messages.map((message) => message.id).join(",")}`
            : item.message.id,
        ),
      ).toEqual([
        "turn-batch-1:msg-user-1",
        "msg-assistant-1",
        "msg-user-2",
      ]);
    } finally {
      sqlite.run(`DELETE FROM session_turn_entries WHERE turn_id = ?`, [
        "turn-context-latest",
      ]);
      sqlite.run(`DELETE FROM session_turns WHERE id = ?`, [
        "turn-context-latest",
      ]);
    }
  });

  test("/api/tasks returns dashboard task summaries", async () => {
    const tasks = await getJson<
      Array<{
        id: string;
        type: string;
        status: string;
        priority: string | null;
        title: string;
        summary: string | null;
        creatorUserId: string | null;
        creatorUser: DashboardCanonicalUserFixture | null;
        participants: Array<{
          userId: string;
          role: string;
          user: DashboardCanonicalUserFixture | null;
        }>;
        linked_session_count: number;
        linked_sessions: Array<{ id: string }>;
        linkedSessions: Array<{
          id: string;
          channelType: string;
          title: string | null;
          displayTitle: string;
        }>;
        runs: Array<{
          id: string;
          runIndex: number;
          status: string;
          reason: string;
          runnerType: string;
          finalReportArtifactId: string | null;
        }>;
        timeline: Array<{
          id: string;
          type: string;
          summary: string;
          visibility: string;
          actorUserId: string | null;
          actorUser: DashboardCanonicalUserFixture | null;
        }>;
        artifacts: Array<{
          id: string;
          name: string;
          type: string;
          mimeType: string | null;
          status: string;
          content: string | null;
        }>;
        last_activity_at: number;
      }>
    >("/api/tasks");

    expect(tasks).toHaveLength(1);
    const firstTask = tasks[0];
    expect(firstTask).toBeDefined();
    if (!firstTask) {
      throw new Error("expected seeded task");
    }
    expect(firstTask).toMatchObject({
      id: "task_1",
      type: "investigation",
      status: "completed",
      priority: "high",
      title: "Playback failure investigation",
      summary: "Report: CDN regression suspected in EU edge POPs.",
      creatorUserId: "directory-user-requester",
      creatorUser: {
        id: "directory-user-requester",
        displayName: "示例用户",
        kind: "human",
      },
      participants: [
        {
          userId: "directory-user-requester",
          role: "requester",
          user: {
            id: "directory-user-requester",
            displayName: "示例用户",
            kind: "human",
          },
        },
        {
          userId: "directory-identity-luna-bot",
          role: "agent",
          user: {
            id: "directory-identity-luna-bot",
            displayName: "Monkey King",
            kind: "bot",
          },
        },
      ],
      linked_session_count: 2,
      linked_sessions: [{ id: "conv-primary" }, { id: "conv-secondary" }],
      linkedSessions: [
        {
          id: "conv-primary",
          channelType: "feishu",
          title: "Playback investigation thread",
          displayTitle: "播放排查群",
        },
        {
          id: "conv-secondary",
          channelType: "feishu",
          title: "Ops escalation",
          displayTitle: "Ops escalation",
        },
      ],
      runs: [
        expect.objectContaining({
          id: "task-run-1",
          runIndex: 1,
          status: "completed",
          reason: "initial",
          runnerType: "mock",
          finalReportArtifactId: "artifact-report",
          inputSnapshot: expect.objectContaining({
            evidencePath: join(
              fixtureHome,
              "workspace",
              "uploads",
              "images",
              "evidence.jpeg",
            ),
          }),
        }),
      ],
      timeline: [
        {
          id: "timeline-created",
          type: "task_created",
          summary: "Task created from playback report",
          visibility: "full",
          actorUserId: "directory-user-requester",
          actorUser: {
            id: "directory-user-requester",
            displayName: "示例用户",
            kind: "human",
          },
        },
        {
          id: "timeline-report",
          type: "runner_report",
          summary: longTimelineSummary,
          visibility: "full",
          actorUserId: "directory-identity-luna-bot",
          actorUser: {
            id: "directory-identity-luna-bot",
            displayName: "Monkey King",
            kind: "bot",
          },
        },
      ],
      artifacts: [
        {
          id: "artifact-report",
          type: "report",
          name: "final-report.md",
          mimeType: "text/markdown",
          status: "active",
          content: expect.stringContaining(longReportLine),
        },
        {
          id: "artifact-runner-log",
          type: "raw_runner_log",
          name: "raw-runner.log",
          mimeType: "text/plain",
          status: "active",
          content: "RAW_RUNNER_LOG_LINE",
        },
      ],
      last_activity_at: now + 4_000,
    });
    expect(firstTask.linked_session_count).toBe(
      firstTask.linked_sessions.length,
    );
    expect(JSON.stringify(tasks)).toContain(fixtureHome);
  });

  test("/api/tasks/:id exposes task context packs, seed records, and run context summaries", async () => {
    const task = await getJson<DashboardTask>("/api/tasks/task_1");

    expect(task.contextPacks).toContainEqual(
      expect.objectContaining({
        id: "source-primary-pack",
        kind: "task_launch",
        selectionStrategy: "source_turn",
        triggerEntryId: "entry-conv-primary-msg-user-1-message",
        triggerMessageId: "msg-user-1",
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "source-primary",
            contextPackId: "source-primary-pack",
            itemKind: "message",
            itemId: "msg-user-1",
            role: "source",
            reason: "task source message",
            sourceSessionId: "conv-primary",
            sourceEntryId: "entry-conv-primary-msg-user-1-message",
            sourceMessageId: "msg-user-1",
            messagePreview: "Playback is failing for EU users",
            contextMessage: expect.objectContaining({
              id: "msg-user-1",
              entryId: "entry-conv-primary-msg-user-1-message",
              sessionId: "conv-primary",
            }),
          }),
        ]),
      }),
    );
    expect(task.sourceMessages).toContainEqual(
      expect.objectContaining({
        sourceId: "source-primary",
        sessionId: "conv-primary",
      }),
    );
    expect(task.workSession).toMatchObject({
      id: "conv-primary",
      displayTitle: "播放排查群",
    });
    for (const field of ["semanticDecision", "handoff", "runnerDecisions", "inboundHandoffs", "outboundHandoffs"]) {
      expect(Object.hasOwn(task, field)).toBe(false);
    }
    expect(task.seedRecords).toContainEqual(
      expect.objectContaining({
        id: "seed-task-run-1-source-primary",
        runnerContextId: "runner-context-1",
        seedContextPackId: "source-primary-pack",
        seedEntryIds: ["entry-conv-primary-msg-user-1-message"],
        seedContextItemIds: ["source-primary"],
      }),
    );
    expect(task.runs[0]).toMatchObject({
      id: "task-run-1",
      contextPackIds: ["source-primary-pack"],
      hasMaterializedPrompt: false,
      contextPacks: [
        expect.objectContaining({
          id: "source-primary-pack",
          kind: "task_launch",
        }),
      ],
    });
    expect(task.runContextSummaries).toEqual([
      expect.objectContaining({
        runId: "task-run-1",
        runIndex: 1,
        runnerContextId: "runner-context-1",
        contextPackIds: ["source-primary-pack"],
        hasMaterializedPrompt: false,
        seedContextPackIds: ["source-primary-pack"],
        seedRecords: [
          expect.objectContaining({
            id: "seed-task-run-1-source-primary",
            seedContextPackId: "source-primary-pack",
          }),
        ],
      }),
    ]);
  });

  test("/api/tasks tolerates malformed hidden task context", async () => {
    sqlite.run(
      `UPDATE tasks SET context_json = ? WHERE id = ?`,
      ["not-json", "task_1"],
    );

    try {
      const [tasks, task] = await Promise.all([
        getJson<DashboardTaskFixture[]>("/api/tasks"),
        getJson<DashboardTaskFixture>("/api/tasks/task_1"),
      ]);

      expect(tasks[0]).toMatchObject({
        id: "task_1",
        title: "Playback failure investigation",
      });
      expect(task).toMatchObject({
        id: "task_1",
        title: "Playback failure investigation",
      });
      expect(JSON.stringify([tasks, task])).not.toContain("not-json");
    } finally {
      sqlite.run(
        `UPDATE tasks SET context_json = NULL WHERE id = ?`,
        ["task_1"],
      );
    }
  });

  test("/api/tasks/:id/timeline returns timeline rows", async () => {
    const timeline = await getJson<
      Array<{
        id: string;
        type: string;
        summary: string;
        visibility: string;
        data: unknown;
        actorUserId: string | null;
        actorUser: DashboardCanonicalUserFixture | null;
      }>
    >("/api/tasks/task_1/timeline");

    expect(timeline.map((event) => event.summary)).toEqual([
      "Task created from playback report",
      longTimelineSummary,
    ]);
    expect(timeline[1]).toMatchObject({
      id: "timeline-report",
      type: "runner_report",
      visibility: "full",
      actorUserId: "directory-identity-luna-bot",
      actorUser: {
        id: "directory-identity-luna-bot",
        displayName: "Monkey King",
        kind: "bot",
      },
      taskRunId: "task-run-1",
      runIndex: 1,
    });
  });

  test("/api/tasks/:id/timeline tolerates malformed event data", async () => {
    sqlite.run(
      `UPDATE timeline_events SET data = ? WHERE id = ?`,
      ["not-json", "timeline-report"],
    );

    try {
      const timeline = await getJson<
        Array<{
          id: string;
          data: unknown;
          taskRunId: string | null;
          runIndex: number | null;
        }>
      >("/api/tasks/task_1/timeline");
      const event = timeline.find((item) => item.id === "timeline-report");

      expect(event).toMatchObject({
        id: "timeline-report",
        data: null,
        taskRunId: null,
        runIndex: null,
      });
    } finally {
      sqlite.run(
        `UPDATE timeline_events SET data = ? WHERE id = ?`,
        [
          JSON.stringify({
            artifact_id: "artifact-report",
            artifactIds: ["artifact-report"],
            operation: "media.playback.trace.query",
            requestId: "req_dashboard_trace",
            status: "success",
            taskRunId: "task-run-1",
            runIndex: 1,
            runReason: "initial",
            runnerType: "mock",
            sourcePath: join(
              fixtureHome,
              "workspace",
              "uploads",
              "images",
              "evidence.jpeg",
            ),
          }),
          "timeline-report",
        ],
      );
    }
  });

  test("/api/tasks/:id/runs returns task run lifecycle rows", async () => {
    const materializedPrompt = [
      "You are handling a Luna investigation Task.",
      "- role=attachment source=message:msg-image",
      "  ![image](artifact:artifact-report)",
    ].join("\n");
    sqlite.run(
      `UPDATE task_runs SET materialized_prompt = ? WHERE id = ?`,
      [materializedPrompt, "task-run-1"],
    );
    const runs = await getJson<
      Array<{
        id: string;
        taskId: string;
        runIndex: number;
        status: string;
        reason: string;
        runnerType: string;
        inputSnapshot: unknown;
        materializedPrompt: string | null;
        finalReportArtifactId: string | null;
      }>
    >("/api/tasks/task_1/runs");

    try {
      expect(runs).toEqual([
        expect.objectContaining({
          id: "task-run-1",
          taskId: "task_1",
          runIndex: 1,
          status: "completed",
          reason: "initial",
          runnerType: "mock",
          inputSnapshot: expect.objectContaining({
            evidencePath: join(
              fixtureHome,
              "workspace",
              "uploads",
              "images",
              "evidence.jpeg",
            ),
          }),
          materializedPrompt,
          finalReportArtifactId: "artifact-report",
        }),
      ]);
      expect(JSON.stringify(runs)).toContain(fixtureHome);
      expect(JSON.stringify(runs)).not.toContain("/api/artifacts/artifact-report");
    } finally {
      sqlite.run(
        `UPDATE task_runs SET materialized_prompt = NULL WHERE id = ?`,
        ["task-run-1"],
      );
    }
  });

  test("/api/tasks/:id/runs tolerates malformed run input snapshots", async () => {
    sqlite.run(
      `UPDATE task_runs SET input_snapshot = ? WHERE id = ?`,
      ["not-json", "task-run-1"],
    );

    try {
      const runs = await getJson<DashboardTaskRunFixture[]>(
        "/api/tasks/task_1/runs",
      );

      expect(runs).toEqual([
        expect.objectContaining({
          id: "task-run-1",
          inputSnapshot: null,
          input_snapshot: null,
        }),
      ]);
    } finally {
      sqlite.run(
        `UPDATE task_runs SET input_snapshot = ? WHERE id = ?`,
        [
          JSON.stringify({
            prompt: longRunInputPrompt,
            evidencePath: "workspace/uploads/images/evidence.jpeg",
          }),
          "task-run-1",
        ],
      );
    }
  });

  test("/api/tasks/:id/artifacts links raw runner logs as artifacts", async () => {
    const artifacts = await getJson<
      Array<{
        id: string;
        type: string;
        name: string;
        path: string | null;
        mimeType: string | null;
        status: string;
      }>
    >("/api/tasks/task_1/artifacts");

    expect(artifacts).toContainEqual(
      expect.objectContaining({
        id: "artifact-runner-log",
        type: "raw_runner_log",
        name: "raw-runner.log",
        path: "artifacts/task_1/raw-runner.log",
        href: expect.stringMatching(
          /^\/artifacts\/artifact-runner-log\/preview\?expires=/,
        ),
        mimeType: "text/plain",
        status: "active",
      }),
    );
    expect(JSON.stringify(artifacts)).not.toContain(fixtureHome);
    expect(artifacts).toContainEqual(
      expect.objectContaining({
        id: "artifact-report",
        type: "report",
        name: "final-report.md",
        mimeType: "text/markdown",
        status: "active",
      }),
    );
  });

  test("/api/tasks/:id/artifacts links legacy task artifacts through managed artifact metadata", async () => {
    const reportPath = join(fixtureHome, "artifacts", "task_1", "managed-report.md");
    writeFileSync(reportPath, "# Managed report\n");
    insertFixtureOwnedRows(sqlite, "managed_artifacts", "id, scope_type, scope_id, related_user_id, producer, kind, name, mime_type, size_bytes, sha256, storage_backend, storage_key, status, retention_policy, retention_expires_at, created_at, deleted_at", [
      "managed-report-link",
      "task",
      "task_1",
      "local-dashboard-user",
      "test",
      "report",
      "managed-report.md",
      "text/markdown",
      "# Managed report\n".length,
      "managed-report-link-sha",
      "local",
      reportPath,
      "active",
      "task",
      null,
      now + 5_000,
      null,
    ]);
    sqlite.run(
      `INSERT INTO artifacts
        (id, task_id, timeline_event_id, type, name, mime_type, path, content, metadata, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy-report-link",
        "task_1",
        "timeline-report",
        "report",
        "managed-report.md",
        "text/markdown",
        join(fixtureHome, "tasks", "task_1", "workspace", "managed-report.md"),
        "# Managed report\n",
        JSON.stringify({ managedArtifactId: "managed-report-link" }),
        "active",
        now + 5_000,
      ],
    );

    try {
      const artifacts = await getJson<DashboardArtifactFixture[]>(
        "/api/tasks/task_1/artifacts",
      );
      const report = artifacts.find((artifact) => artifact.id === "legacy-report-link");

      expect(report).toEqual(
        expect.objectContaining({
          id: "legacy-report-link",
          path: "tasks/task_1/workspace/managed-report.md",
          href: expect.stringMatching(
            /^\/artifacts\/managed-report-link\/preview\?expires=/,
          ),
        }),
      );
    } finally {
      sqlite.run(`DELETE FROM artifacts WHERE id = ?`, ["legacy-report-link"]);
      sqlite.run(`DELETE FROM managed_artifacts WHERE id = ?`, [
        "managed-report-link",
      ]);
    }
  });

  test("/api/tasks/:id/artifacts renders report artifact refs as markdown links", async () => {
    sqlite.run(
      `UPDATE artifacts SET content = ? WHERE id = ?`,
      [
        [
          "检测对象是最近图片附件 `artifact:task-evidence-image`。",
          "原图：![image](artifact:task-evidence-image)",
        ].join("\n"),
        "artifact-report",
      ],
    );

    try {
      const artifacts = await getJson<DashboardArtifactFixture[]>(
        "/api/tasks/task_1/artifacts",
      );
      const report = artifacts.find((artifact) => artifact.id === "artifact-report");

      expect(report?.content).toContain(
        "[artifact:task-evidence-image](/artifacts/task-evidence-image/preview?expires=",
      );
      expect(report?.content).toContain(
        "![image](/api/artifacts/task-evidence-image/content?expires=",
      );
      expect(report?.content).not.toContain(
        "`/artifacts/task-evidence-image/preview",
      );
    } finally {
      sqlite.run(
        `UPDATE artifacts SET content = ? WHERE id = ?`,
        [
          [
            "Report: CDN regression suspected in EU edge POPs.",
            "",
            markdownReportSection,
            "",
            longReportLine,
          ].join("\n"),
          "artifact-report",
        ],
      );
    }
  });

  test("/api/tasks/:id/artifacts tolerates malformed artifact metadata", async () => {
    sqlite.run(
      `UPDATE artifacts SET metadata = ? WHERE id = ?`,
      ["not-json", "artifact-runner-log"],
    );

    try {
      const artifacts = await getJson<DashboardArtifactFixture[]>(
        "/api/tasks/task_1/artifacts",
      );

      expect(artifacts).toContainEqual(
        expect.objectContaining({
          id: "artifact-runner-log",
          metadata: null,
        }),
      );
    } finally {
      sqlite.run(
        `UPDATE artifacts SET metadata = ? WHERE id = ?`,
        [JSON.stringify({ format: "text" }), "artifact-runner-log"],
      );
    }
  });

});

describe("luna dashboard task route", () => {
  test("/tasks/:taskId renders fixture-backed task detail without inline raw logs", async () => {
    const [taskDetail, timeline, artifacts] = await Promise.all([
      getJson<DashboardTaskFixture>("/api/tasks/task_1"),
      getJson<DashboardTimelineFixture[]>("/api/tasks/task_1/timeline"),
      getJson<DashboardArtifactFixture[]>("/api/tasks/task_1/artifacts"),
    ]);

    const html = renderToStaticMarkup(
      createElement(TaskDetailView, {
        taskDetail,
        runs: taskDetail.runs,
        timeline,
        artifacts,
        loading: {
          taskDetail: false,
          runs: false,
          timeline: false,
          artifacts: false,
        },
      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const renderedText = renderedMarkupText(html);
    const artifactLinks = Array.from(
      document.querySelectorAll('[data-testid="task-artifact-link"]'),
    ).map((node) => {
      const anchor = node as TestAnchorNode;
      return {
        text: anchor.textContent ?? "",
        href: anchor.getAttribute("href"),
      };
    });

    expect(document.querySelector('[data-testid="task-header"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="task-timeline"]'),
    ).not.toBeNull();
    expect(renderedText).toContain("Playback failure investigation");
    expect(renderedText).toContain("task_1");
    expect(renderedText).toContain("completed");
    expect(renderedText).toContain("Creator");
    expect(renderedText).toContain("示例用户");
    expect(renderedText).toContain("Participants");
    expect(renderedText).toContain("requester");
    expect(renderedText).toContain("Monkey King");
    expect(renderedText).toContain("Timeline");
    expect(renderedText).toContain("Task created from playback report");
    expect(renderedText).toContain("Runner produced investigation report");
    expect(renderedText).toContain("Report");
    expect(renderedText).toContain("Artifacts");
    expect(renderedText).toContain("Context");
    expect(artifactLinks).toHaveLength(0);
    expect(renderedText).not.toContain("requester:ou_requester");
    expect(renderedText).not.toContain("RAW_RUNNER_LOG_LINE");
  });

  test("task detail tabs select one panel at a time", async () => {
    const view = await renderInteractiveTaskDetail();

    expect(view.selectedTabText()).toBe("Timeline");
    expect(view.text()).toContain("Task created from playback report");
    expect(view.text()).toContain("示例用户");
    expect(view.text()).not.toContain(longReportLine);

    await view.clickTab("Runs");
    expect(view.selectedTabText()).toBe("Runs");
    expect(view.text()).toContain("#1");
    expect(view.text()).toContain("completed");
    expect(view.text()).toContain("initial");
    expect(view.text()).toContain("mock");
    expect(view.text()).toContain("artifact-report");
    expect(view.text()).not.toContain("Task created from playback report");

    await view.clickTab("Report");
    expect(view.selectedTabText()).toBe("Report");
    expect(view.text()).toContain("final-report.md");
    expect(view.text()).toContain(longReportLine.trim());
    expect(view.text()).not.toContain("Task created from playback report");

    await view.clickTab("Artifacts");
    expect(view.selectedTabText()).toBe("Artifacts");
    expect(view.text()).toContain("raw-runner.log");
    expect(view.text()).toContain("report");
    expect(view.text()).toContain("log");
      expect(view.artifactLinks()).toContainEqual({
        text: "raw-runner.log",
        href: expect.stringMatching(
          /^\/artifacts\/artifact-runner-log\/preview\?expires=/,
        ),
      });
    expect(view.text()).not.toContain("RAW_RUNNER_LOG_LINE");

    await view.clickTab("Context");
    expect(view.selectedTabText()).toBe("Context");
    expect(view.text()).toContain("Work session");
    expect(view.text()).toContain("Notifications");
    expect(view.text()).toContain("Participants");
    expect(view.text()).toContain("Linked Sessions");
    expect(view.text()).toContain("示例用户");
    expect(view.text()).toContain("Monkey King");
    expect(view.text()).toContain("播放排查群");
    expect(view.text()).toContain("runner-context-1");

    view.cleanup();
  });

  test("task detail report tab only inlines the latest completed run report", async () => {
    const [taskDetail, timeline, artifacts] = await Promise.all([
      getJson<DashboardTaskFixture>("/api/tasks/task_1"),
      getJson<DashboardTimelineFixture[]>("/api/tasks/task_1/timeline"),
      getJson<DashboardArtifactFixture[]>("/api/tasks/task_1/artifacts"),
    ]);
    const latestFailedRun = {
      ...taskDetail.runs[0]!,
      id: "task-run-2",
      run_index: 2,
      runIndex: 2,
      status: "failed",
      reason: "restart",
      final_report_artifact_id: null,
      finalReportArtifactId: null,
      error: "Task runner completed without a text report.",
    };
    const view = await renderInteractiveTaskDetailFromData({
      taskDetail: {
        ...taskDetail,
        status: "failed",
        runs: [...taskDetail.runs, latestFailedRun],
      },
      timeline,
      artifacts,
    });

    await view.clickTab("Report");

    expect(view.text()).not.toContain(longReportLine.trim());
    expect(view.text()).not.toContain("final-report.md");

    view.cleanup();
  });

  test("task detail artifact links do not fall back to local workspace paths", async () => {
    sqlite.run(
      `INSERT INTO artifacts
        (id, task_id, timeline_event_id, type, name, mime_type, path, content, metadata, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy-workspace-report",
        "task_1",
        "timeline-report",
        "report",
        "legacy-final-report.md",
        "text/markdown",
        join(fixtureHome, "tasks", "task_1", "workspace", "final-report.md"),
        "# Legacy report\n",
        JSON.stringify({ format: "markdown" }),
        "active",
        now + 6_000,
      ],
    );

    const view = await renderInteractiveTaskDetail();
    try {
      await view.clickTab("Artifacts");
      expect(view.text()).toContain("legacy-final-report.md");
      expect(view.artifactLinks()).not.toContainEqual(
        expect.objectContaining({
          text: "legacy-final-report.md",
        }),
      );
      expect(view.artifactLinks()).not.toContainEqual(
        expect.objectContaining({
          href: expect.stringContaining("workspace/final-report.md"),
        }),
      );
      expect(view.artifactLinks()).not.toContainEqual(
        expect.objectContaining({
          href: expect.stringContaining("/agent/tasks/tasks/"),
        }),
      );
    } finally {
      view.cleanup();
      sqlite.run(`DELETE FROM artifacts WHERE id = ?`, [
        "legacy-workspace-report",
      ]);
    }
  });

  test("task detail Context tab renders context packs, seed records, and run context summaries", async () => {
    const view = await renderInteractiveTaskDetail();

    try {
      await view.clickTab("Context");
      const renderedText = view.text();

      expect(renderedText).toContain("Context Packs");
      expect(renderedText).toContain("task_launch");
      expect(renderedText).toContain("source_turn");
      expect(renderedText).toContain("source-primary-pack");
      expect(renderedText).toContain("source");
      expect(renderedText).toContain("task source message");
      expect(renderedText).toContain("msg-user-1");
      expect(renderedText).toContain("Playback is failing for EU users");
      expect(renderedText).toContain("Seed Records");
      expect(renderedText).toContain("seed-task-run-1-source-primary");
      expect(renderedText).toContain("runner-context-1");
      expect(renderedText).toContain("Run Context Summaries");
      expect(renderedText).toContain("Run #1");
      expect(renderedText).toContain("has prompt false");
      expect(
        view.query('[aria-label="Copy context pack JSON source-primary-pack"]'),
      ).not.toBeNull();
      expect(
        view.query('[aria-label="Copy seed record JSON seed-task-run-1-source-primary"]'),
      ).not.toBeNull();
      expect(
        view.query('[aria-label="Copy run context summary JSON task-run-1"]'),
      ).not.toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("task Runs tab renders compact run context summaries alongside prompt copy", async () => {
    const materializedPrompt = [
      "You are handling a Luna investigation Task.",
      "Run reason: initial",
      "Launch context:",
      "- role=attachment source=message:msg-image",
      "  ![image](artifact:artifact-report)",
      "Input for this run:",
      longRunInputPrompt,
    ].join("\n");
    sqlite.run(
      `UPDATE task_runs SET materialized_prompt = ? WHERE id = ?`,
      [materializedPrompt, "task-run-1"],
    );

    try {
      const view = await renderInteractiveTaskDetail();
      try {
        await view.clickTab("Runs");
        const renderedText = view.text();

        expect(
          view.query('[aria-label="Copy LLM prompt for run #1"]'),
        ).not.toBeNull();
        expect(renderedText).toContain("Context packs");
        expect(renderedText).toContain("source-primary-pack");
        expect(renderedText).toContain("has prompt true");
        expect(renderedText).toContain("Seed records");
        expect(renderedText).toContain("seed-task-run-1-source-primary");
      } finally {
        view.cleanup();
      }
    } finally {
      sqlite.run(
        `UPDATE task_runs SET materialized_prompt = NULL WHERE id = ?`,
        ["task-run-1"],
      );
    }
  });

  test("task context shows source message and source turn context with images", async () => {
    insertFixtureSessions(sqlite, [
      "conv-image-root",
      "feishu:chat:group-playback:rootless:image",
      "feishu",
      "chat",
      "group-playback",
      null,
      null,
      "Image source root",
      now + 20_000,
      now + 21_000,
      "conv-image-thread",
      "feishu:chat:group-playback:thread-image",
      "feishu",
      "chat",
      "group-playback",
      "thread-image",
      "m-image-ask",
      "Image moderation thread",
      now + 21_000,
      now + 22_000,
    ]);
    insertFixtureMessage(sqlite, {
      id: "msg-image-source",
      sessionId: "conv-image-root",
      channelMessageKey: "m-image-source",
      senderUserId: "ou_requester",
      role: "user",
      content: [
        {
          type: "image",
          fileId: "img_fixture_context",
          url: "artifact:task-evidence-image",
          alt: "image",
        },
        { type: "text", text: "这是上一张图片" },
      ],
      rawPayload: { text: "这是上一张图片" },
      createdAt: now + 20_000,
      contentKind: "mixed",
      presentationKind: "image_gallery",
      providerMessageType: "image",
    });
    insertFixtureMessage(sqlite, {
      id: "msg-image-ask",
      sessionId: "conv-image-root",
      channelMessageKey: "m-image-ask",
      senderUserId: "ou_requester",
      role: "user",
      content: [
        {
          type: "text",
          text: "你可以帮忙看看这个图片有没色情信息吗，这可能是个耗时的任务",
        },
      ],
      rawPayload: { text: "你可以帮忙看看这个图片有没色情信息吗，这可能是个耗时的任务" },
      createdAt: now + 21_000,
    });
    insertFixtureTimelineEntry(sqlite, {
      id: "entry-conv-image-thread-msg-image-ask-reference",
      sessionId: "conv-image-thread",
      messageId: "msg-image-ask",
      entryKind: "reference",
      createdAt: now + 21_001,
    });
    sqlite.run(
      `INSERT INTO session_turns
        (id, session_id, turn_kind, status, runner_invoked, reason, started_at, completed_at, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "turn-image-ask",
        "conv-image-root",
        "execution",
        "completed",
        1,
        "addressed",
        now + 21_010,
        now + 21_500,
        null,
        now + 21_010,
        now + 21_500,
      ],
    );
    insertFixtureTurnEntry(sqlite, {
      id: "turn-image-context",
      turnId: "turn-image-ask",
      sessionId: "conv-image-root",
      entryId: "entry-conv-image-root-msg-image-source-message",
      role: "context",
      createdAt: now + 21_011,
    });
    insertFixtureTurnEntry(sqlite, {
      id: "turn-image-trigger",
      turnId: "turn-image-ask",
      sessionId: "conv-image-root",
      entryId: "entry-conv-image-root-msg-image-ask-message",
      role: "trigger",
      createdAt: now + 21_012,
    });
    insertFixtureOwnedRows(sqlite, "tasks", "id, type, status, priority, severity, title, summary, creator_user_id, primary_session_id, source_message_id, source_entry_id, context_json, created_at, updated_at, last_activity_at", [
      "task-image-context",
      "question",
      "completed",
      "medium",
      null,
      "图片色情信息判断",
      "检查最近一张图片是否包含色情或性暗示信息。",
      "directory-user-requester",
      "conv-image-thread",
      "msg-image-ask",
      "entry-conv-image-thread-msg-image-ask-reference",
      JSON.stringify({
        latestUserMessage:
          "你可以帮忙看看这个图片有没色情信息吗，这可能是个耗时的任务",
        knownFacts: [
          "用户要求判断图片是否有色情信息。",
          "待检查图片来自上一条图片消息：artifact:task-evidence-image。",
        ],
        assumptions: ["以最近一张用户发送的图片为分析对象。"],
        pendingQuestions: [],
      }),
      now + 21_000,
      now + 22_000,
      now + 22_000,
    ]);
    insertFixtureTaskSourceContextPack(sqlite, {
      packId: "source-image-context-pack",
      taskId: "task-image-context",
      sessionId: "conv-image-root",
      messageId: "msg-image-ask",
      sourceEntryId: "entry-conv-image-root-msg-image-ask-message",
      userId: "directory-user-requester",
      createdAt: now + 21_000,
      items: [{ id: "source-image-context", messageId: "msg-image-ask" }],
    });
    sqlite.run(
      `INSERT INTO task_subscriptions
        (id, task_id, session_id, channel_type, channel_id, group_id, thread_key, visibility, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "subscription-image-thread",
        "task-image-context",
        "conv-image-thread",
        "feishu",
        "chat",
        "group-playback",
        "thread-image",
        "full",
        now + 21_000,
        now + 22_000,
      ],
    );

    try {
      const taskDetail = await getJson<DashboardTaskFixture>(
        "/api/tasks/task-image-context",
      );

      expect(taskDetail.taskContext).toMatchObject({
        latestUserMessage:
          "你可以帮忙看看这个图片有没色情信息吗，这可能是个耗时的任务",
        knownFacts: [
          "用户要求判断图片是否有色情信息。",
          expect.stringContaining(
            "待检查图片来自上一条图片消息：[artifact:task-evidence-image](/artifacts/task-evidence-image/preview?expires=",
          ),
        ],
        assumptions: ["以最近一张用户发送的图片为分析对象。"],
      });
      expect(taskDetail.sourceMessages.map((item) => item.message.id)).toEqual([
        "msg-image-ask",
      ]);
      expect(
        taskDetail.sourceTurnMessages.map(
          (item) => `${item.turnRole}:${item.message.id}`,
        ),
      ).toEqual([
        "context:msg-image-source",
        "trigger:msg-image-ask",
      ]);

      const view = await renderInteractiveTaskDetail("task-image-context");
      await view.clickTab("Context");
      const renderedText = view.text();

      expect(renderedText).toContain("Task Context");
      expect(renderedText).toContain("用户要求判断图片是否有色情信息。");
      expect(renderedText).toContain("Source Messages");
      expect(renderedText).toContain("Source Turn Context");
      expect(renderedText).toContain("trigger");
      expect(renderedText).toContain("context");
      expect(
        view.query(
          "img[src^='/api/artifacts/task-evidence-image/content?expires=']",
        ),
      ).not.toBeNull();
      expect(renderedText).toContain("Source session");
      expect(renderedText).toContain("Notification thread");
      view.cleanup();
    } finally {
      sqlite.run(`DELETE FROM task_subscriptions WHERE task_id = ?`, [
        "task-image-context",
      ]);
      deleteFixtureTaskSourceContextPacks(sqlite, [
        "task-image-context",
      ]);
      sqlite.run(`DELETE FROM tasks WHERE id = ?`, ["task-image-context"]);
      sqlite.run(`DELETE FROM session_turn_entries WHERE turn_id = ?`, [
        "turn-image-ask",
      ]);
      sqlite.run(`DELETE FROM session_turns WHERE id = ?`, ["turn-image-ask"]);
      sqlite.run(`DELETE FROM session_timeline_entries WHERE session_id = ?`, [
        "conv-image-thread",
      ]);
      sqlite.run(`DELETE FROM fixture_messages WHERE id IN (?, ?)`, [
        "msg-image-source",
        "msg-image-ask",
      ]);
      sqlite.run(`DELETE FROM sessions WHERE id IN (?, ?)`, [
        "conv-image-root",
        "conv-image-thread",
      ]);
    }
  });

  test("task detail truncated fields expose full content through reusable hover copy controls", async () => {
    const view = await renderInteractiveTaskDetail();

    const timelineSummary = view.query(
      '[data-testid="task-timeline-summary-timeline-report"]',
    );
    const timelinePreview = timelineSummary?.querySelector(
      '[data-testid="inspectable-text-preview"]',
    );
    const timelinePopover = timelineSummary?.querySelector(
      '[data-testid="inspectable-text-popover"]',
    );

    expect(timelineSummary?.textContent ?? "").toContain("Copy full Summary");
    expect(timelinePreview?.textContent ?? "").toContain("...");
    expect(timelinePreview?.textContent ?? "").not.toContain(
      longTimelineSummary,
    );
    expect(timelinePopover?.textContent ?? "").toContain(longTimelineSummary);

    await view.clickTab("Runs");

    const runInput = view.query('[data-testid="task-run-input-task-run-1"]');
    const runInputPreview = runInput?.querySelector(
      '[data-testid="inspectable-text-preview"]',
    );
    const runInputPopover = runInput?.querySelector(
      '[data-testid="inspectable-text-popover"]',
    );

    expect(runInput?.textContent ?? "").toContain("Copy full Input");
    expect(runInputPreview?.textContent ?? "").toContain("...");
    expect(runInputPreview?.textContent ?? "").not.toContain(
      longRunInputPrompt,
    );
    expect(runInputPopover?.textContent ?? "").toContain(longRunInputPrompt);

    view.cleanup();
  });

  test("task detail copies the exact prompt sent to the LLM for each run", async () => {
    const materializedPrompt = [
      "You are handling a Luna investigation Task.",
      "Run reason: initial",
      "Input for this run:",
      longRunInputPrompt,
    ].join("\n");
    sqlite.run(
      `UPDATE task_runs SET materialized_prompt = ? WHERE id = ?`,
      [
        materializedPrompt,
        "task-run-1",
      ],
    );
    let copiedText = "";
    const previousNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copiedText = text;
          },
        },
      },
    });

    const view = await renderInteractiveTaskDetail();

    try {
      await view.clickTab("Runs");
      expect(view.query('[aria-label="Copy LLM prompt for run #1"]')).not
        .toBeNull();

      await view.click('[aria-label="Copy LLM prompt for run #1"]');

      expect(copiedText).toBe(materializedPrompt);
      expect(() => JSON.parse(copiedText)).toThrow();
      expect(copiedText).not.toContain("pendingText");
      expect(copiedText).not.toContain("/api/artifacts/artifact-report");
    } finally {
      view.cleanup();
      sqlite.run(
        `UPDATE task_runs SET materialized_prompt = NULL WHERE id = ?`,
        ["task-run-1"],
      );
      if (previousNavigator) {
        Object.defineProperty(globalThis, "navigator", previousNavigator);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    }
  });

  test("task detail renders explicit error state instead of empty content", () => {
    const html = renderToStaticMarkup(
      createElement(TaskDetailView, {
        taskDetail: undefined,
        runs: undefined,
        timeline: undefined,
        artifacts: undefined,
        loading: {
          taskDetail: false,
          runs: false,
          timeline: false,
          artifacts: false,
        },
        errors: {
          taskDetail: new Error("Task not found"),
        },
      }),
    );
    const { document } = parseHTML(html) as unknown as {
      document: TestDocumentNode;
    };
    const renderedText = renderedMarkupText(html);

    expect(renderedText).toContain("Task failed to load");
    expect(renderedText).toContain("Task not found");
    expect(renderedText).not.toContain("No report summary is available.");
  });

  test("task detail renders plugin operation trace and linked artifacts", async () => {
    const rendered = await renderInteractiveTaskDetail();
    try {
      const text = rendered.text();
      expect(text).toContain("Operation Trace");
      expect(text).toContain("media.playback.trace.query");
      expect(text).toContain("req_dashboard_trace");
      expect(text).toContain("artifact-report");
    } finally {
      rendered.cleanup();
    }
  });

  test("report content wraps without rendering raw log content inline", async () => {
    const view = await renderInteractiveTaskDetail();

    await view.clickTab("Report");

    const reportContent = view.query('[data-testid="task-report-content"]');
    expect(reportContent?.textContent ?? "").toContain(longReportLine.trim());
    expect(reportContent?.getAttribute("class") ?? "").toContain(
      "whitespace-pre-wrap",
    );
    expect(reportContent?.getAttribute("class") ?? "").toContain("break-words");
    expect(view.text()).not.toContain("RAW_RUNNER_LOG_LINE");

    view.cleanup();
  });

  test("report content renders final-report.md markdown structure", async () => {
    const view = await renderInteractiveTaskDetail();

    await view.clickTab("Report");

    const reportContent = view.query('[data-testid="task-report-content"]');
    expect(reportContent?.innerHTML ?? "").toContain("<ul");
    expect(reportContent?.innerHTML ?? "").toContain("<code");
    expect(reportContent?.textContent ?? "").toContain("edge-cache");

    view.cleanup();
  });
});

describe("luna dashboard build coverage", () => {
  test("agent overview and task list use latest-run task statuses", () => {
    const overviewSource = readFileSync(
      "apps/dashboard/src/app/home-overview.tsx",
      "utf-8",
    );
    const taskListSource = readFileSync(
      "apps/dashboard/src/app/tasks/index.tsx",
      "utf-8",
    );
    for (const status of ["new", "completed", "failed", "cancelled"]) {
      expect(isActiveTaskStatus(status)).toBe(false);
    }
    expect(isActiveTaskStatus("running")).toBe(true);
    for (const legacyStatus of [
      "NEW",
      "TRIAGE",
      "INVESTIGATING",
      "WAITING_USER",
      "WAITING_DEV",
      "WAITING_APPROVAL",
      "ESCALATED",
      "RESOLVED",
      "CLOSED",
    ]) {
      expect(isActiveTaskStatus(legacyStatus)).toBe(false);
      expect(overviewSource).not.toContain(legacyStatus);
      expect(taskListSource).not.toContain(legacyStatus);
    }
    expect(overviewSource).toContain("isActiveTaskStatus");
    expect(taskListSource).toContain("isActiveTaskStatus");
  });

  test("task dashboard exposes luna runtime fields", () => {
    const taskListSource = readFileSync(
      "apps/dashboard/src/app/tasks/index.tsx",
      "utf-8",
    );

    expect(taskListSource).toContain("typeFilter");
    expect(taskListSource).toContain("statusFilter");
    expect(taskListSource).toContain("priorityFilter");
    expect(taskListSource).toContain("Search title, id, status, priority");
  });

  test("agent dashboard build emits a production app shell", async () => {
    const process = Bun.spawnSync(["bun", "run", "--cwd", "apps/dashboard", "build"]);

    expect(process.exitCode).toBe(0);

    const outdir = join("apps", "dashboard", "dist");
    const indexPath = join(outdir, "index.html");
    const artifactPreviewPath = join(outdir, "artifact-preview.html");
    expect(existsSync(indexPath)).toBe(true);
    expect(existsSync(artifactPreviewPath)).toBe(true);
    const html = readFileSync(indexPath, "utf-8");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/agent/main.js"');
    expect(html).toContain('href="/agent/main.css"');
    const artifactHtml = readFileSync(artifactPreviewPath, "utf-8");
    expect(artifactHtml).toContain('<div id="artifact-preview-root"></div>');
    expect(artifactHtml).toContain('src="/agent/artifact-preview.js"');
    expect(artifactHtml).toContain('href="/agent/main.css"');

    const css = readFileSync(join(outdir, "main.css"), "utf-8");
    expect(css).toContain("tailwindcss v");
    expect(css).toContain(".flex");
    expect(css).toContain("display: flex");
    expect(css).not.toContain('@import "tailwindcss"');
    expect(css).not.toContain("@apply");

    const js = readFileSync(join(outdir, "main.js"), "utf-8");
    const artifactJs = readFileSync(join(outdir, "artifact-preview.js"), "utf-8");
    expect(artifactJs).toContain("artifact-preview-root");
    expect(artifactJs).toContain("/artifacts/");
    expect(artifactJs).toContain("Artifact not found");
    expect(artifactJs).toContain("Artifact link expired");
    expect(artifactJs).toContain("Preview unavailable");
    for (const path of ["/sessions/", "/sessions/$sessionId", "/users/", "/tasks/", "/tasks/$taskId"]) {
      expect(js).toContain(`createFileRoute("/$agentId${path}")`);
    }
  });

  test("workspace build and typecheck include the agent dashboard", async () => {
    const packageJson = (await Bun.file("package.json").json()) as {
      workspaces: string[];
      scripts: { build: string; typecheck: string };
    };
    const uiPackageJson = (await Bun.file("apps/dashboard/package.json").json()) as {
      name: string;
      private: boolean;
      type: string;
      scripts: { build: string; typecheck: string; test: string };
    };
    const tsconfig = (await Bun.file("tsconfig.base.json").json()) as {
      compilerOptions: {
        paths: Record<string, string[]>;
      };
      include: string[];
      exclude?: string[];
    };
    const uiTsconfig = (await Bun.file("apps/dashboard/tsconfig.json").json()) as {
      extends: string;
      compilerOptions: {
        baseUrl: string;
        paths: Record<string, string[]>;
      };
      include: string[];
    };

    expect(packageJson.workspaces).toEqual(expect.arrayContaining(["packages/*", "apps/*"]));
    expect(packageJson.scripts.build).toContain("bun run --cwd apps/dashboard build");
    expect(packageJson.scripts.typecheck).toContain("tsconfig.base.json");
    expect(packageJson.scripts.typecheck).toContain("bun run --cwd apps/dashboard typecheck");
    expect("build:agent" in packageJson.scripts).toBe(false);

    expect(uiPackageJson.name).toBe("@luna/dashboard");
    expect(uiPackageJson.private).toBe(true);
    expect(uiPackageJson.type).toBe("module");
    expect(uiPackageJson.scripts.build).toContain(
      "bun build src/main.tsx",
    );
    expect(uiPackageJson.scripts.build).toContain(
      "../../node_modules/.bin/tailwindcss -i src/global.css -o dist/main.css",
    );
    expect(uiPackageJson.scripts.build).toContain(
      "cp index.html dist/index.html",
    );
    expect(uiPackageJson.scripts.typecheck).toBe(
      "../../node_modules/.bin/tsc --noEmit -p tsconfig.json",
    );
    expect(uiPackageJson.scripts.test).toBe("cd ../.. && bun test apps/dashboard/tests");

    const rootUiSourceGlob = ["apps", "dashboard", "src", "**", "*"].join("/");
    const rootUiTsGlob = ["apps", "dashboard", "src", "**", "*.ts"].join("/");
    const rootUiTsxGlob = ["apps", "dashboard", "src", "**", "*.tsx"].join("/");
    const rootUiTestTsGlob = ["apps", "dashboard", "tests", "**", "*.ts"].join("/");
    const rootUiTestTsxGlob = ["apps", "dashboard", "tests", "**", "*.tsx"].join("/");

    expect(tsconfig.exclude ?? []).toContain("apps/dashboard/**");
    expect(tsconfig.compilerOptions.paths["@/*"]).toContain(
      "apps/dashboard/src/*",
    );
    expect(tsconfig.include).not.toContain(rootUiTsGlob);
    expect(tsconfig.include).not.toContain(rootUiTsxGlob);
    expect(tsconfig.include).not.toContain(rootUiTestTsGlob);
    expect(tsconfig.include).not.toContain(rootUiTestTsxGlob);
    expect(uiTsconfig.extends).toBe("../../tsconfig.base.json");
    expect(uiTsconfig.compilerOptions.baseUrl).toBe(".");
    expect(uiTsconfig.compilerOptions.paths["@/*"]).toContain(
      "src/*",
    );
    expect(uiTsconfig.include).toContain("src/app/tasks/**/*.tsx");
    expect(uiTsconfig.include).toContain("src/app/sessions/**/*.tsx");
    expect(uiTsconfig.include).toContain("src/app/users/**/*.tsx");
    expect(uiTsconfig.include).not.toContain("src/app/capabilities/**/*.tsx");
    expect(uiTsconfig.include).toContain("src/app/knowledge/**/*.tsx");
    expect(uiTsconfig.include).toContain("src/app/groups/**/*.tsx");
    expect(uiTsconfig.include).toContain("src/routeTree.gen.ts");
    expect(uiTsconfig.include).toContain("src/components/app-sidebar.tsx");
    expect(uiTsconfig.include).toContain("src/lib/**/*.ts");
    expect(uiTsconfig.include).toContain("src/types/**/*.ts");
    expect(uiTsconfig.include).not.toContain("src/**/*.tsx");
    expect(uiTsconfig.include).not.toContain("tests/**/*.tsx");

    const agentMain = readFileSync("apps/dashboard/src/main.tsx", "utf-8");
    expect(agentMain).toContain('basepath: "/agent"');
    const packageJsonText = readFileSync("package.json", "utf-8");
    expect(packageJsonText).toContain("@tailwindcss/cli");
    expect(packageJsonText).toContain("tailwindcss");
  });
});

interface DashboardTaskFixture {
  id: string;
  type: string;
  status: string;
  priority: string | null;
  severity: string | null;
  title: string;
  summary: string | null;
  creatorUserId: string | null;
  creatorUser: DashboardCanonicalUserFixture | null;
  participants: Array<{
    userId: string;
    role: string;
    user: DashboardCanonicalUserFixture | null;
  }>;
  linked_session_count: number;
  linked_sessions: Array<{
    id: string;
    title: string | null;
    display_title: string;
    displayTitle: string;
    channel_type: string;
    channel_id: string;
    group_id: string | null;
    thread_id: string | null;
  }>;
  linkedSessions: Array<{
    id: string;
    title: string | null;
    channelType: string;
  }>;
  taskContext: unknown;
  contextPacks: DashboardContextPack[];
  seedRecords: DashboardRunnerContextSeedRecord[];
  runContextSummaries: DashboardTaskRunContextSummary[];
  sourceMessages: Array<{
    sourceId: string;
    sessionId: string;
    createdAt: number;
    message: DashboardTaskContextMessageFixture;
  }>;
  sourceTurnMessages: Array<{
    turnId: string;
    turnRole: string;
    sessionId: string;
    message: DashboardTaskContextMessageFixture;
  }>;
  timeline: DashboardTimelineFixture[];
  runs: DashboardTaskRunFixture[];
  artifacts: DashboardArtifactFixture[];
  subscriptions: Array<{
    id: string;
    task_id: string;
    session_id: string;
    channel_type: string;
    channel_id: string;
    group_id: string | null;
    thread_id: string | null;
    visibility: string;
    created_at: number;
    updated_at: number;
  }>;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
}

interface DashboardTaskContextMessageFixture {
  id: string;
  entryId: string;
  entryKind: string;
  session_id: string;
  sessionId: string;
  channel_message_key: string | null;
  channelMessageKey: string | null;
  role: string;
  contentKind: string;
  presentationKind: string;
  providerMessageType: string | null;
  content: unknown;
  senderUserId: string;
  senderUser: DashboardCanonicalUserFixture;
  created_at: number;
  createdAt: number;
}

interface DashboardSessionTurnFixture {
  id: string;
  status: string;
  messageIds: string[];
  latestMessageId: string;
  materializedPrompt: string | null;
  runnerAttempts: Array<{
    id: string;
    attemptKind: string;
    attemptIndex: number;
    status: string;
    runnerType: string;
    runnerSessionId: string | null;
    inputPrompt: string;
    rawOutput: string | null;
    rawOutputTruncated: boolean;
    parsedActionJson: unknown;
    parseErrorJson: unknown;
    repairSourceAttemptId: string | null;
    startedAt: number;
    completedAt: number | null;
  }>;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
}

interface DashboardTaskRunFixture {
  id: string;
  task_id: string;
  taskId: string;
  run_index: number;
  runIndex: number;
  status: string;
  reason: string;
  input_snapshot: unknown;
  inputSnapshot: unknown;
  materialized_prompt: string | null;
  materializedPrompt: string | null;
  contextPackIds: string[];
  contextPacks: DashboardContextPack[];
  hasMaterializedPrompt: boolean;
  seedRecords: DashboardRunnerContextSeedRecord[];
  runner_type: string;
  runnerType: string;
  runner_context_id: string | null;
  runnerContextId: string | null;
  source_message_id: string | null;
  sourceMessageId: string | null;
  started_at: number;
  startedAt: number;
  finished_at: number | null;
  finishedAt: number | null;
  cancel_reason: string | null;
  cancelReason: string | null;
  error: string | null;
  final_report_artifact_id: string | null;
  finalReportArtifactId: string | null;
}

interface DashboardTimelineFixture {
  id: string;
  task_id: string;
  session_id: string | null;
  message_id: string | null;
  type: string;
  summary: string;
  data: unknown;
  visibility: string;
  actor_user_id: string | null;
  actorUserId: string | null;
  actorUser: DashboardCanonicalUserFixture | null;
  taskRunId: string | null;
  runIndex: number | null;
  runReason: string | null;
  runnerType: string | null;
  created_at: number;
}

interface DashboardCanonicalUserFixture {
  id: string;
  kind: string;
  displayName: string;
  avatarUrl?: string | null;
  status?: string;
  profileSource?: string;
}

interface DashboardIdentityFixture {
  id: string;
  channel: { type: string; id: string };
  externalId: string;
  identityKind: string;
  displayName: string | null;
  avatarUrl: string | null;
  providerIds: Record<string, string>;
}

interface DashboardArtifactFixture {
  id: string;
  task_id: string;
  type: string;
  name: string;
  path: string | null;
  content: string | null;
  mime_type: string | null;
  mimeType: string | null;
  status: string;
  metadata: unknown;
  created_at: number;
  href: string | null;
}

interface TestAnchorNode {
  textContent: string | null;
  getAttribute(name: string): string | null;
}

interface TestElementNode extends TestAnchorNode {
  innerHTML: string;
  dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): TestElementNode | null;
}

interface TestDocumentNode {
  body: {
    textContent: string | null;
    appendChild(node: unknown): unknown;
  };
  documentElement: {
    textContent: string | null;
  };
  createElement(name: string): unknown;
  querySelector(selector: string): TestElementNode | null;
  querySelectorAll(selector: string): TestElementNode[];
}

interface TestWindowObject {
  document: TestDocumentNode;
  Event: new (type: string, init?: Record<string, unknown>) => unknown;
}

function renderedMarkupText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function renderInteractiveTaskDetail(taskId = "task_1"): Promise<{
  text: () => string;
  query: (selector: string) => TestElementNode | null;
  artifactLinks: () => Array<{ text: string; href: string | null }>;
  selectedTabText: () => string;
  clickTab: (label: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  cleanup: () => void;
}> {
  const [taskDetail, timeline, artifacts] = await Promise.all([
    getJson<DashboardTaskFixture>(`/api/tasks/${taskId}`),
    getJson<DashboardTimelineFixture[]>(`/api/tasks/${taskId}/timeline`),
    getJson<DashboardArtifactFixture[]>(`/api/tasks/${taskId}/artifacts`),
  ]);
  return renderInteractiveTaskDetailFromData({ taskDetail, timeline, artifacts });
}

async function renderInteractiveTaskDetailFromData(input: {
  taskDetail: DashboardTaskFixture;
  timeline: DashboardTimelineFixture[];
  artifacts: DashboardArtifactFixture[];
}): Promise<{
  text: () => string;
  query: (selector: string) => TestElementNode | null;
  artifactLinks: () => Array<{ text: string; href: string | null }>;
  selectedTabText: () => string;
  clickTab: (label: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  cleanup: () => void;
}> {
  const { taskDetail, timeline, artifacts } = input;
  const { document, window } = parseHTML(
    "<!doctype html><html><body></body></html>",
  ) as unknown as { document: TestDocumentNode; window: TestWindowObject };
  (window as unknown as { location?: { href: string } }).location ??= {
    href: "http://localhost",
  };
  (globalThis as Record<string, unknown>).window = window;
  (globalThis as Record<string, unknown>).document = document;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as never);
  root.render(
    createElement(TaskDetailView, {
      taskDetail,
      runs: taskDetail.runs,
      timeline,
      artifacts,
      loading: {
        taskDetail: false,
        runs: false,
        timeline: false,
        artifacts: false,
      },
    }),
  );
  await flushReact();

  return {
    text: () => document.body.textContent ?? "",
    query: (selector: string) => document.querySelector(selector),
    artifactLinks: () =>
      Array.from(
        document.querySelectorAll('[data-testid="task-artifact-link"]'),
      ).map((node) => ({
        text: node.textContent ?? "",
        href: node.getAttribute("href"),
      })),
    selectedTabText: () =>
      document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent ?? "",
    clickTab: async (label: string) => {
      const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
        (node) => node.textContent === label,
      );
      expect(tab).toBeTruthy();
      tab!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
    },
    click: async (selector: string) => {
      const element = document.querySelector(selector);
      expect(element).toBeTruthy();
      element!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
    },
    cleanup: () => {
      root.unmount();
    },
  };
}

async function renderInteractiveSessionDetail(sessionId: string): Promise<{
  text: () => string;
  query: (selector: string) => TestElementNode | null;
  click: (selector: string) => Promise<void>;
  cleanup: () => void;
}> {
  const [sessions, timeline] = await Promise.all([
    getJson<DashboardSession[]>("/api/sessions"),
    getJson<DashboardSessionTimelineItem[]>(`/api/sessions/${sessionId}/timeline`),
  ]);
  const session = sessions.find((item) => item.id === sessionId);
  const { document, window } = parseHTML(
    "<!doctype html><html><body></body></html>",
  ) as unknown as { document: TestDocumentNode; window: TestWindowObject };
  (window as unknown as { location?: { href: string } }).location ??= {
    href: "http://localhost",
  };
  (globalThis as Record<string, unknown>).window = window;
  (globalThis as Record<string, unknown>).document = document;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as never);
  root.render(
    createElement(SessionDetailView, {
      sessionId,
      session,
      timeline,
      loading: false,
      error: null,
      showNotFound: false,

    }),
  );
  await flushReact();

  return {
    text: () => document.body.textContent ?? "",
    query: (selector: string) => document.querySelector(selector),
    click: async (selector: string) => {
      const element = document.querySelector(selector);
      expect(element).toBeTruthy();
      element!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
    },
    cleanup: () => {
      root.unmount();
    },
  };
}

async function renderInteractivePluginDetail(element: ReturnType<typeof createElement>): Promise<{
  text: () => string;
  query: (selector: string) => TestElementNode | null;
  click: (selector: string) => Promise<void>;
  cleanup: () => void;
}> {
  const { document, window } = parseHTML(
    "<!doctype html><html><body></body></html>",
  ) as unknown as { document: TestDocumentNode; window: TestWindowObject };
  (window as unknown as { location?: { href: string } }).location ??= {
    href: "http://localhost",
  };
  (globalThis as Record<string, unknown>).window = window;
  (globalThis as Record<string, unknown>).document = document;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as never);
  root.render(element);
  await flushReact();

  return {
    text: () => document.body.textContent ?? "",
    query: (selector: string) => document.querySelector(selector),
    click: async (selector: string) => {
      const node = document.querySelector(selector);
      expect(node).toBeTruthy();
      node!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
    },
    cleanup: () => {
      root.unmount();
    },
  };
}

function pluginDetailWithVersions(): DashboardPluginDetail {
  return {
    id: "echo",
    displayName: "Echo",
    version: "0.1.0",
    source: "marketplace",
    status: "enabled",
    requestedHostPermissions: [],
    operations: [
      {
        id: "echo.old",
        title: "Old Echo",
        description: "old operation",
      },
    ],
    commands: [],
    tools: [],
    skills: [],
    installation: {
      pluginId: "echo",
      desiredState: "enabled",
      desiredVersion: "0.1.0",
      activeState: "enabled",
      activeVersion: "0.1.0",
      pendingAction: "none",
    },
    marketplaceVersions: [
      {
        id: "trusted:echo:0.1.0",
        marketplaceId: "trusted",
        pluginId: "echo",
        version: "0.1.0",
        releasePath: "plugins/echo/release/0.1.0",
        manifestSha256: "a",
        pluginJsSha256: "b",
        releaseSha256: "c",
        lunaApiVersion: "^0.1.0",
        validationStatus: "valid",
        discoveredAt: now,
        manifest: {
          id: "echo",
          displayName: "Echo",
          version: "0.1.0",
          source: "marketplace",
          requestedHostPermissions: [],
          operations: [
            {
              id: "echo.old",
              title: "Old Echo",
              description: "old operation",
            },
          ],
          commands: [],
          tools: [],
          skills: [],
        },
      },
      {
        id: "trusted:echo:0.2.0",
        marketplaceId: "trusted",
        pluginId: "echo",
        version: "0.2.0",
        releasePath: "plugins/echo/release/0.2.0",
        manifestSha256: "a2",
        pluginJsSha256: "b2",
        releaseSha256: "c2",
        lunaApiVersion: "^0.1.0",
        validationStatus: "valid",
        discoveredAt: now,
        manifest: {
          id: "echo",
          displayName: "Echo",
          version: "0.2.0",
          source: "marketplace",
          requestedHostPermissions: [],
          operations: [
            {
              id: "echo.new",
              title: "New Echo",
              description: "new operation",
            },
          ],
          commands: [
            {
              path: ["echo", "new"],
              operationId: "echo.new",
            },
          ],
          tools: [],
          skills: [],
        },
      },
    ],
  };
}

async function flushReact(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fixtureUrl(path: string): URL {
  const url = new URL(path, "http://luna.test");
  if (url.pathname === "/api/sessions" || url.pathname === "/api/tasks") {
    url.searchParams.set("agentId", fixtureAgentId);
  }
  return url;
}

type FixtureValue = string | number | null;

function insertFixtureSessions(db: Database, values: readonly FixtureValue[]): void {
  const width = 10;
  for (let offset = 0; offset < values.length; offset += width) {
    const row = values.slice(offset, offset + width);
    const channelType = row[2];
    const channelId = row[3];
    if (typeof channelType !== "string" || typeof channelId !== "string") {
      throw new Error("Fixture session requires a channel");
    }
    const scope = fixtureSessionOwnership(connection.db, channelType, channelId, fixtureOwnerId);
    db.run(`INSERT INTO sessions
      (id, surface_key, channel_type, channel_id, group_id, thread_key, root_message_key, title,
       created_at, updated_at, agent_id, shadow_id, binding_id, bot_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...row, scope.agent_id, scope.shadow_id, scope.binding_id, scope.bot_user_id]);
  }
}

function insertFixtureOwnedRows(
  db: Database,
  table: "tasks" | "managed_artifacts",
  columns: string,
  values: readonly FixtureValue[],
): void {
  const width = columns.split(",").length;
  const placeholders = Array<string>(width + 2).fill("?").join(", ");
  for (let offset = 0; offset < values.length; offset += width) {
    const row = values.slice(offset, offset + width);
    const ownerTable = table === "managed_artifacts" && row[1] === "task" ? "tasks" : "sessions";
    const ownerId = table === "tasks" ? row[8] : row[2];
    const scope = db.query<{ agent_id: string; shadow_id: string }, [FixtureValue]>(
      `SELECT agent_id, shadow_id FROM ${ownerTable} WHERE id = ?`,
    ).get(ownerId ?? null);
    if (!scope) throw new Error(`Fixture owner not found: ${ownerId}`);
    db.run(`INSERT INTO ${table} (${columns}, agent_id, shadow_id) VALUES (${placeholders})`,
      [...row, scope.agent_id, scope.shadow_id]);
  }
}

function installDashboardFixtureWriteShim(db: Database): void {
  db.run(`
    CREATE TABLE fixture_messages (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      channel_message_key text,
      sender_user_id text,
      role text NOT NULL,
      content_kind text DEFAULT 'text',
      presentation_kind text DEFAULT 'plain',
      provider_message_type text DEFAULT 'text',
      content_json text NOT NULL,
      raw_payload_json text,
      created_at integer NOT NULL
    )
  `);
  db.run(`
    CREATE TRIGGER fixture_messages_fixture_insert
    AFTER INSERT ON fixture_messages
    BEGIN
      INSERT OR IGNORE INTO users
        (id, agent_id, kind, display_name, avatar_url, status, merged_into_user_id, profile_source, created_at, updated_at)
      SELECT
        id,
        (SELECT agent_id FROM sessions WHERE id = NEW.session_id),
        CASE WHEN identity_kind = 'bot' THEN 'bot' ELSE 'human' END,
        COALESCE(display_name, external_id),
        avatar_url,
        'active',
        NULL,
        'channel',
        CAST(NEW.created_at AS TEXT),
        CAST(NEW.created_at AS TEXT)
      FROM channel_identities
      WHERE channel_type = (SELECT channel_type FROM sessions WHERE id = NEW.session_id)
        AND channel_id = (SELECT channel_id FROM sessions WHERE id = NEW.session_id)
        AND external_id = NEW.sender_user_id;

      INSERT OR IGNORE INTO messages
        (id, channel_type, channel_id, external_message_id, sender_user_id, sender_identity_id, role, content_kind, presentation_kind, provider_message_type, content_json, raw_payload_json, occurred_at, created_at, agent_id, shadow_id, binding_id)
      VALUES (
        NEW.id,
        (SELECT channel_type FROM sessions WHERE id = NEW.session_id),
        (SELECT channel_id FROM sessions WHERE id = NEW.session_id),
        COALESCE(NEW.channel_message_key, NEW.id),
        COALESCE(
          (SELECT id FROM users WHERE id = NEW.sender_user_id LIMIT 1),
          (
            SELECT user_id FROM channel_user_bindings
            WHERE channel_identity_id = (
              SELECT id FROM channel_identities
              WHERE channel_type = (SELECT channel_type FROM sessions WHERE id = NEW.session_id)
                AND channel_id = (SELECT channel_id FROM sessions WHERE id = NEW.session_id)
                AND external_id = NEW.sender_user_id
              LIMIT 1
            )
            LIMIT 1
          ),
          (
            SELECT id FROM channel_identities
            WHERE channel_type = (SELECT channel_type FROM sessions WHERE id = NEW.session_id)
              AND channel_id = (SELECT channel_id FROM sessions WHERE id = NEW.session_id)
              AND external_id = NEW.sender_user_id
            LIMIT 1
          ),
          CASE
            WHEN NEW.sender_user_id IS NULL AND NEW.role = 'assistant'
              THEN 'directory-identity-luna-bot'
            WHEN NEW.sender_user_id IS NULL
              THEN 'directory-user-requester'
            ELSE NULL
          END
        ),
        (SELECT id FROM channel_identities
          WHERE channel_type = (SELECT channel_type FROM sessions WHERE id = NEW.session_id)
            AND channel_id = (SELECT channel_id FROM sessions WHERE id = NEW.session_id)
            AND external_id = NEW.sender_user_id
          LIMIT 1),
        NEW.role,
        COALESCE(NEW.content_kind, 'text'),
        COALESCE(NEW.presentation_kind, 'plain'),
        COALESCE(NEW.provider_message_type, 'text'),
        json(NEW.content_json),
        CASE WHEN NEW.raw_payload_json IS NULL THEN NULL ELSE json(NEW.raw_payload_json) END,
        NEW.created_at,
        NEW.created_at,
        (SELECT agent_id FROM sessions WHERE id = NEW.session_id),
        (SELECT shadow_id FROM sessions WHERE id = NEW.session_id),
        (SELECT binding_id FROM sessions WHERE id = NEW.session_id)
      );
      INSERT OR IGNORE INTO session_timeline_entries
        (id, session_id, message_id, entry_kind, created_at)
      VALUES (
        'fixture-entry-' || NEW.session_id || '-' || NEW.id,
        NEW.session_id,
        NEW.id,
        'message',
        NEW.created_at
      );
    END
  `);
  db.run(`
    CREATE TRIGGER fixture_messages_fixture_delete
    AFTER DELETE ON fixture_messages
    BEGIN
      DELETE FROM message_mentions WHERE message_id = OLD.id;
      DELETE FROM session_turn_entries
        WHERE entry_id IN (SELECT id FROM session_timeline_entries WHERE message_id = OLD.id);
      DELETE FROM session_timeline_entries WHERE message_id = OLD.id;
      DELETE FROM messages WHERE id = OLD.id;
    END
  `);
  db.run(`
    CREATE TABLE fixture_message_refs (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      message_id text NOT NULL,
      source_session_id text NOT NULL,
      relation text NOT NULL,
      include_in_context integer NOT NULL,
      created_at integer NOT NULL
    )
  `);
  db.run(`
    CREATE TRIGGER fixture_message_refs_fixture_insert
    AFTER INSERT ON fixture_message_refs
    BEGIN
      INSERT OR IGNORE INTO session_timeline_entries
        (id, session_id, message_id, entry_kind, created_at)
      VALUES (NEW.id, NEW.session_id, NEW.message_id, 'reference', NEW.created_at);
    END
  `);
  db.run(`
    CREATE TRIGGER fixture_message_refs_fixture_delete
    AFTER DELETE ON fixture_message_refs
    BEGIN
      DELETE FROM session_timeline_entries WHERE id = OLD.id;
    END
  `);
  db.run(`
    CREATE TABLE fixture_message_mentions (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      message_id text NOT NULL,
      mention_key text NOT NULL,
      mention_label text NOT NULL,
      target_identity_id text,
      target_external_id text NOT NULL,
      target_kind text NOT NULL,
      raw_mention_json text,
      created_at text NOT NULL
    )
  `);
  db.run(`
    CREATE TRIGGER fixture_message_mentions_fixture_insert
    AFTER INSERT ON fixture_message_mentions
    BEGIN
      INSERT OR IGNORE INTO message_mentions
        (id, message_id, mention_key, mention_label, target_identity_id, target_external_id, target_kind, raw_mention_json, created_at)
      VALUES (
        NEW.id,
        NEW.message_id,
        NEW.mention_key,
        NEW.mention_label,
        NEW.target_identity_id,
        NEW.target_external_id,
        NEW.target_kind,
        NEW.raw_mention_json,
        CAST(NEW.created_at AS integer)
      );
    END
  `);
  db.run(`
    CREATE TRIGGER fixture_message_mentions_fixture_delete
    AFTER DELETE ON fixture_message_mentions
    BEGIN
      DELETE FROM message_mentions WHERE id = OLD.id;
    END
  `);
  db.run("ALTER TABLE session_turns ADD COLUMN message_ids text");
  db.run("ALTER TABLE session_turns ADD COLUMN inbox_ids text");
  db.run("ALTER TABLE session_turns ADD COLUMN latest_message_id text");
  db.run("ALTER TABLE session_turns ADD COLUMN latest_channel_message_key text");
  db.run(`ALTER TABLE session_turns ADD COLUMN ${senderColumn} text`);
  db.run("ALTER TABLE session_turns ADD COLUMN action_marker_id text");
  db.run(`
    CREATE TRIGGER session_turns_fixture_message_ids_update
    AFTER UPDATE OF message_ids ON session_turns
    WHEN NEW.message_ids IS NOT NULL AND json_valid(NEW.message_ids)
    BEGIN
      DELETE FROM session_turn_entries WHERE turn_id = NEW.id;
      INSERT INTO session_turn_entries
        (id, turn_id, session_id, entry_id, role, created_at)
      SELECT
        'fixture-turn-entry-' || NEW.id || '-' || each.value,
        NEW.id,
        NEW.session_id,
        entries.id,
        CASE WHEN CAST(each.key AS integer) = 0 THEN 'trigger' ELSE 'coalesced_input' END,
        COALESCE(NEW.updated_at, NEW.started_at) + CAST(each.key AS integer)
      FROM json_each(NEW.message_ids) AS each
      JOIN session_timeline_entries AS entries
        ON entries.session_id = NEW.session_id
       AND entries.message_id = each.value;
    END
  `);
}

function insertCanonicalUserFixture(
  db: Database,
  input: {
    readonly userId: string;
    readonly channelIdentityId: string;
    readonly kind: "human" | "bot";
    readonly displayName: string;
    readonly avatarUrl?: string | null;
    readonly identityValue: string;
    readonly identityKind?: string;
    readonly identityScope?: string;
    readonly createdAt: number;
  },
): void {
  db.run(
    `INSERT OR IGNORE INTO users
      (id, agent_id, kind, display_name, avatar_url, status, merged_into_user_id, profile_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      fixtureAgentId,
      input.kind,
      input.displayName,
      input.avatarUrl ?? null,
      "active",
      null,
      "channel",
      String(input.createdAt),
      String(input.createdAt),
    ],
  );
  const claimId = `link-${input.userId}-${input.identityKind ?? "open_id"}`;
  db.run(
    `INSERT OR IGNORE INTO user_identity_links
      (id, agent_id, user_id, identity_namespace, identity_kind, identity_value, identity_scope, confidence, is_primary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      claimId,
      fixtureAgentId,
      input.userId,
      "lark",
      input.identityKind ?? "open_id",
      input.identityValue,
      input.identityScope ?? "",
      "verified",
      1,
      String(input.createdAt),
      String(input.createdAt),
    ],
  );
  db.run(`INSERT OR IGNORE INTO channel_user_bindings (channel_identity_id, user_id, created_at)
    VALUES (?, ?, ?)`, [input.channelIdentityId, input.userId, input.createdAt]);
  db.run(`INSERT OR IGNORE INTO identity_observations (claim_id, channel_identity_id, confidence, observed_at)
    VALUES (?, ?, 'verified', ?)`, [claimId, input.channelIdentityId, input.createdAt]);
}

function seedLunaFixture(db: Database, homePath: string): void {
  insertFixtureSessions(db, [
    "conv-primary",
    "feishu:chat:group-playback:thread-1",
    "feishu",
    "chat",
    "group-playback",
    "thread-1",
    "root-1",
    "Playback investigation thread",
    now,
    now + 4_000,
    "conv-secondary",
    "feishu:chat:group-ops:thread-9",
    "feishu",
    "chat",
    "group-ops",
    "thread-9",
    "root-9",
    "Ops escalation",
    now + 2_000,
    now + 3_000,
  ]);

  db.run(
    `INSERT INTO channel_identities
      (id, channel_type, channel_id, external_id, identity_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "directory-user-wrong-channel",
      "feishu",
      "other-chat",
      "ou_requester",
      "user",
      "错误频道用户",
      "https://avatar.example/ou_wrong.png",
      JSON.stringify({ providerAccountId: "user_wrong" }),
      JSON.stringify({ source: "wrong-channel-fixture" }),
      now,
      now + 4_000,
      now + 4_000,
      now,
      now + 4_000,
      "directory-user-requester",
      "feishu",
      "chat",
      "ou_requester",
      "user",
      "示例用户",
      "https://avatar.example/ou_requester.png",
      JSON.stringify({ providerAccountId: "user_requester" }),
      JSON.stringify({ source: "fixture" }),
      now,
      now + 4_000,
      now + 4_000,
      now,
      now + 4_000,
      "directory-identity-luna-bot",
      "feishu",
      "chat",
      "ou_luna_bot",
      "bot",
      "Monkey King",
      "https://avatar.example/luna.png",
      JSON.stringify({ providerBotId: "bot_luna" }),
      JSON.stringify({ source: "fixture" }),
      now,
      now + 4_000,
      now + 4_000,
      now,
      now + 4_000,
    ],
  );
  insertCanonicalUserFixture(db, {
    userId: "directory-user-requester",
    channelIdentityId: "directory-user-requester",
    kind: "human",
    displayName: "示例用户",
    avatarUrl: "https://avatar.example/ou_requester.png",
    identityValue: "ou_requester",
    createdAt: now,
  });
  insertCanonicalUserFixture(db, {
    userId: "directory-identity-luna-bot",
    channelIdentityId: "directory-identity-luna-bot",
    kind: "bot",
    displayName: "Monkey King",
    avatarUrl: "https://avatar.example/luna.png",
    identityValue: "ou_luna_bot",
    createdAt: now,
  });

  db.run(
    `INSERT INTO channel_surfaces
      (id, channel_type, channel_id, external_id, surface_kind, display_name, avatar_url, provider_ids_json, raw_profile_json, first_seen_at, last_seen_at, profile_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "directory-chat-playback",
      "feishu",
      "chat",
      "group-playback",
      "group",
      "播放排查群",
      "https://avatar.example/group-playback.png",
      JSON.stringify({ providerSurfaceId: "group-playback" }),
      JSON.stringify({ source: "fixture" }),
      now,
      now + 4_000,
      now + 4_000,
      now,
      now + 4_000,
    ],
  );

  insertFixtureMessage(db, {
    id: "msg-user-1",
    sessionId: "conv-primary",
    channelMessageKey: "m-1",
    senderUserId: "ou_requester",
    role: "user",
    content: [{ type: "text", text: "Playback is failing for EU users" }],
    rawPayload: { text: "Playback is failing for EU users" },
    createdAt: now,
  });
  insertFixtureMessage(db, {
    id: "msg-assistant-1",
    sessionId: "conv-primary",
    channelMessageKey: "m-2",
    senderUserId: "ou_luna_bot",
    role: "assistant",
    content: [{ type: "text", text: "I am checking the evidence." }],
    rawPayload: { text: "I am checking the evidence." },
    createdAt: now + 1_000,
  });
  insertFixtureMessage(db, {
    id: "msg-user-2",
    sessionId: "conv-primary",
    channelMessageKey: "m-3",
    senderUserId: "ou_requester",
    role: "user",
    content: [{ type: "text", text: "Please include raw logs." }],
    rawPayload: { raw: "RAW_RUNNER_LOG_LINE should remain artifact-only" },
    createdAt: now + 2_000,
  });
  insertFixtureMessage(db, {
    id: "msg-action-marker",
    sessionId: "conv-primary",
    channelMessageKey: "main-runner-action:conv-primary:marker:selected",
    senderUserId: null,
    role: "assistant",
    content: [],
    rawPayload: { origin: "main_runner_action_marker" },
    createdAt: now + 3_000,
    contentKind: "unknown",
    presentationKind: "unknown",
  });
  insertFixtureMessage(db, {
    id: "msg-reply-marker",
    sessionId: "conv-primary",
    channelMessageKey: "main-runner-action:conv-primary:reply:sent",
    senderUserId: null,
    role: "assistant",
    content: [],
    rawPayload: { origin: "main_runner_action_reply_marker" },
    createdAt: now + 4_000,
    contentKind: "unknown",
    presentationKind: "unknown",
  });
  insertFixtureTimelineEntry(db, {
    id: "ref-projected-anchor",
    sessionId: "conv-secondary",
    messageId: "msg-user-1",
    entryKind: "reference",
    createdAt: now + 5_000,
  });
  insertFixtureTimelineEntry(db, {
    id: "ref-projected-starter",
    sessionId: "conv-secondary",
    messageId: "msg-user-2",
    entryKind: "reference",
    createdAt: now + 6_000,
  });

  db.run(
    `INSERT INTO session_turns
      (id, session_id, turn_kind, status, runner_invoked, reason, started_at, completed_at, error, created_at, updated_at, materialized_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "turn-batch-1",
      "conv-primary",
      "execution",
      "completed",
      1,
      "addressed",
      now + 2_500,
      now + 3_500,
      null,
      now + 2_500,
      now + 3_500,
      "# Luna Main Runner Turn Input\n\nPlayback is failing for EU users",
    ],
  );
  db.run(
    `INSERT INTO session_runner_attempts
      (id, session_id, turn_id, runner_context_id, runner_type, runner_session_id, attempt_kind, attempt_index, status, input_prompt, raw_output, raw_output_truncated, parsed_action_json, parse_error_json, repair_source_attempt_id, started_at, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "attempt-primary-1",
      "conv-primary",
      "turn-batch-1",
      "runner-context-dashboard",
      "mock",
      "runner-session-dashboard",
      "primary",
      0,
      "parse_failed",
      "# Luna Main Runner Turn Input\n\nPlayback is failing for EU users",
      "I created a task for this playback issue.",
      0,
      null,
      JSON.stringify({
        code: "main_runner.no_json_object",
        message: "Main Runner did not return a JSON object.",
      }),
      null,
      now + 2_600,
      now + 2_700,
      now + 2_600,
      now + 2_700,
      "attempt-repair-1",
      "conv-primary",
      "turn-batch-1",
      "runner-context-dashboard",
      "mock",
      "runner-session-repair",
      "repair",
      1,
      "parsed",
      "# Luna Main Runner Output Repair\n\nRepair invalid output",
      JSON.stringify({
        action: "create_task_and_dispatch",
        taskType: "task",
        title: "Playback failure investigation",
        summary: "Playback is failing for EU users.",
        facts: ["Playback is failing for EU users"],
        dispatchReply: "I created a task for this playback issue.",
        reason: "repaired invalid natural-language output",
      }),
      0,
      JSON.stringify({ action: "create_task_and_dispatch" }),
      null,
      "attempt-primary-1",
      now + 2_800,
      now + 2_900,
      now + 2_800,
      now + 2_900,
    ],
  );
  insertFixtureTurnEntry(db, {
    id: "turn-entry-user-1",
    turnId: "turn-batch-1",
    sessionId: "conv-primary",
    entryId: "entry-conv-primary-msg-user-1-message",
    role: "trigger",
    createdAt: now + 2_501,
  });
  insertFixtureTurnEntry(db, {
    id: "turn-entry-user-2",
    turnId: "turn-batch-1",
    sessionId: "conv-primary",
    entryId: "entry-conv-primary-msg-user-2-message",
    role: "coalesced_input",
    createdAt: now + 2_502,
  });
  insertFixtureTurnEntry(db, {
    id: "turn-entry-assistant-1-launch-context",
    turnId: "turn-batch-1",
    sessionId: "conv-primary",
    entryId: "entry-conv-primary-msg-assistant-1-message",
    role: "launch_context",
    createdAt: now + 2_503,
  });

  insertFixtureOwnedRows(db, "tasks", "id, type, status, priority, severity, title, summary, creator_user_id, primary_session_id, source_message_id, source_entry_id, created_at, updated_at, last_activity_at", [
    "task_1",
    "investigation",
    "running",
    "high",
    "sev2",
    "Playback failure investigation",
    "Report: CDN regression suspected in EU edge POPs.",
    "directory-user-requester",
    "conv-primary",
    "msg-user-1",
    "entry-conv-primary-msg-user-1-message",
    now,
    now + 4_000,
    now + 4_000,
  ]);

  insertFixtureTaskSourceContextPack(db, {
    packId: "source-primary-pack",
    taskId: "task_1",
    sessionId: "conv-primary",
    messageId: "msg-user-1",
    sourceEntryId: "entry-conv-primary-msg-user-1-message",
    userId: null,
    createdAt: now,
    items: [
      { id: "source-primary", messageId: "msg-user-1" },
      {
        id: "source-stale",
        sessionId: "conv-missing",
        sourceEntryId: null,
        messageId: "msg-user-2",
      },
    ],
  });

  db.run(
    `INSERT INTO task_participants
      (id, task_id, user_id, role, created_at)
      VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    [
      "participant-requester",
      "task_1",
      "directory-user-requester",
      "requester",
      now,
      "participant-agent",
      "task_1",
      "directory-identity-luna-bot",
      "agent",
      now,
    ],
  );

  db.run(
    `INSERT INTO task_subscriptions
      (id, task_id, session_id, channel_type, channel_id, group_id, thread_key, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "subscription-primary",
      "task_1",
      "conv-primary",
      "feishu",
      "chat",
      "group-playback",
      "thread-1",
      "full",
      now,
      now + 4_000,
      "subscription-secondary",
      "task_1",
      "conv-secondary",
      "feishu",
      "chat",
      "group-ops",
      "thread-9",
      "summary",
      now,
      now + 4_000,
    ],
  );

  db.run(
    `INSERT INTO task_runs
      (id, task_id, run_index, status, reason, input_snapshot, materialized_prompt, runner_type, runner_context_id, source_message_id, started_at, finished_at, cancel_reason, error, final_report_artifact_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "task-run-1",
      "task_1",
      1,
      "completed",
      "initial",
      JSON.stringify({
        prompt: longRunInputPrompt,
        evidenceWindow: "2026-05-30T08:00:00Z/2026-05-30T10:00:00Z",
        evidencePath: join(homePath, "workspace", "uploads", "images", "evidence.jpeg"),
        contextPackIds: ["source-primary-pack"],
      }),
      null,
      "mock",
      "runner-context-1",
      "msg-user-1",
      now + 1_000,
      now + 4_000,
      null,
      null,
      "artifact-report",
    ],
  );

  insertFixtureSessionContextPack(db, {
    packId: "session-group-activation-pack",
    sessionId: "conv-primary",
    kind: "group_activation",
    selectionStrategy: "deterministic_window",
    triggerEntryId: "entry-conv-primary-msg-user-2-message",
    triggerMessageId: "msg-user-2",
    createdAt: now + 2_100,
    items: [
      {
        id: "session-group-activation-item",
        itemKind: "message",
        itemId: "msg-user-1",
        sourceSessionId: "conv-primary",
        sourceEntryId: "entry-conv-primary-msg-user-1-message",
        sourceMessageId: "msg-user-1",
        role: "delta_context",
        reason: "recent silent group context",
      },
    ],
  });

  insertFixtureSessionContextPack(db, {
    packId: "session-thread-launch-pack",
    sessionId: "conv-secondary",
    kind: "thread_launch",
    selectionStrategy: "anchor_turn",
    triggerEntryId: "ref-projected-anchor",
    triggerMessageId: "msg-user-1",
    createdAt: now + 6_100,
    items: [
      {
        id: "session-thread-launch-anchor-item",
        itemKind: "timeline_entry",
        itemId: "ref-projected-anchor",
        sourceSessionId: "conv-primary",
        sourceEntryId: "entry-conv-primary-msg-user-1-message",
        sourceMessageId: "msg-user-1",
        role: "launch_context",
        reason: "thread anchor context",
      },
      {
        id: "session-thread-launch-followup-item",
        itemKind: "timeline_entry",
        itemId: "ref-projected-starter",
        sourceSessionId: "conv-primary",
        sourceEntryId: "entry-conv-primary-msg-user-2-message",
        sourceMessageId: "msg-user-2",
        role: "launch_context",
        reason: "same root turn context",
      },
    ],
  });

  insertFixtureSeedRecord(db, {
    id: "seed-task-run-1-source-primary",
    runnerContextId: "runner-context-1",
    ownerType: "task",
    ownerId: "task_1",
    seedContextPackId: "source-primary-pack",
    seedHash: "seed-hash-task-1",
    seedEntryIds: ["entry-conv-primary-msg-user-1-message"],
    seedContextItemIds: ["source-primary"],
    createdAt: now + 1_500,
  });

  insertFixtureSeedRecord(db, {
    id: "seed-session-thread-launch",
    runnerContextId: "runner-context-session-thread",
    ownerType: "session",
    ownerId: "conv-secondary",
    seedContextPackId: "session-thread-launch-pack",
    seedHash: "seed-hash-thread-launch",
    seedEntryIds: [
      "entry-conv-primary-msg-user-1-message",
      "entry-conv-primary-msg-user-2-message",
    ],
    seedContextItemIds: [
      "session-thread-launch-anchor-item",
      "session-thread-launch-followup-item",
    ],
    createdAt: now + 6_200,
  });

  db.run(
    `INSERT INTO timeline_events
      (id, task_id, session_id, message_id, actor_user_id, type, summary, data, visibility, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "timeline-created",
      "task_1",
      "conv-primary",
      "msg-user-1",
      "directory-user-requester",
      "task_created",
      "Task created from playback report",
      JSON.stringify({ route: "investigation" }),
      "full",
      now,
      "timeline-report",
      "task_1",
      "conv-primary",
      "msg-assistant-1",
      "directory-identity-luna-bot",
      "runner_report",
      longTimelineSummary,
      JSON.stringify({
        artifact_id: "artifact-report",
        artifactIds: ["artifact-report"],
        operation: "media.playback.trace.query",
        requestId: "req_dashboard_trace",
        status: "success",
        taskRunId: "task-run-1",
        runIndex: 1,
        runReason: "initial",
        runnerType: "mock",
        sourcePath: join(homePath, "workspace", "uploads", "images", "evidence.jpeg"),
      }),
      "full",
      now + 4_000,
    ],
  );

  db.run(
    `INSERT INTO artifacts
      (id, task_id, timeline_event_id, type, name, mime_type, path, content, metadata, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "artifact-report",
      "task_1",
      "timeline-report",
      "report",
      "final-report.md",
      "text/markdown",
      join(homePath, "artifacts", "task_1", "final-report.md"),
      [
        "Report: CDN regression suspected in EU edge POPs.",
        "",
        markdownReportSection,
        "",
        longReportLine,
      ].join("\n"),
      JSON.stringify({ format: "markdown" }),
      "active",
      now + 3_000,
      "artifact-runner-log",
      "task_1",
      "timeline-report",
      "raw_runner_log",
      "raw-runner.log",
      "text/plain",
      join(homePath, "artifacts", "task_1", "raw-runner.log"),
      "RAW_RUNNER_LOG_LINE",
      JSON.stringify({ format: "text" }),
      "active",
      now + 3_500,
    ],
  );

  const managedTaskArtifactDir = join(homePath, "artifacts", "task_1");
  const managedImageArtifactDir = join(
    homePath,
    "artifacts",
    "task-image-context",
  );
  mkdirSync(managedTaskArtifactDir, { recursive: true });
  mkdirSync(managedImageArtifactDir, { recursive: true });
  writeFileSync(
    join(managedTaskArtifactDir, "final-report.md"),
    "fixture final report",
  );
  writeFileSync(
    join(managedTaskArtifactDir, "raw-runner.log"),
    "RAW_RUNNER_LOG_LINE",
  );
  writeFileSync(
    join(managedImageArtifactDir, "evidence.jpeg"),
    "fixture-image",
  );
  insertFixtureOwnedRows(db, "managed_artifacts", "id, scope_type, scope_id, related_user_id, producer, kind, name, mime_type, size_bytes, sha256, storage_backend, storage_key, status, retention_policy, retention_expires_at, created_at, deleted_at", [
    "artifact-report",
    "task",
    "task_1",
    "local-dashboard-user",
    "fixture",
    "report",
    "final-report.md",
    "text/markdown",
    "fixture final report".length,
    "fixture-report-sha",
    "local",
    join(managedTaskArtifactDir, "final-report.md"),
    "active",
    "task",
    null,
    now + 3_000,
    null,
    "artifact-runner-log",
    "task",
    "task_1",
    "local-dashboard-user",
    "fixture",
    "raw_runner_log",
    "raw-runner.log",
    "text/plain",
    "RAW_RUNNER_LOG_LINE".length,
    "fixture-runner-log-sha",
    "local",
    join(managedTaskArtifactDir, "raw-runner.log"),
    "active",
    "task",
    null,
    now + 3_500,
    null,
    "task-evidence-image",
    "session",
    "conv-primary",
    "local-dashboard-user",
    "fixture",
    "image",
    "evidence.jpeg",
    "image/jpeg",
    "fixture-image".length,
    "fixture-image-sha",
    "local",
    join(managedImageArtifactDir, "evidence.jpeg"),
    "active",
    "task",
    null,
    now + 20_000,
    null,
  ]);

}

function insertFixtureMessage(
  db: Database,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly channelMessageKey: string | null;
    readonly senderUserId: string | null;
    readonly role: string;
    readonly content: unknown;
    readonly rawPayload: unknown;
    readonly createdAt: number;
    readonly entryKind?: "message" | "reference";
    readonly contentKind?: string;
    readonly presentationKind?: string;
    readonly providerMessageType?: string | null;
  },
): void {
  const session = db
    .query<{
      channel_type: string;
      channel_id: string;
      agent_id: string;
      shadow_id: string;
      binding_id: string | null;
    }, [string]>(
      "SELECT channel_type, channel_id, agent_id, shadow_id, binding_id FROM sessions WHERE id = ?",
    )
    .get(input.sessionId);
  if (session === null) {
    throw new Error(`Fixture session not found: ${input.sessionId}`);
  }
  const identity = input.senderUserId === null
    ? null
    : db
        .query<{ id: string }, [string, string, string]>(
          `SELECT id FROM channel_identities
           WHERE channel_type = ? AND channel_id = ? AND external_id = ?`,
        )
        .get(session.channel_type, session.channel_id, input.senderUserId);
  const canonicalUserId = input.senderUserId === null
    ? (input.role === "assistant" ? "directory-identity-luna-bot" : "directory-user-requester")
    : db
        .query<{ id: string }, [string]>(
          "SELECT id FROM users WHERE id = ?",
        )
        .get(input.senderUserId)?.id ??
      (identity === null
        ? null
        : db
            .query<{ user_id: string }, [string]>(
              `SELECT user_id FROM channel_user_bindings
               WHERE channel_identity_id = ?`,
            )
            .get(identity.id)?.user_id ?? null);
  if (input.senderUserId !== null && canonicalUserId === null) {
    throw new Error(`Fixture canonical user not found: ${input.senderUserId}`);
  }
  db.run(
    `INSERT INTO messages
      (id, channel_type, channel_id, external_message_id, sender_user_id, sender_identity_id, role, content_kind, presentation_kind, provider_message_type, content_json, raw_payload_json, occurred_at, created_at, agent_id, shadow_id, binding_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      session.channel_type,
      session.channel_id,
      input.channelMessageKey ?? input.id,
      canonicalUserId,
      identity?.id ?? null,
      input.role,
      input.contentKind ?? "text",
      input.presentationKind ?? "plain",
      input.providerMessageType ?? "text",
      JSON.stringify(input.content),
      JSON.stringify(input.rawPayload),
      input.createdAt,
      input.createdAt,
      session.agent_id,
      session.shadow_id,
      session.binding_id,
    ],
  );
  insertFixtureTimelineEntry(db, {
    id: `entry-${input.sessionId}-${input.id}-${input.entryKind ?? "message"}`,
    sessionId: input.sessionId,
    messageId: input.id,
    entryKind: input.entryKind ?? "message",
    createdAt: input.createdAt,
  });
}

function insertFixtureTimelineEntry(
  db: Database,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly entryKind: "message" | "reference";
    readonly createdAt: number;
  },
): void {
  db.run(
    `INSERT INTO session_timeline_entries
      (id, session_id, message_id, entry_kind, created_at)
      VALUES (?, ?, ?, ?, ?)`,
    [
      input.id,
      input.sessionId,
      input.messageId,
      input.entryKind,
      input.createdAt,
    ],
  );
}

function insertFixtureTurnEntry(
  db: Database,
  input: {
    readonly id: string;
    readonly turnId: string;
    readonly sessionId: string;
    readonly entryId: string;
    readonly role: string;
    readonly createdAt: number;
  },
): void {
  db.run(
    `INSERT INTO session_turn_entries
      (id, turn_id, session_id, entry_id, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.turnId,
      input.sessionId,
      input.entryId,
      input.role,
      input.createdAt,
    ],
  );
}

function insertFixtureSessionTimelineEvent(
  db: Database,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly entryId: string;
    readonly eventType: string;
    readonly controlKind: string;
    readonly reasonKind: string;
    readonly sourceMessageId: string;
    readonly anchorMessageId: string;
    readonly sessionSourceMessageId: string;
    readonly turnId: string;
    readonly summary: string;
    readonly createdAt: number;
  },
): void {
  db.run(
    `INSERT INTO session_timeline_events
      (id, session_id, entry_id, event_type, control_kind, reason_kind, source_message_id, anchor_message_id, session_source_message_id, turn_id, summary, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.sessionId,
      input.entryId,
      input.eventType,
      input.controlKind,
      input.reasonKind,
      input.sourceMessageId,
      input.anchorMessageId,
      input.sessionSourceMessageId,
      input.turnId,
      input.summary,
      null,
      input.createdAt,
    ],
  );
}

function insertFixtureTaskSourceContextPack(
  db: Database,
  input: {
    readonly packId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly sourceEntryId: string | null;
    readonly userId: string | null;
    readonly createdAt: number;
    readonly items: readonly {
      readonly id: string;
      readonly sessionId?: string;
      readonly sourceEntryId?: string | null;
      readonly messageId: string;
      readonly userId?: string | null;
    }[];
  },
): void {
  db.run(
    `INSERT INTO context_packs
      (id, owner_type, owner_id, kind, selection_strategy, trigger_entry_id, trigger_message_id, created_for_invocation_id, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.packId,
      "task",
      input.taskId,
      "task_launch",
      "source_turn",
      input.sourceEntryId,
      input.messageId,
      null,
      input.createdAt,
      null,
    ],
  );

  input.items.forEach((item, index) => {
    const sessionId = item.sessionId ?? input.sessionId;
    const sourceEntryId = item.sourceEntryId === undefined
      ? input.sourceEntryId
      : item.sourceEntryId;
    db.run(
      `INSERT INTO context_pack_items
        (id, context_pack_id, item_kind, item_id, source_session_id, source_entry_id, source_message_id, source_identity_id, role, reason, display_order, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        input.packId,
        "message",
        item.messageId,
        sessionId,
        sourceEntryId,
        item.messageId,
        item.userId === undefined ? input.userId : item.userId,
        "source",
        "task source message",
        index,
        null,
      ],
    );
  });
}

function insertFixtureSessionContextPack(
  db: Database,
  input: {
    readonly packId: string;
    readonly sessionId: string;
    readonly kind: string;
    readonly selectionStrategy: string;
    readonly triggerEntryId: string | null;
    readonly triggerMessageId: string | null;
    readonly createdAt: number;
    readonly items: readonly {
      readonly id: string;
      readonly itemKind: string;
      readonly itemId: string;
      readonly sourceSessionId: string | null;
      readonly sourceEntryId: string | null;
      readonly sourceMessageId: string | null;
      readonly role: string;
      readonly reason: string;
    }[];
  },
): void {
  db.run(
    `INSERT INTO context_packs
      (id, owner_type, owner_id, kind, selection_strategy, trigger_entry_id, trigger_message_id, created_for_invocation_id, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.packId,
      "session",
      input.sessionId,
      input.kind,
      input.selectionStrategy,
      input.triggerEntryId,
      input.triggerMessageId,
      null,
      input.createdAt,
      null,
    ],
  );

  input.items.forEach((item, index) => {
    db.run(
      `INSERT INTO context_pack_items
        (id, context_pack_id, item_kind, item_id, source_session_id, source_entry_id, source_message_id, source_identity_id, role, reason, display_order, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        input.packId,
        item.itemKind,
        item.itemId,
        item.sourceSessionId,
        item.sourceEntryId,
        item.sourceMessageId,
        null,
        item.role,
        item.reason,
        index,
        null,
      ],
    );
  });
}

function insertFixtureSeedRecord(
  db: Database,
  input: {
    readonly id: string;
    readonly runnerContextId: string;
    readonly ownerType: "session" | "task";
    readonly ownerId: string;
    readonly seedContextPackId: string;
    readonly seedHash: string;
    readonly seedEntryIds: readonly string[];
    readonly seedContextItemIds: readonly string[];
    readonly createdAt: number;
  },
): void {
  db.run(
    `INSERT INTO runner_context_seed_records
      (id, runner_context_id, owner_type, owner_id, seed_context_pack_id, seed_hash, seed_entry_ids_json, seed_context_item_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.runnerContextId,
      input.ownerType,
      input.ownerId,
      input.seedContextPackId,
      input.seedHash,
      JSON.stringify(input.seedEntryIds),
      JSON.stringify(input.seedContextItemIds),
      input.createdAt,
    ],
  );
}

function deleteFixtureTaskSourceContextPacks(
  db: Database,
  taskIds: readonly string[],
): void {
  for (const taskId of taskIds) {
    db.run(
      `DELETE FROM context_pack_items
       WHERE context_pack_id IN (
         SELECT id FROM context_packs WHERE owner_type = ? AND owner_id = ?
       )`,
      ["task", taskId],
    );
    db.run(`DELETE FROM context_packs WHERE owner_type = ? AND owner_id = ?`, [
      "task",
      taskId,
    ]);
  }
}

function deleteFixtureMessages(db: Database, ids: readonly string[]): void {
  if (ids.length === 0) {
    return;
  }
  for (const id of ids) {
    db.run("DELETE FROM message_mentions WHERE message_id = ?", [id]);
    db.run("DELETE FROM session_turn_entries WHERE entry_id IN (SELECT id FROM session_timeline_entries WHERE message_id = ?)", [id]);
    db.run("DELETE FROM session_timeline_entries WHERE message_id = ?", [id]);
    db.run("DELETE FROM messages WHERE id = ?", [id]);
  }
}

test("deleted task references render as placeholders without task links", async () => {
  const sessions = await getJson<DashboardSession[]>("/api/sessions");
  const messages = await getJson<DashboardSessionMessage[]>("/api/sessions/conv-primary/messages");
  const deleted = { id: "deleted-task", title: "该任务已删除", status: "deleted", priority: null };
  const session = { ...sessions.find(row => row.id === "conv-primary")!, linked_tasks: [deleted], linkedTasks: [deleted] };
  const message = { ...messages[0]!, linked_tasks: [deleted], linkedTasks: [deleted], content: [{ type: "text", text: "[Old task](/agent/tasks/deleted-task) [External](https://example.com/agent/tasks/deleted-task)" }] };
  for (const presentation of [undefined, { kind: "task_final_answer" as const, task: deleted }, { kind: "status_card" as const, task: deleted, status: "completed", title: "Historic card", text: null }]) {
    const html = renderToStaticMarkup(createElement(SessionDetailView, { sessionId: session.id, session, messages: [{ ...message, presentation }], loading: false, error: null, showNotFound: false }));
    expect(html).toContain("该任务已删除");
    expect(html).not.toContain('href="/agent/tasks/deleted-task"');
    if (presentation?.kind !== "status_card") expect(html).toContain('href="https://example.com/agent/tasks/deleted-task"');
  }
});
