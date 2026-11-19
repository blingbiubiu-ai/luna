import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Hono } from "hono";
import { DashboardAuthService, createDashboardAuthMiddleware } from "../../src/server/auth";

afterEach(() => { setSystemTime(); });

const DAY = 24 * 60 * 60 * 1000;

test("a Dashboard sign-in lasts 30 days and is renewed while in use, so only an idle one expires", async () => {
  setSystemTime(new Date("2026-11-01T00:00:00Z"));
  const auth = new DashboardAuthService({ sessionSecret: "test-session-secret", provider: { id: "test", authenticateToken: async id => ({ id, name: id, provider: "test" }) } });
  const app = new Hono().use("*", createDashboardAuthMiddleware(auth)).get("/api/me", c => c.json({ ok: true }));
  const visit = async (cookie: string) => {
    const response = await app.request("/api/me", { headers: { cookie: `luna_dashboard_session=${cookie}` } });
    const renewed = response.headers.get("set-cookie")?.match(/luna_dashboard_session=([^;]+)/)?.[1];
    return { status: response.status, renewed, maxAge: response.headers.get("set-cookie")?.match(/Max-Age=(\d+)/)?.[1] };
  };
  const first = (await auth.login("alice"))!.sessionToken;

  // Fresh sessions are not reissued on every request.
  setSystemTime(new Date(Date.parse("2026-11-01T00:00:00Z") + 10 * DAY));
  expect(await visit(first)).toEqual({ status: 200, renewed: undefined, maxAge: undefined });

  // Past half its lifetime it is reissued for another 30 days.
  setSystemTime(new Date(Date.parse("2026-11-01T00:00:00Z") + 20 * DAY));
  const renewal = await visit(first);
  expect(renewal).toMatchObject({ status: 200, maxAge: String(30 * DAY / 1000) });
  expect(renewal.renewed).toBeString();

  // The renewed session outlives the original one; the original, left idle, has expired.
  setSystemTime(new Date(Date.parse("2026-11-01T00:00:00Z") + 45 * DAY));
  expect((await visit(renewal.renewed!)).status).toBe(200);
  expect((await visit(first)).status).toBe(401);
});
