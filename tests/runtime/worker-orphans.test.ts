import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openExecutionDatabase } from "@luna/execution-store";
import { WorkerConfig } from "@luna/worker/config";
import { DockerEnvironmentDriver } from "@luna/worker/docker-driver";
import { EnvironmentStore } from "@luna/worker/environment-store";
import { EnvironmentManager } from "@luna/worker/environment-manager";
import { pruneReport } from "../../apps/worker/src/cli";
import { OrphanCleanupStore, DEFAULT_ORPHAN_CLEANUP } from "../../src/runtime/orphan-cleanup";

const DAY = 86_400_000;

/** A Worker whose Docker calls are recorded instead of run. */
function worker() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-orphans-")));
  const db = openExecutionDatabase(":memory:");
  const config = WorkerConfig.parse({ workerId: "worker", runtimeId: "runtime", dataRoot: root, runtimeEndpoint: "http://127.0.0.1:8091", controlToken: "a".repeat(43), imageDigest: "sha256:" + "a".repeat(64) });
  const store = new EnvironmentStore(db), driver = new DockerEnvironmentDriver(db, config);
  const removed: string[] = [], volumes: string[] = [], strays: string[] = [];
  driver.inspect = async () => null;
  driver.remove = async environment => { removed.push(environment.spec.scope.shadowId); };
  driver.removeVolume = async environment => { volumes.push(environment.spec.scope.shadowId); };
  driver.strays = async () => ({ containers: ["luna-exec-shared-stray"], volumes: ["luna-stray-volume"] });
  driver.removeStrays = async found => { strays.push(...found.containers, ...found.volumes); };
  const manager = new EnvironmentManager(store, driver);
  /** A Shadow with HOME and a running container; `busy` keeps a reservation open. */
  function place(agentId: string, shadowId: string, busy = false) {
    const scoped = fixtureJobScope(agentId, shadowId), requestId = `request-${shadowId}`;
    (driver as unknown as { layouts: { ensure(scope: object): unknown } }).layouts.ensure({ agentId, shadowId });
    const { environment } = store.prepare({ requestId, occupant: { kind: "maintenance", scope: scoped.scope, operationId: requestId, operationHash: "a".repeat(64), contextId: `context-${shadowId}` },
      spec: { protocolVersion: 2, scope: scoped.scope, resourceSelection: scoped.resources, environmentId: "environment", mode: "shared", scopeKey: `key-${shadowId}`,
        imageDigest: config.imageDigest, callbackRuntimeId: "runtime", resources: { memory: "1g", cpus: 1, pidsLimit: 128 } } });
    if (!busy) store.cancelPreparation(requestId, true);
    store.saveEnvironment({ ...store.require(environment.id), state: "ready", containerId: `container-${shadowId}` });
    return { agentId, shadowId };
  }
  const home = (scope: { agentId: string; shadowId: string }) => driver.shadowDirectories(scope)[0]!;
  return { root, db, store, manager, place, home, removed, volumes, strays, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("an unknown Shadow loses its containers at once and its volume and HOME only after the retention", async () => {
  const w = worker();
  try {
    const known = w.place("agent", "known"), orphan = w.place("old-agent", "orphan"), busy = w.place("old-agent", "busy", true);
    const gone = { agentId: "old-agent", shadowId: "gone" };
    const now = 1_000 * DAY, checked = [known, orphan, busy, gone];
    expect(await w.manager.reconcileScopes({ checked, valid: [known], retentionMs: 7 * DAY }, now))
      .toEqual({ stopped: [orphan], purged: [], busy: [busy] });
    expect(w.removed).toEqual(["orphan"]);
    expect(w.volumes).toEqual([]);
    expect(existsSync(w.home(orphan))).toBe(true);
    expect(w.store.list().find(environment => environment.spec.scope.shadowId === "orphan")?.state).toBe("stopped");
    expect(w.manager.orphans.list().map(item => item.shadowId).sort()).toEqual(["busy", "orphan"]);

    // A later round keeps the first time it was seen; the retention runs from then.
    await w.manager.reconcileScopes({ checked, valid: [known], retentionMs: 7 * DAY }, now + 6 * DAY);
    expect(w.volumes).toEqual([]);
    expect((await w.manager.reconcileScopes({ checked: [orphan], valid: [], retentionMs: 7 * DAY }, now + 7 * DAY)).purged).toEqual([orphan]);
    expect(w.volumes).toEqual(["orphan"]);
    expect(existsSync(w.home(orphan))).toBe(false);
    expect(w.manager.heldScopes()).not.toContainEqual(orphan);
    expect(w.manager.orphans.list().map(item => item.shadowId)).toEqual(["busy"]);
    expect(existsSync(w.home(known))).toBe(true);
  } finally { w.close(); }
});

test("a Shadow Service knows again stops being an orphan and keeps its data", async () => {
  const w = worker();
  try {
    const shadow = w.place("agent", "shadow");
    await w.manager.reconcileScopes({ checked: [shadow], valid: [], retentionMs: 7 * DAY }, 0);
    expect(w.manager.orphans.list()).toHaveLength(1);
    await w.manager.reconcileScopes({ checked: [shadow], valid: [shadow], retentionMs: 7 * DAY }, 8 * DAY);
    expect(w.manager.orphans.list()).toEqual([]);
    expect(w.volumes).toEqual([]);
    expect(existsSync(w.home(shadow))).toBe(true);
  } finally { w.close(); }
});

test("only reported Shadows are acted on, and a valid entry cannot name another Agent's Shadow", async () => {
  const w = worker();
  try {
    const reported = w.place("agent", "reported"), later = w.place("agent", "later");
    await w.manager.reconcileScopes({ checked: [reported], valid: [{ agentId: "other", shadowId: "reported" }, later], retentionMs: 1 }, 10);
    expect(w.removed).toEqual(["reported"]);
    expect(w.manager.orphans.list().map(item => item.shadowId)).toEqual(["reported"]);
  } finally { w.close(); }
});

test("prune lists orphans, other Agents' Shadows and unowned Docker objects, and deletes them only with apply", async () => {
  const w = worker();
  try {
    const keep = w.place("keep", "kept"), orphan = w.place("keep", "orphan"), other = w.place("other", "foreign");
    await w.manager.reconcileScopes({ checked: [orphan], valid: [], retentionMs: 7 * DAY }, 0);
    w.removed.length = 0;

    const dry = await w.manager.prune({ apply: false });
    expect(dry.shadows.map(shadow => shadow.shadowId)).toEqual(["orphan"]);
    expect(dry.shadows[0]!.directories).toContain(w.home(orphan));
    expect(dry.strays).toEqual({ containers: ["luna-exec-shared-stray"], volumes: ["luna-stray-volume"] });
    const all = await w.manager.prune({ apply: false, keepAgents: ["keep"] });
    expect(all.shadows.map(shadow => `${shadow.agentId}/${shadow.shadowId}`).sort()).toEqual(["keep/orphan", "other/foreign"]);
    expect(pruneReport(all)).toContain("Dry run: nothing was deleted");
    expect([w.removed, w.volumes, w.strays]).toEqual([[], [], []]);
    expect(existsSync(w.home(other))).toBe(true);

    const applied = await w.manager.prune({ apply: true, keepAgents: ["keep"] });
    expect(applied.applied).toBe(true);
    expect(w.volumes.sort()).toEqual(["foreign", "orphan"]);
    expect(w.strays).toEqual(["luna-exec-shared-stray", "luna-stray-volume"]);
    expect(existsSync(w.home(orphan)) || existsSync(w.home(other))).toBe(false);
    expect(existsSync(w.home(keep))).toBe(true);
    expect(w.manager.orphans.list()).toEqual([]);
    expect(pruneReport(applied)).toEndWith("Deleted.");
  } finally { w.close(); }
});

test("orphan cleanup settings default to on, hourly, seven days, and reject out-of-range values", () => {
  const db = openExecutionDatabase(":memory:");
  try {
    const store = new OrphanCleanupStore(db);
    expect(store.get()).toEqual(DEFAULT_ORPHAN_CLEANUP);
    expect(DEFAULT_ORPHAN_CLEANUP).toEqual({ enabled: true, intervalMinutes: 60, retentionDays: 7 });
    expect(store.set({ enabled: false, intervalMinutes: 120, retentionDays: 3 })).toEqual({ enabled: false, intervalMinutes: 120, retentionDays: 3 });
    expect(new OrphanCleanupStore(db).get()).toEqual({ enabled: false, intervalMinutes: 120, retentionDays: 3 });
    for (const bad of [{ enabled: true, intervalMinutes: 1, retentionDays: 7 }, { enabled: true, intervalMinutes: 60, retentionDays: 0 }, { enabled: true }])
      expect(() => store.set(bad)).toThrow();
  } finally { db.close(); }
});

test("Service reconciles each capable connected Worker once per interval and answers only for what it reported", async () => {
  const { RuntimeScheduler } = await import("../../src/runtime/scheduler");
  const { RuntimeConfig } = await import("../../src/runtime/config");
  const { Runtime } = await import("../../src/runtime/runtime");
  const { RuntimeFiles } = await import("../../src/runtime/files");
  const { TokenAuthority } = await import("@luna/execution-transport");
  const db = openExecutionDatabase(":memory:");
  try {
    const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", dataRoot: "/unused", serviceToken: "s".repeat(43), adminToken: "a".repeat(43), homeWorkerId: "home" });
    const scheduler = new RuntimeScheduler(db, config, new TokenAuthority(db), () => []);
    const calls: { workerId: string; method: string; path: string; body?: unknown }[] = [];
    for (const [workerId, capabilities] of [["capable", ["scope-reconcile-v1"]], ["old", ["shadow-scope-v2"]]] as const) {
      scheduler.workers.register({ reverse: true, workerId, endpoint: "http://127.0.0.1:9999", controlToken: "w".repeat(43), executorHost: "127.0.0.1", executorPortStart: 41000, executorPortEnd: 41100 });
      scheduler.workers.attach(workerId, { async call<T>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push({ workerId, method, path, ...(body === undefined ? {} : { body }) });
        return (path === "/v1/scopes" ? { scopes: [{ agentId: "a", shadowId: "live" }, { agentId: "a", shadowId: "old" }] } : { stopped: [], purged: [], busy: [] }) as T;
      } });
      scheduler.workers.heartbeat(workerId, { workerId, capacity: 1, occupied: 0, imageDigest: `sha256:${"a".repeat(64)}`, ready: true, capabilities: [...capabilities] });
    }
    const runtime = new Runtime(scheduler, new RuntimeFiles(scheduler));
    const live = (scopes: { agentId: string; shadowId: string }[]) => scopes.filter(scope => scope.shadowId === "live");
    expect((await runtime.reconcileWorkerScopes(live, 3_600_000, 7 * DAY)).map(report => report.workerId)).toEqual(["capable"]);
    expect(calls).toEqual([
      { workerId: "capable", method: "GET", path: "/v1/scopes" },
      { workerId: "capable", method: "POST", path: "/v1/scopes/reconcile", body: {
        checked: [{ agentId: "a", shadowId: "live" }, { agentId: "a", shadowId: "old" }], valid: [{ agentId: "a", shadowId: "live" }], retentionMs: 7 * DAY } },
    ]);
    expect(await runtime.reconcileWorkerScopes(live, 3_600_000, 7 * DAY)).toEqual([]);
    expect(calls).toHaveLength(2);
  } finally { db.close(); }
});
