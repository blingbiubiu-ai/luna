import { expect, test } from "bun:test";
import { runSchedulesCli } from "@luna/cli/commands/schedules";

test("schedule CLI translates Protocol v2 calendar/task options, manages schedules, and rejects invalid combinations", async () => {
  const requests: { method: string; path: string; key: string | null; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname + url.search,
        key: req.headers.get("idempotency-key"),
        body: req.method === "GET" || req.method === "DELETE" ? null : await req.json(),
      });
      return Response.json({ commandId: "schedule", status: "applied", id: "schedule" });
    },
  });
  const env = {
    LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`,
    LUNA_ACCESS_TOKEN: "test",
    LUNA_INVOCATION_ID: "inv-sched-1",
  };
  const base = ["create", "--timezone", "Asia/Singapore", "--text", "work"];
  try {
    for (const args of [
      ["--frequency", "monthly", "--time", "09:00", "--month-days", "15,1,1", "--start-date", "2026-01-01", "--invoke"],
      ["--frequency", "weekly", "--time", "10:00", "--days", "1,3,5"],
      ["--frequency", "yearly", "--time", "09:00", "--month", "2", "--month-days", "28,29", "--every", "2", "--start-date", "2026-01-01"],
      ["--frequency", "daily", "--time", "08:00", "--task-id", "task-123", "--to", "group:grp-1"],
      ["--frequency", "weekdays", "--time", "08:00"],
      ["--frequency", "hourly", "--time", "09:15", "--every", "3"],
      ["--interval-ms", "1800000"],
      ["--at", "2027-01-01T09:00:00+08:00"],
    ]) {
      expect((await runSchedulesCli([...base, ...args], env)).status).toBe("ok");
    }
    expect(requests[0]?.key).toMatch(/^v2_[0-9a-f]{32}$/);
    expect(requests[0]?.body).toMatchObject({
      address: "current",
      recurrence: { kind: "custom", frequency: "monthly", monthDays: [1, 15], every: 1 },
      action: { kind: "session.invoke" },
    });
    expect(requests[0]?.body.nextAt).toBeUndefined();
    expect(requests[1]?.body.recurrence).toMatchObject({ kind: "weekly", days: [1, 3, 5] });
    expect(requests[2]?.body.recurrence).toMatchObject({ month: 2, monthDays: [28, 29], every: 2 });
    expect(requests[3]?.body).toMatchObject({
      address: "group:grp-1",
      action: { kind: "task.run", taskId: "task-123", content: "work" },
    });
    expect(requests[6]?.body.intervalMs).toBe(1800000);

    // Self-management subcommands: list / get / pause / resume / cancel
    expect((await runSchedulesCli(["list", "--status", "active"], env)).status).toBe("ok");
    expect((await runSchedulesCli(["get", "sched-1"], env)).status).toBe("ok");
    expect((await runSchedulesCli(["pause", "sched-1"], env)).status).toBe("ok");
    expect((await runSchedulesCli(["resume", "sched-1"], env)).status).toBe("ok");
    expect((await runSchedulesCli(["cancel", "sched-1"], env)).status).toBe("ok");

    for (const args of [
      ["--frequency", "monthly", "--time", "09:00"],
      ["--frequency", "weekly", "--time", "09:00", "--days", "8"],
      ["--frequency", "daily", "--time", "25:00"],
      ["--frequency", "daily", "--time", "09:00", "--interval-ms", "60000"],
      ["--frequency", "daily", "--time", "09:00", "--at", "2027-01-01T00:00:00Z"],
      ["--interval-ms", "60000", "--month-days", "1"],
      ["--interval-ms", "NaN"],
      ["--interval-ms", "1"],
      ["--frequency", "yearly", "--time", "09:00", "--month", "2", "--month-days", "30"],
      ["--frequency", "weekly", "--time", "09:00", "--days", "1,"],
      ["--frequency", "daily", "--time", "09:00", "--unknown", "x"],
      ["--at", "2027-01-01T09:00:00"],
      ["--repeat", "daily", "--time", "09:00"],
      ["--at", "2027-01-01T09:00:00+08:00", "--request-id", "legacy"],
    ]) {
      expect((await runSchedulesCli([...base, ...args], env)).status).toBe("error");
    }
    expect(requests).toHaveLength(13);
  } finally {
    server.stop(true);
  }
});
