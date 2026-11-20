import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../src/data/schema";
import { fixtureAccount } from "../helpers/platform-fixtures";
import { AgentStore } from "../../src/agents/agent-store";
import { AgentKnowledgeSource, KnowledgeSourceInput } from "../../src/agents/agent-knowledge-source";
import { createAgentKnowledgeSourceRoutes } from "../../src/server/routes/agent-knowledge-source";
import { createKnowledgeWorkspaceRepository } from "../../extensions/workspace/knowledge/definition";

let home: string, remote: string, work: string, root: string;
let server: ReturnType<typeof Bun.serve>, source: AgentKnowledgeSource, sqlite: Database;
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "knowledge-source-"));
  home = join(root, "home"); work = join(root, "work"); remote = join(root, "remote.git");
  mkdirSync(home); mkdirSync(work); mkdirSync(join(work, "wiki"));
  writeFileSync(join(work, "wiki", "index.md"), "Original knowledge");
  git(work, "init", "-b", "main"); git(work, "add", "."); git(work, "commit", "-m", "original");
  git(root, "clone", "--bare", work, remote); git(remote, "update-server-info");
  server = Bun.serve({ port: 0, fetch(req) {
    const path = resolve(remote, `.${decodeURIComponent(new URL(req.url).pathname)}`);
    if (!path.startsWith(`${remote}/`)) return new Response(null, { status: 403 });
    return existsSync(path) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
  } });
  source = new AgentKnowledgeSource(home);
});
afterEach(async () => {
  await Promise.all([source.wait("a"), source.wait("b")]); server.stop(true); sqlite?.close(); rmSync(root, { recursive: true, force: true });
});
const input = () => ({ url: `http://127.0.0.1:${server.port}`, branch: "" });
async function initialize(id = "a") { source.initialize(id, input()); await source.wait(id); expect(source.read(id)?.status).toBe("ready"); }

test("real Git clone initializes root layout, history and independent Agent repositories", async () => {
  const started = source.initialize("a", input());
  expect(started.status).toBe("initializing");
  expect(() => source.initialize("a", input())).toThrow("knowledge_busy");
  expect(() => createKnowledgeWorkspaceRepository(home, "a")).toThrow("knowledge_busy");
  await source.wait("a"); await initialize("b");
  const a = createKnowledgeWorkspaceRepository(home, "a"), b = createKnowledgeWorkspaceRepository(home, "b");
  expect(a.readFile("wiki/index.md").content).toBe("Original knowledge");
  expect(source.read("a")?.branch).toBe("main");
  expect(source.read("a")?.commit).toBe(git(work, "rev-parse", "HEAD"));
  expect(git(a.root, "log", "--format=%s")).toBe("original");
  a.writeFile("wiki/index.md", "Local edit");
  expect(b.readFile("wiki/index.md").content).toBe("Original knowledge");
  expect(a.glob("**/*").entries.some(entry => entry.path.includes("knowledge-source"))).toBe(false);
});

test("sync fast forwards real remote changes and refuses dirty or divergent local changes", async () => {
  await initialize();
  const repo = createKnowledgeWorkspaceRepository(home, "a");
  writeFileSync(join(work, "wiki", "index.md"), "Remote change"); git(work, "commit", "-am", "update"); git(work, "push", remote, "main"); git(remote, "update-server-info");
  source.sync("a"); await source.wait("a");
  expect(source.read("a")?.status).toBe("ready"); expect(repo.readFile("wiki/index.md").content).toBe("Remote change");
  repo.writeFile("wiki/index.md", "Keep local"); source.sync("a"); await source.wait("a");
  expect(source.read("a")?.error).toContain("未提交"); expect(repo.readFile("wiki/index.md").content).toBe("Keep local");
  git(repo.root, "commit", "-am", "local");
  writeFileSync(join(work, "wiki", "index.md"), "Divergent remote"); git(work, "commit", "-am", "remote divergence"); git(work, "push", remote, "main"); git(remote, "update-server-info");
  source.sync("a"); await source.wait("a");
  expect(source.read("a")?.status).toBe("error"); expect(source.read("a")?.error).toContain("分叉");
  expect(repo.readFile("wiki/index.md").content).toBe("Keep local");
  expect(() => source.initialize("a", { url: input().url, branch: "other" })).toThrow("knowledge_source_already_initialized");
});

test("existing files and commits cannot be replaced, failed branch initialization can retry", async () => {
  const repo = createKnowledgeWorkspaceRepository(home, "b"); repo.writeFile("wiki/index.md", "Do not overwrite");
  expect(() => source.initialize("b", input())).toThrow("knowledge_not_empty");
  expect(source.read("b")).toBeNull();
  source.initialize("a", { ...input(), branch: "missing" }); await source.wait("a");
  expect(source.read("a")?.status).toBe("error"); expect(source.read("a")?.initialized).toBe(false);
  await initialize();
  expect(repo.readFile("wiki/index.md").content).toBe("Do not overwrite");
});

test("nested old layout is rejected without activating it", async () => {
  mkdirSync(join(work, "knowledge")); git(work, "mv", "wiki", "knowledge/wiki"); git(work, "commit", "-m", "nested"); git(work, "push", remote, "main"); git(remote, "update-server-info");
  source.initialize("a", input()); await source.wait("a");
  expect(source.read("a")?.error).toContain("仓库根目录");
  expect(createKnowledgeWorkspaceRepository(home, "a").glob("**/*").entries).toHaveLength(0);
});

test("source management requires Dashboard ownership, access grants do not authorize it", async () => {
  sqlite = new Database(":memory:"); const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: "src/data/drizzle" });
  fixtureAccount(db, "alice"); fixtureAccount(db, "bob"); const agent = new AgentStore(db).create("alice", { name: "Knowledge" }, "create");
  const app = new Hono<any>().use("*", async (c, next) => {
    const actor = c.req.header("Test-Actor");
    if (actor) { c.set("dashboardAuthSession", { authenticated: true, account: { id: actor, name: actor, provider: "test" } }); c.set("lunaRequestAuthKind", "dashboard-cookie"); }
    await next();
  }).route("/agents", createAgentKnowledgeSourceRoutes(db, home));
  const path = `/agents/${agent.id}/knowledge/source`;
  expect((await app.request(path)).status).toBe(401);
  expect((await app.request(path, { headers: { "Test-Actor": "bob" } })).status).toBe(403);
  expect((await app.request(path, { headers: { "Test-Actor": "alice" } })).status).toBe(200);
  const response = await app.request(path, { method: "PUT", headers: { "Test-Actor": "alice", "Content-Type": "application/json" }, body: JSON.stringify(input()) });
  expect(response.status).toBe(202); await source.wait(agent.id);
  expect((await app.request(`${path}/sync`, { method: "POST", headers: { "Test-Actor": "bob" } })).status).toBe(403);
});

test("source addresses reject filesystem, command transports, credentials and invalid branches", () => {
  for (const url of ["/tmp/repo", "file:///tmp/repo", "ext::sh -c command", "https://user:password@example.com/repo", "https://token@example.com/repo", "-option"])
    expect(KnowledgeSourceInput.safeParse({ url }).success).toBe(false);
  expect(KnowledgeSourceInput.safeParse({ url: "git@example.com:team/repo.git" }).success).toBe(true);
  expect(KnowledgeSourceInput.safeParse({ url: "ssh://git@example.com/team/repo.git", branch: "--upload-pack=command" }).success).toBe(false);
});


test("restart recovers activated initialization and interrupted sync can retry", async () => {
  await initialize();
  const path = join(home, "agents", "a", "knowledge-source.json");
  const ready = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...ready, status: "initializing", initialized: false, branch: "", commit: null }));
  const restarted = new AgentKnowledgeSource(home);
  expect(restarted.read("a")?.status).toBe("ready");
  expect(restarted.read("a")?.initialized).toBe(true);
  writeFileSync(path, JSON.stringify({ ...ready, status: "syncing" }));
  expect(restarted.read("a")?.error).toContain("重启中断");
  expect(createKnowledgeWorkspaceRepository(home, "a").readFile("wiki/index.md").content).toBe("Original knowledge");
  restarted.sync("a"); await restarted.wait("a");
  expect(restarted.read("a")?.status).toBe("ready");
});

test("Service home Git config is used even when the login home is different", async () => {
  // Redirect a normal-looking URL to the fixture through trusted global config.
  writeFileSync(join(home, ".gitconfig"), `[url "${input().url}"]\n\tinsteadOf = https://knowledge.example.test/repo.git\n`);
  const configured = new AgentKnowledgeSource(home);
  configured.initialize("a", { url: "https://knowledge.example.test/repo.git" });
  await configured.wait("a");
  expect(configured.read("a")?.status).toBe("ready");
  expect(createKnowledgeWorkspaceRepository(home, "a").readFile("wiki/index.md").content).toBe("Original knowledge");
  configured.sync("a"); await configured.wait("a");
  expect(configured.read("a")?.status).toBe("ready");
});
