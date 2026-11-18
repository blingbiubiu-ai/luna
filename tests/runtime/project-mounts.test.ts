import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openExecutionDatabase } from "@luna/execution-store";
import { WorkerConfig } from "@luna/worker/config";
import { ProjectMounts } from "@luna/worker/project-mounts";
import { DockerEnvironmentDriver } from "@luna/worker/docker-driver";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-project-mounts-")));
  const config = WorkerConfig.parse({ workerId: "local", runtimeId: "runtime", dataRoot: join(root, "control"),
    runtimeEndpoint: "http://127.0.0.1:8091", controlToken: "w".repeat(43), imageDigest: `sha256:${"a".repeat(64)}`,
    projects: [{ projectId: "project", hostPath: join(root, "projects") }] });
  mkdirSync(config.dataRoot, { recursive: true });
  const db = openExecutionDatabase(":memory:");
  return { root, config, db, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("configured project mounts need no adoption or historical inode identity", () => {
  const f = fixture();
  try {
    const projects = new ProjectMounts(f.db, f.config);
    projects.prepare();
    const path = f.config.projects[0]!.hostPath;
    writeFileSync(join(path, "original"), "work");
    projects.bind("context", "project");
    expect(projects.forContext("context")).toEqual({ projectId: "project", hostPath: path });
    renameSync(path, path + "-saved"); mkdirSync(path);
    const reopened = new ProjectMounts(f.db, f.config);
    reopened.prepare(); reopened.bind("context");
    expect(reopened.forContext("context")!.hostPath).toBe(path);
    expect(readFileSync(join(path + "-saved", "original"), "utf8")).toBe("work");
    expect(() => reopened.bind("other", "unconfigured")).toThrow("project_not_configured");
    expect(() => reopened.bind("context", "other")).toThrow("context_project_conflict");
  } finally { f.close(); }
});

test("project mounts cannot expose Worker control or Runner directories", () => {
  const f = fixture();
  try {
    for (const path of [f.config.dataRoot, join(f.config.dataRoot, "agents/agent/shadows/shadow/runners"), f.root]) {
      f.config.projects = [{ projectId: "project", hostPath: path }];
      expect(() => new ProjectMounts(f.db, f.config).prepare()).toThrow("project_storage_overlap");
    }
  } finally { f.close(); }
});

test("Worker prepares a context in its Shadow and enforces its scope", async () => {
  const f = fixture();
  try {
    const driver = new DockerEnvironmentDriver(f.db, f.config);
    new ProjectMounts(f.db, f.config).prepare();
    driver.contexts.ensure("context", "session:context");
    const scope={agentId:"agent",shadowId:"shadow"};
    // The working directory as the container sees it.
    const cwd = "/home/luna/runners/context";
    expect(await driver.prepareContext(scope,"context", "session:context", "project", cwd)).toEqual({ contextId: "context", scopeKey: "session:context" });
    expect(driver.contextPath("context")).toBe(cwd);
    await expect(driver.prepareContext(scope,"context", "session:wrong", "project", cwd)).rejects.toMatchObject({ code: "context_scope_conflict" });
    await expect(driver.prepareContext(scope,"escape", "session:escape", undefined, f.root)).rejects.toMatchObject({ code: "context_directory_conflict" });
  } finally { f.close(); }
});
