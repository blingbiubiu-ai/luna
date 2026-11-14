import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExecutionDatabase } from "@luna/execution-store";
import { TokenAuthority } from "@luna/execution-transport";
import { RuntimeConfig } from "../../src/runtime/config";
import { RuntimeFiles } from "../../src/runtime/files";
import { Runtime } from "../../src/runtime/runtime";
import { RuntimeScheduler } from "../../src/runtime/scheduler";

test("Service interface detach keeps Job active, resumes from committed cursor, and settles terminal separately", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-runtime-client-"));
  const db = openExecutionDatabase(join(root, "runtime.sqlite"));
  const authority = new TokenAuthority(db);
  const token = authority.issue("service", { role: "service", id: "service1" });
  const admin = authority.issue("admin", { role: "runtime", id: "runtime1" });
  const scheduler = new RuntimeScheduler(db, RuntimeConfig.parse({ runtimeId: "runtime1", serviceId: "service1", dataRoot: root, serviceToken: token, adminToken: admin, homeWorkerId: "worker1" }), authority);
  const client = new Runtime(scheduler, new RuntimeFiles(scheduler));
  try {
    await client.verify();
    await client.submit({ version: 2, ...fixtureJobScope(), jobId: "job1", invocationId: "inv1", environmentId: "luna", runnerContextId: "ctx1", scopeKey: "session:ctx1", runnerKind: "main", sessionId: "session1", input: { runnerType: "claude", prompt: "test" }, credentialsRevision: 1, timeoutMs: 10000 });
    const detach = new AbortController();
    let cursor = 0;
    for await (const event of client.events("job1", 0, detach.signal)) { cursor = event.seq; detach.abort(); }
    expect(cursor).toBe(1);
    expect((await client.query("job1")).placementState).toBe("queued");
    await client.cancel("job1");
    const replay = [];
    for await (const event of client.events("job1", cursor, AbortSignal.timeout(5000))) replay.push(event);
    expect(replay.map((event) => event.seq)).toEqual([2]);
    expect((await client.query("job1")).lastSeq).toBe(2);
    const afterTerminal = [];
    for await (const event of client.events("job1", 2, AbortSignal.timeout(5000))) afterTerminal.push(event);
    expect(afterTerminal).toEqual([]);
  } finally { scheduler.stop(); await client.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
