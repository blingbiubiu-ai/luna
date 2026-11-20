import { registerTestRunnerJob } from "./support/runner-job";
import { encodeInvocation } from "../../src/runners/invocation-codec";
import { InvocationStore } from "../../src/runners/invocation-store";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { setLunaHome } from "../../src/shared";
import { SessionResolver } from "../../src/sessions/session-resolver";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { mainInvocations } from "../../src/runners/main-invocation-registry";
import { runnerMessageEnvelopeFromRow } from "../../src/runners/message-envelope";
import { createRunnerChatRoutes } from "../../src/server/routes/runner-chat";
import { AgentStore } from "../../src/agents/agent-store";
import { ChatListeningStore } from "../../src/sessions/chat-listening-store";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import type { LunaAccessTokenClaims } from "../../src/server/auth/access-token-service";
import type { NormalizedInboundMessage } from "../../src/channels";
import { fixtureSessionOwnership, fixtureUser } from "../helpers/platform-fixtures";

let home: string;
let connection: DataConnection<typeof schema>;
afterEach(() => { connection?.close(); if (home) rmSync(home, { recursive: true, force: true }); });

/** A Main invocation in a Feishu session, triggered by "user", who is not the Agent owner. */
function fixture(options: { kind?: "group" | "p2p"; actor?: string; ambient?: boolean } = {}) {
  const kind = options.kind ?? "group";
  home = mkdtempSync(join(tmpdir(), "luna-chat-api-")); setLunaHome(home);
  connection = new DataConnection(schema); const db = connection.db;
  const agentId = fixtureSessionOwnership(db, "feishu", "test").agent_id;
  fixtureUser(db, agentId, "user", "human", "User");
  const actor = options.actor === "owner" ? new AgentStore(db).ownerUserId(agentId) : "user";
  const inbound: NormalizedInboundMessage = { id: "external-1", channel: { id: "test", type: "feishu" }, surface: { externalId: "chat", kind }, sender: { externalId: "user", kind: "user" }, text: "hello", mentions: [], addressing: { addressedToBot: true, reason: kind === "p2p" ? "p2p" : "mention" } };
  const session = new SessionResolver(new SessionStore(db)).resolveFromNormalizedInbound(inbound);
  const row = new MessageStore(db).appendOnce({ sessionId: session.id, channelMessageKey: inbound.id, role: "user", senderUserId: "user", content: [{ type: "text", text: "hello" }], inbound, channel: inbound.channel, surface: inbound.surface, sender: inbound.sender }).row;
  const context = new RunnerContextStore(db).resolveForSession(session.id, "codex");
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => new InvocationStore(db).revoke("invocation", "test cancelled"));
  mainInvocations(db).set("invocation", { invocationId: "invocation", turnId: "logical-turn", runnerContext: context, signal: controller.signal, input: { type: "user_messages", messages: [{ ...runnerMessageEnvelopeFromRow({ row, rawMessage: inbound }), rawMessage: inbound }], latestMessage: inbound, context: { sessionId: session.id, candidateOpenTasks: [] }, ...(options.ambient ? { ambient: true as const } : {}) } });
  const claims: LunaAccessTokenClaims = { tokenId: "token", actorUserId: actor, source: "runner", role: "runner", runnerKind: "main", agentId: session.agent_id, shadowId: session.shadow_id, sessionId: session.id, runnerJobId: context.id, issuedAt: 1, expiresAt: Date.now() + 10000 };
  db.insert(schema.accessTokens).values({ id: "token", agentId: claims.agentId, tokenHash: "hash", userId: actor, source: "runner", name: "test", role: "runner", issuedAt: 1, expiresAt: Date.now() + 10000, createdAt: 1, metadataJson: { invocationId: "invocation" } }).run();
  registerTestRunnerJob(db, "invocation", claims, encodeInvocation("main", mainInvocations(db).get("invocation")!), "logical-turn");
  let current: LunaAccessTokenClaims | undefined = claims;
  const app = new Hono<{ Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims | undefined } }>();
  app.use("*", async (c, next) => { c.set("lunaAccessTokenClaims", current); await next(); });
  app.route("/api/runner", createRunnerChatRoutes({ db }));
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api/runner/chat/listening${path}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const grant = (effect: "allow" | "deny", target: string) => new AuthorizationRuleStore(db, {kind: "agent", agentId: session.agent_id}).addGrant({subjectType: "user", subjectId: "user", target, effect});
  return { db, call, grant, session, controller, useClaims: (next: LunaAccessTokenClaims | undefined) => { current = next; }, claims };
}

const listening = (f: ReturnType<typeof fixture>) => new ChatListeningStore(f.db).enabled(f.session);

test("the Agent switches listening for its group chat when its owner asks, and reports it", async () => {
  const f = fixture({ actor: "owner" });
  expect((await f.call("GET", "")).body).toEqual({ listening: false });
  expect(await f.call("PUT", "", { enabled: true })).toMatchObject({ status: 200, body: { listening: true } });
  expect(listening(f)).toBe(true);
  expect((await f.call("PUT", "", { enabled: false })).body).toEqual({ listening: false });
  expect((await f.call("PUT", "", { enabled: "yes" })).status).toBe(400);
  expect((await f.call("PUT", "", { enabled: true, chatId: "oc_other" })).status).toBe(400);
});

test("a member can have it switched only with an allow rule for chat.listen", async () => {
  const f = fixture();
  expect(await f.call("PUT", "", { enabled: true })).toMatchObject({ status: 403, body: { error: "chat_listening_forbidden" } });
  expect(listening(f)).toBe(false);
  expect((await f.call("GET", "")).status).toBe(200);
  f.grant("allow", "chat.listen");
  expect((await f.call("PUT", "", { enabled: true })).body).toEqual({ listening: true });
});

test("listening is not switched in a listening turn, or outside a group chat", async () => {
  const overheard = fixture({ actor: "owner", ambient: true });
  expect(await overheard.call("PUT", "", { enabled: false })).toMatchObject({ status: 403, body: { error: "chat_listening_forbidden" } });
  connection.close();
  const direct = fixture({ actor: "owner", kind: "p2p" });
  expect(await direct.call("PUT", "", { enabled: true })).toMatchObject({ status: 409, body: { error: "chat_listening_unavailable" } });
  expect((await direct.call("GET", "")).status).toBe(409);
});
