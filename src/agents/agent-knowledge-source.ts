import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentError } from "./agent-store";
import { createKnowledgeWorkspaceRepository, KNOWLEDGE_WORKSPACE_ALLOWED_ROOTS } from "../../extensions/workspace/knowledge/definition";
import { knowledgeJobs, knowledgeStorage } from "@/workspace/knowledge-storage";

// Addresses are data passed to Git argv, never shell commands. Credentials stay in
// the Service account's credential helper / SSH agent, not in Agent-visible URLs.
export const KnowledgeSourceInput = z.object({
  url: z.string().trim().min(1).max(2048).refine(validGitUrl, "Use an HTTPS or SSH Git address without embedded credentials"),
  branch: z.string().trim().max(200).default("").refine(branch => !branch || validBranch(branch), "Invalid branch"),
}).strict();
export type KnowledgeSourceInput = z.infer<typeof KnowledgeSourceInput>;
const State = z.object({
  url: z.string(), branch: z.string(),
  status: z.enum(["initializing", "syncing", "ready", "error"]),
  initialized: z.boolean(), commit: z.string().nullable(),
  updatedAt: z.number(), error: z.string().nullable(),
});
export type KnowledgeSourceState = z.infer<typeof State>;

const gitConfig = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never"];
const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
});

function validGitUrl(value: string): boolean {
  if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return ["https:", "http:", "ssh:"].includes(url.protocol) && !!url.hostname && !url.password && !url.search && !url.hash
      && (url.protocol === "ssh:" || !url.username);
  } catch { return false; }
}
function validBranch(branch: string): boolean {
  return spawnSync("git", ["check-ref-format", "--branch", branch], { encoding: "utf8", env: gitEnv() }).status === 0
    && !branch.startsWith("-") && !branch.startsWith("@");
}
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...gitConfig, ...args], { cwd, env: gitEnv(), timeout: 300_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout.trim()); return; }
      // Don't persist raw remote diagnostics: they may contain credential-helper output.
      const message = /local changes|untracked working tree|would be overwritten/i.test(stderr) ? "本地有未提交修改，请先提交后再同步。"
        : /not possible to fast-forward|divergent/i.test(stderr) ? "本地与远端分支已分叉，请先处理冲突后再同步。"
        : /remote branch.*not found|couldn't find remote ref/i.test(stderr) ? "远端分支不存在，请检查分支名称。"
        : "Git 操作失败，请检查仓库地址、分支、网络及 Service 账户的 Git 访问权限。";
      reject(new Error(message));
    });
  });
}

/** Durable Agent-local source metadata is outside the Runner-readable knowledge repo. */
export class AgentKnowledgeSource {
  constructor(private readonly home: string) {}

  read(agentId: string): KnowledgeSourceState | null {
    const { root, statePath } = knowledgeStorage(this.home, agentId);
    if (!existsSync(statePath)) return null;
    if (!lstatSync(statePath).isFile() || lstatSync(statePath).isSymbolicLink()) throw new Error("Unsafe knowledge source metadata");
    const state = State.parse(JSON.parse(readFileSync(statePath, "utf8")));
    if (["initializing", "syncing"].includes(state.status) && !knowledgeJobs.has(root)) {
      // Activation is a directory rename. If the Service exited between that
      // rename and its metadata write, recognize the validated checkout instead
      // of refusing retry as a non-empty repository.
      if (state.status === "initializing" && !state.initialized) {
        const repo = createKnowledgeWorkspaceRepository(this.home, agentId);
        const probe = (args: string[]) => {
          const result = spawnSync("git", [...gitConfig, ...args], { cwd: repo.root, env: gitEnv(), encoding: "utf8", timeout: 5000 });
          return result.status === 0 ? result.stdout.trim() : null;
        };
        const commit = probe(["rev-parse", "--verify", "HEAD"]);
        const branch = probe(["symbolic-ref", "--short", "HEAD"]);
        if (commit && branch && (!state.branch || state.branch === branch)
          && probe(["config", "--get", "remote.origin.url"]) === state.url) {
          const completed: KnowledgeSourceState = { ...state, initialized: true, status: "ready", commit, branch, updatedAt: Date.now(), error: null };
          this.write(agentId, completed);
          return completed;
        }
      }
      const interrupted: KnowledgeSourceState = { ...state, status: "error", error: "上次操作因服务重启中断，请重试。" };
      this.write(agentId, interrupted);
      return interrupted;
    }
    return state;
  }

  initialize(agentId: string, raw: unknown): KnowledgeSourceState {
    const input = KnowledgeSourceInput.parse(raw);
    const { root } = knowledgeStorage(this.home, agentId);
    if (knowledgeJobs.has(root)) throw new AgentError("knowledge_busy", 409);
    const prior = this.read(agentId);
    if (prior?.initialized) {
      if (prior.url !== input.url || (input.branch && input.branch !== prior.branch)) throw new AgentError("knowledge_source_already_initialized", 409);
      return this.sync(agentId);
    }
    this.requireEmpty(agentId);
    const state: KnowledgeSourceState = { ...input, initialized: false, status: "initializing", commit: null, updatedAt: Date.now(), error: null };
    this.write(agentId, state);
    this.start(agentId, state, true);
    return state;
  }

  sync(agentId: string): KnowledgeSourceState {
    const { root } = knowledgeStorage(this.home, agentId);
    if (knowledgeJobs.has(root)) throw new AgentError("knowledge_busy", 409);
    const prior = this.read(agentId);
    if (!prior) throw new AgentError("knowledge_source_not_configured", 400);
    if (!prior.initialized) return this.initialize(agentId, { url: prior.url, branch: prior.branch });
    createKnowledgeWorkspaceRepository(this.home, agentId);
    const state: KnowledgeSourceState = { ...prior, status: "syncing", error: null };
    this.write(agentId, state);
    this.start(agentId, state, false);
    return state;
  }

  async wait(agentId: string): Promise<void> {
    await knowledgeJobs.get(knowledgeStorage(this.home, agentId).root);
  }

  private requireEmpty(agentId: string) {
    const repo = createKnowledgeWorkspaceRepository(this.home, agentId);
    const head = spawnSync("git", [...gitConfig, "rev-parse", "--verify", "HEAD"], { cwd: repo.root, env: gitEnv() });
    if (head.status === 0 || readdirSync(repo.root).some(name => name !== ".git")) throw new AgentError("knowledge_not_empty", 409);
  }

  private write(agentId: string, state: KnowledgeSourceState) {
    const { statePath } = knowledgeStorage(this.home, agentId);
    const temp = `${statePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temp, statePath);
  }

  private start(agentId: string, state: KnowledgeSourceState, initial: boolean) {
    const { root, agentRoot } = knowledgeStorage(this.home, agentId);
    // Defer until the gate is installed, including for immediate failures.
    const job = Promise.resolve().then(async () => {
      const stage = join(agentRoot, `.knowledge-clone-${randomUUID()}`);
      try {
        let commit: string, branch = state.branch;
        if (initial) {
          await git(agentRoot, ["clone", "--single-branch", ...(branch ? ["--branch", branch] : []), "--", state.url, stage]);
          if (lstatSync(join(stage, ".git")).isSymbolicLink()) throw new Error("知识仓库的 Git 目录无效。");
          const top = await git(stage, ["rev-parse", "--show-toplevel"]);
          if (top !== stage) throw new Error("知识仓库的 Git 根目录无效。");
          if (!KNOWLEDGE_WORKSPACE_ALLOWED_ROOTS.some(name => {
            const path = join(stage, name);
            return existsSync(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
          })) throw new Error("仓库根目录需要包含 wiki、notes、archive 或 policies 文件夹，请先调整仓库结构。");
          branch = await git(stage, ["symbolic-ref", "--short", "HEAD"]);
          commit = await git(stage, ["rev-parse", "HEAD"]);
          // Recheck under the operation gate before activation; outside edits never get overwritten.
          const head = spawnSync("git", [...gitConfig, "rev-parse", "--verify", "HEAD"], { cwd: root, env: gitEnv() });
          if (head.status === 0 || readdirSync(root).some(name => name !== ".git")) throw new Error("知识库出现了本地内容，初始化已停止。");
          const backup = join(agentRoot, `.knowledge-empty-${randomUUID()}`);
          renameSync(root, backup);
          try { renameSync(stage, root); } catch (error) { renameSync(backup, root); throw error; }
          rmSync(backup, { recursive: true });
        } else {
          if (await git(root, ["status", "--porcelain", "-uall"])) throw new Error("本地有未提交修改，请先提交后再同步。");
          if (await git(root, ["symbolic-ref", "--short", "HEAD"]) !== branch) throw new Error("本地分支已改变，请恢复配置的分支后再同步。");
          if (await git(root, ["config", "--get", "remote.origin.url"]) !== state.url) throw new Error("本地远端地址已改变，请恢复配置的地址后再同步。");
          await git(root, ["fetch", "origin", branch]);
          await git(root, ["merge", "--ff-only", "FETCH_HEAD"]);
          commit = await git(root, ["rev-parse", "HEAD"]);
        }
        this.write(agentId, { ...state, initialized: true, status: "ready", branch, commit, updatedAt: Date.now(), error: null });
      } catch (error) {
        this.write(agentId, { ...state, status: "error", error: error instanceof Error ? error.message : "初始化失败。", updatedAt: Date.now() });
      } finally {
        rmSync(stage, { recursive: true, force: true });
        knowledgeJobs.delete(root);
      }
    });
    knowledgeJobs.set(root, job);
    // Filesystem errors must not become an unhandled background rejection.
    void job.catch(() => { knowledgeJobs.delete(root); });
  }
}
