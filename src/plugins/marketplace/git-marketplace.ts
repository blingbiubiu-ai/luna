import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitMarketplaceInput {
  readonly id: string;
  readonly gitUrl: string;
  readonly branch: string;
  readonly localPath: string;
}

export interface GitMarketplaceSyncResult {
  readonly localPath: string;
  readonly commit: string;
}

export async function syncGitMarketplace(
  input: GitMarketplaceInput,
): Promise<GitMarketplaceSyncResult> {
  mkdirSync(dirname(input.localPath), { recursive: true });
  if (!existsSync(join(input.localPath, ".git"))) {
    git(process.cwd(), [
      "clone",
      "--branch",
      input.branch,
      input.gitUrl,
      input.localPath,
    ]);
  } else {
    git(input.localPath, ["remote", "set-url", "origin", input.gitUrl]);
    git(input.localPath, ["fetch", "origin", input.branch]);
    git(input.localPath, ["checkout", input.branch]);
    git(input.localPath, ["reset", "--hard", `origin/${input.branch}`]);
  }

  return {
    localPath: input.localPath,
    commit: git(input.localPath, ["rev-parse", "HEAD"]).trim(),
  };
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}
