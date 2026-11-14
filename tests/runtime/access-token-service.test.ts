import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { accessTokens, channelAuthTokens } from "../../src/data/schema";
import { IdentityDirectory } from "../../src/identity/identity-directory";
import {
  AccessTokenService,
  hashAccessToken,
  type IssueLunaAccessTokenInput,
} from "../../src/server/auth/access-token-service";
import { fixtureNamedSession } from "../helpers/platform-fixtures";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { config, setLunaHome } from "../../src/shared";

describe("AccessTokenService", () => {
  let home: string;
  let previousHome: string;
  let connection: DataConnection<typeof schema>;
  let service: AccessTokenService;
  let user: { id: string; displayName: string };
  let otherUser: { id: string; displayName: string };

  beforeEach(() => {
    previousHome = config.paths.home;
    home = mkdtempSync(join(tmpdir(), "luna-access-token-service-"));
    mkdirSync(join(home, "data"), { recursive: true });
    setLunaHome(home);

    connection = new DataConnection(schema);
    const identityDirectory = new IdentityDirectory(connection.db);
    user = identityDirectory.materializeIdentityClaims({
      kind: "human",
      displayName: "Token User",
      claims: [
        {
          namespace: "local",
          kind: "local_id",
          value: "token-user",
          scope: "",
          confidence: "manual",
        },
      ],
    });
    otherUser = identityDirectory.materializeIdentityClaims({
      kind: "human",
      displayName: "Other Token User",
      claims: [
        {
          namespace: "local",
          kind: "local_id",
          value: "other-token-user",
          scope: "",
          confidence: "manual",
        },
      ],
    });
    service = new AccessTokenService({
      db: connection.db,
      signingSecret: "test-access-token-secret",
    });
  });

  afterEach(() => {
    connection.close();
    setLunaHome(previousHome);
    rmSync(home, { recursive: true, force: true });
  });

  test("creates signed cli token, stores only hash, and verifies it", () => {
    const issued = service.issueToken({
      userId: user.id,
      name: "MacBook CLI",
      source: "cli",
      role: "user",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      now: 1000,
    });
    expect(issued.token).toBeString();
    expect(connection.db.select().from(accessTokens).all()[0]?.tokenHash).toBe(
      hashAccessToken(issued.token),
    );
    expect(JSON.stringify(connection.db.select().from(accessTokens).all()))
      .not.toContain(issued.token);
    expect(service.verifyBearer(issued.token, { now: 2000 }).user.id).toBe(
      user.id,
    );
  });

  function runnerTokenInput(overrides: Partial<IssueLunaAccessTokenInput> = {}) {
    fixtureNamedSession(connection.db, "runner-session", user.id);
    const context = new RunnerContextStore(connection.db).resolveForSession("runner-session", "codex");
    return baseTokenInput(user.id, {source: "runner", role: "runner", runnerKind: "work",
      sourceSessionId: "runner-session", sourceRunnerJobId: context.id, ...overrides});
  }

  test("rejects tokens when signed claims and stored record diverge", () => {
    const input = runnerTokenInput();
    const cases: Array<{
      name: string;
      update: Partial<typeof accessTokens.$inferInsert>;
    }> = [
      { name: "agent", update: { agentId: null } },
      { name: "shadow", update: { shadowId: null } },
      { name: "source", update: { source: "cli" } },
      { name: "role", update: { role: "user" } },
      { name: "session context", update: { sourceSessionId: "session_other" } },
      { name: "task context", update: { sourceTaskId: "task_other" } },
      { name: "task run context", update: { sourceTaskRunId: "run_other" } },
      { name: "runner job context", update: { sourceRunnerJobId: "job_other" } },
    ];

    for (const item of cases) {
      const issued = service.issueToken(input);
      connection.db
        .update(accessTokens)
        .set(item.update)
        .where(eq(accessTokens.id, issued.record.id))
        .run();

      expect(
        () => service.verifyBearer(issued.token, { now: 2000 }),
        item.name,
      ).toThrow("invalid_access_token");
    }
  });

  test("rejects expired revoked and tampered tokens", () => {
    const issued = service.issueToken(
      baseTokenInput(user.id, { now: 1000, ttlMs: 5000 }),
    );
    expect(() => service.verifyBearer(issued.token, { now: 7000 })).toThrow(
      "expired_access_token",
    );
    service.revokeToken(issued.record.id, user.id, 2000);
    expect(() => service.verifyBearer(issued.token, { now: 3000 })).toThrow(
      "revoked_access_token",
    );
    expect(() =>
      service.verifyBearer(`${issued.token.slice(0, -2)}xx`, { now: 3000 })
    ).toThrow("invalid_access_token");
  });

  test("creates cli auth session and consumes approval once", () => {
    const started = service.startCliAuthSession({
      now: 1000,
    });
    service.approveCliAuthSession(started.userCode, user.id, 2000);
    const polled = service.pollCliAuthSession(started.deviceCode, { now: 3000 });
    expect(polled.status).toBe("approved");
    expect(service.pollCliAuthSession(started.deviceCode, { now: 4000 }).status)
      .toBe("consumed");
  });

  test("confirms cli auth with a one-time channel auth token", () => {
    const started = service.startCliAuthSession({
      now: 1000,
    });
    const proof = service.issueChannelAuthToken({
      userId: user.id,
      channelType: "feishu",
      channelId: "feishu-main",
      channelIdentityId: "identity-token-user",
      purpose: "cli_login",
      ttlMs: 5 * 60 * 1000,
      now: 1500,
    });

    expect(proof.token).toBeString();
    expect(connection.db.select().from(channelAuthTokens).all()[0]?.tokenHash)
      .toBe(hashAccessToken(proof.token));
    expect(JSON.stringify(connection.db.select().from(channelAuthTokens).all()))
      .not.toContain(proof.token);

    service.confirmCliAuthSessionWithChannelToken({
      userCode: started.userCode,
      token: proof.token,
      now: 2000,
    });

    const polled = service.pollCliAuthSession(started.deviceCode, { now: 2500 });
    expect(polled.status).toBe("approved");
    if (polled.status !== "approved") {
      throw new Error(`expected approved poll result, got ${polled.status}`);
    }
    expect(polled.user.id).toBe(user.id);
    expect(
      connection.db.select().from(channelAuthTokens).all()[0]?.consumedAt,
    ).toBe(2000);
    expect(() =>
      service.confirmCliAuthSessionWithChannelToken({
        userCode: started.userCode,
        token: proof.token,
        now: 3000,
      })
    ).toThrow("invalid_channel_auth_token");
  });

  test("consumes cli auth approval once and persists only one cli token", () => {
    const started = service.startCliAuthSession({
      now: 1000,
    });
    service.approveCliAuthSession(started.userCode, user.id, 2000);
    const first = service.pollCliAuthSession(started.deviceCode, { now: 3000 });
    const second = service.pollCliAuthSession(started.deviceCode, { now: 4000 });

    expect(first.status).toBe("approved");
    expect(second.status).toBe("consumed");
    const cliTokens = connection.db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.source, "cli"))
      .all();
    expect(cliTokens).toHaveLength(1);
  });

  test("does not let one user revoke another user's token", () => {
    const issued = service.issueToken(baseTokenInput(user.id));

    service.revokeToken(issued.record.id, otherUser.id, 2000);

    expect(service.verifyBearer(issued.token, { now: 3000 }).user.id).toBe(
      user.id,
    );
  });

  test("cleans expired runner tokens after retention window", () => {
    const runner = service.issueToken(
      runnerTokenInput({ttlMs: 24 * 60 * 60 * 1000}),
    );
    const cli = service.issueToken(
      baseTokenInput(user.id, {
        source: "cli",
        role: "user",
        now: 1000,
        ttlMs: 30 * 24 * 60 * 60 * 1000,
      }),
    );
    expect(
      service.cleanupExpiredRunnerTokens({
        now: 1000 + 9 * 24 * 60 * 60 * 1000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(1);
    const ids = connection.db.select().from(accessTokens).all().map((row) =>
      row.id
    );
    expect(ids).not.toContain(runner.record.id);
    expect(ids).toContain(cli.record.id);
  });
});

function baseTokenInput(
  userId: string,
  overrides: Partial<IssueLunaAccessTokenInput> = {},
): IssueLunaAccessTokenInput {
  return {
    userId,
    name: "Test token",
    source: "cli",
    role: "user",
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    now: 1000,
    ...overrides,
  };
}
