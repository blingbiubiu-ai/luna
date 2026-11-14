import { expect, test } from "bun:test";
import { runSchedulesCli } from "@luna/cli/commands/schedules";

test("schedule CLI translates calendar options and rejects invalid combinations before sending", async () => {
  const requests: any[] = [];
  const server = Bun.serve({port:0,async fetch(req) { requests.push({key:req.headers.get("idempotency-key"),body:await req.json()});return Response.json({id:"schedule"}); }});
  const env = {LUNA_SERVICE_URL:`http://127.0.0.1:${server.port}`,LUNA_ACCESS_TOKEN:"test"};
  const base = ["create","--timezone","Asia/Singapore","--text","work","--request-id","stable"];
  try {
    for (const args of [
      ["--repeat","monthly","--time","09:00","--month-days","15,1,1","--start-date","2026-01-01","--invoke"],
      ["--repeat","weekly","--time","10:00","--days","1,3,5"],
      ["--repeat","yearly","--time","09:00","--month","2","--month-days","28,29","--every","2","--start-date","2026-01-01"],
      ["--repeat","daily","--time","08:00"],
      ["--repeat","weekdays","--time","08:00"],
      ["--repeat","hourly","--time","09:15","--every","3"],
      ["--interval-ms","1800000"],
      ["--at","2027-01-01T09:00:00+08:00"],
    ]) expect((await runSchedulesCli([...base,...args],env)).status).toBe("ok");
    expect(requests[0]).toMatchObject({key:"stable",body:{recurrence:{kind:"custom",frequency:"monthly",monthDays:[1,15],every:1},action:{kind:"session.invoke"}}});
    expect(requests[0].body.nextAt).toBeUndefined();
    expect(requests[1].body.recurrence).toMatchObject({kind:"weekly",days:[1,3,5]});
    expect(requests[2].body.recurrence).toMatchObject({month:2,monthDays:[28,29],every:2});
    expect(requests[6].body.intervalMs).toBe(1800000);
    for (const args of [
      ["--repeat","monthly","--time","09:00"], ["--repeat","weekly","--time","09:00","--days","8"],
      ["--repeat","daily","--time","25:00"], ["--repeat","daily","--time","09:00","--interval-ms","60000"],
      ["--repeat","daily","--time","09:00","--at","2027-01-01T00:00:00Z"],
      ["--interval-ms","60000","--month-days","1"], ["--interval-ms","NaN"], ["--interval-ms","1"],
      ["--repeat","yearly","--time","09:00","--month","2","--month-days","30"],
      ["--repeat","weekly","--time","09:00","--days","1,"], ["--repeat","daily","--time","09:00","--unknown","x"],
      ["--at","2027-01-01T09:00:00"],
    ]) expect((await runSchedulesCli([...base,...args],env)).status).toBe("error");
    expect(requests).toHaveLength(8);
  } finally { server.stop(true); }
});
