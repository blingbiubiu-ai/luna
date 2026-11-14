import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, linkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openExecutionDatabase, contentHash } from "@luna/execution-store";
import { WorkerConfig } from "@luna/worker/config";
import { DockerEnvironmentDriver } from "@luna/worker/docker-driver";
import { EnvironmentManager } from "@luna/worker/environment-manager";
import { EnvironmentStore } from "@luna/worker/environment-store";

for (const mode of ["shared", "isolated"] as const) {
  test.skipIf(process.env.LUNA_DOCKER_INTEGRATION !== "1")(`project, Memory and Skill mounts work in ${mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-project-mount-")));
    const projectPath = join(root, "projects"); mkdirSync(projectPath); writeFileSync(join(projectPath, "original"), "original");
    linkSync(join(projectPath, "original"), join(projectPath, "hardlink"));
    const originalStat = statSync(join(projectPath, "original"));
    const memory = join(root, "memory"), skills = join(root, ".runner-skills");
    mkdirSync(memory);
    mkdirSync(join(skills, "fixture"), { recursive: true });
    writeFileSync(join(memory, "SOUL.md"), "memory");
    writeFileSync(join(skills, "fixture", "SKILL.md"), "skill");
    const workerId = `project_${contentHash(root).slice(0, 12)}`;
    const digest = execFileSync("docker", ["image", "inspect", process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:latest", "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
    const db = openExecutionDatabase(join(root, "control", "worker.sqlite"));
    const config = WorkerConfig.parse({ workerId, runtimeId: "runtime", dataRoot: join(root, "control"), runtimeEndpoint: "http://host.docker.internal:8091", controlToken: "w".repeat(43), imageDigest: digest, network: `luna-${workerId}`, executorPortStart: 42800, executorPortEnd: 42810, projects: [{ projectId: "original", hostPath: projectPath }] });
    const driver = new DockerEnvironmentDriver(db, config); const store = new EnvironmentStore(db); const manager = new EnvironmentManager(store, driver);
    try {
      await driver.preflight();
      async function prepare(contextId: string, projectId?: string, suffix = "") {
        return manager.prepare({ requestId: `prepare-${contextId}${suffix}`, ...(projectId ? { projectId } : {}), occupant: { kind: "maintenance", scope:fixtureJobScope().scope, operationId: `operation-${contextId}${suffix}`, operationHash: contentHash({ kind: "provision" }), contextId }, spec: { protocolVersion:2,scope:fixtureJobScope().scope,resourceSelection:fixtureJobScope().resources,environmentId: "luna", scopeKey: `session:${contextId}`, mode, imageDigest: digest, callbackRuntimeId: "runtime", resources: { memory: "1g", cpus: 1, pidsLimit: 128 } } });
      }
      const one = await prepare("first", "original");
      const originalContainer = (await driver.inspect(store.require(one.handle.environmentId)))!.Id;
      const two = await prepare("second", "original");
      if (mode === "shared") {
        expect((await driver.inspect(store.require(one.handle.environmentId)))!.Id).toBe(originalContainer);
        expect(two.handle.instanceId).toBe(one.handle.instanceId);
      }
      const outside = await prepare("outsider");
      const container = async (id: string) => (await driver.inspect(store.require(id)))!.Id;
      const a = await container(one.handle.environmentId), b = await container(two.handle.environmentId), c = await container(outside.handle.environmentId);
      const home = (_id: string) => root;
      function asRunner(containerId: string, command: string[]) {
        return execFileSync("docker", ["exec", "--user", `${config.runnerUid}:${config.runnerGid}`, containerId, ...command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      }
      for (const [id, executor] of [["first", a], ["second", b]] as const) {
        expect(asRunner(executor, ["cat", `${home(id)}/memory/SOUL.md`])).toBe("memory");
        expect(asRunner(executor, ["cat", `${home(id)}/.agents/skills/fixture/SKILL.md`])).toBe("skill");
        expect(asRunner(executor, ["cat", `${home(id)}/.claude/skills/fixture/SKILL.md`])).toBe("skill");
        expect(() => asRunner(executor, ["touch", `${home(id)}/memory/new.md`])).toThrow();
        expect(() => asRunner(executor, ["touch", `${home(id)}/.agents/skills/new.md`])).toThrow();
      }
      writeFileSync(join(memory, "SOUL.md"), "updated");
      expect(asRunner(a, ["cat", `${home("first")}/memory/SOUL.md`])).toBe("updated");
      expect(asRunner(b, ["cat", `${home("second")}/memory/SOUL.md`])).toBe("updated");
      if (mode === "isolated") expect(b).not.toBe(a);
      expect(asRunner(a, ["cat", `${home("first")}/projects/hardlink`])).toBe("original");
      asRunner(a, ["sh", "-c", 'printf first > "$1"', "test", `${home("first")}/projects/shared`]);
      asRunner(b, ["sh", "-c", 'printf second >> "$1"', "test", `${home("second")}/projects/shared`]);
      expect(readFileSync(join(projectPath, "shared"), "utf8")).toBe("firstsecond");
      expect(statSync(join(projectPath, "shared")).uid).toBe(config.runnerUid);
      const stat = statSync(join(projectPath, "original"));
      expect([stat.uid, stat.gid, stat.mode, stat.ino, stat.nlink]).toEqual([originalStat.uid, originalStat.gid, originalStat.mode, originalStat.ino, 2]);
      expect(asRunner(c, ["cat", `${home("first")}/projects/original`])).toBe("original");
      asRunner(a, ["sh", "-c", 'printf tool > "$1/.local/bin/shared-tool"', "test", root]);
      expect(asRunner(b, ["cat", `${root}/.local/bin/shared-tool`])).toBe("tool");
      writeFileSync(join(root, "runners", "first", "working-file"), "same path");
      expect(asRunner(a, ["cat", `${root}/runners/first/working-file`])).toBe("same path");
      expect(spawnSync("docker", ["exec", "--user", `${config.runnerUid}:${config.runnerGid}`, a, "cat", "/run/luna/executor.json"], { stdio: "ignore" }).status).not.toBe(0);
      expect((await driver.prepareContext(fixtureJobScope().scope,"first", "session:first")).contextId).toBe("first");
      expect(readFileSync(join(projectPath, "original"), "utf8")).toBe("original");

      // Stopping an unchanged container must preserve its identity and installed tools.
      execFileSync("docker", ["stop", "--time", "1", a], { stdio: "ignore" });
      const resumed = await prepare("first", "original", "-resumed");
      expect(await container(resumed.handle.environmentId)).toBe(a);
      expect(asRunner(a, ["cat", `${root}/.local/bin/shared-tool`])).toBe("tool");
      expect(asRunner(a, ["cat", `${root}/runners/first/working-file`])).toBe("same path");

      // A changed startup setting must not silently resume stale configuration.
      execFileSync("docker", ["stop", "--time", "1", a], { stdio: "ignore" });
      const changedDriver = new DockerEnvironmentDriver(db, { ...config, capacity: config.capacity + 1 });
      const environment = store.require(one.handle.environmentId);
      const changedId = await changedDriver.ensure(environment);
      expect(changedId).not.toBe(a);
      expect(asRunner(changedId, ["cat", `${root}/.local/bin/shared-tool`])).toBe("tool");
      // A running container with outstanding reservations cannot be replaced.
      if (mode === "shared") await expect(prepare("third", "original")).rejects.toMatchObject({ code: "environment_mount_pending" });

      await driver.remove(store.require(one.handle.environmentId));
      const restored = await prepare("first", "original", "-restored");
      expect(restored.handle.instanceId).toBe(one.handle.instanceId);
      const restoredContainer = await container(restored.handle.environmentId);
      expect(asRunner(restoredContainer, ["cat", `${home("first")}/projects/shared`])).toBe("firstsecond");
      expect(asRunner(restoredContainer, ["cat", `${home("first")}/.agents/skills/fixture/SKILL.md`])).toBe("skill");
      expect(asRunner(restoredContainer, ["cat", `${root}/.local/bin/shared-tool`])).toBe("tool");
    } finally {
      for (const environment of store.list()) {
        await driver.remove(environment);
        execFileSync("docker", ["volume", "rm", `luna-${contentHash(workerId).slice(0, 12)}-${environment.id}`], { stdio: "ignore" });
      }
      execFileSync("docker", ["network", "rm", config.network], { stdio: "ignore" });
      db.close(); rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
}
