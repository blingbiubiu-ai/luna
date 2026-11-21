import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceRepository } from "../../src/workspace/repository";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

describe("workspace repository", () => {
  let root: string;
  let repo: WorkspaceRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "luna-workspace-"));
    mkdirSync(join(root, "knowledge/wiki/domains"), { recursive: true });
    mkdirSync(join(root, "knowledge/wiki/_state"), { recursive: true });
    mkdirSync(join(root, "knowledge/archive"), { recursive: true });
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    writeFileSync(
      join(root, "knowledge/wiki/domains/playback.md"),
      "# Playback\nSearchable text\n首帧体验\n起播速度\n播放性能\n",
    );
    writeFileSync(join(root, "knowledge/wiki/_state/page_registry.json"), "{\"pages\":[]}\n");
    writeFileSync(join(root, "README.md"), "outside\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);
    repo = new WorkspaceRepository({workspaceId:"knowledge",repoRoot:root,root:join(root,"knowledge"),gitPath:"knowledge",allowedReadRoots:["wiki","notes","archive","policies"],allowedWriteRoots:["wiki","notes","archive","policies"]});
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects absolute paths, traversal, and disallowed roots", () => {
    expect(() => repo.resolvePath("/tmp/file.md")).toThrow("relative");
    expect(() => repo.resolvePath("../README.md")).toThrow("traversal");
    expect(() => repo.resolvePath("private/file.md")).toThrow("not allowed");
  });

  test("rejects symlink escape", () => {
    writeFileSync(join(root, "secret.md"), "secret");
    symlinkSync(join(root, "secret.md"), join(root, "knowledge/wiki/domains/escape.md"));

    expect(() => repo.readFile("wiki/domains/escape.md")).toThrow("escapes workspace root");
  });

  test("glob, grep, and read return workspace-relative files", () => {
    expect(repo.glob("wiki/**/*.md").entries.map((entry) => entry.path)).toEqual([
      "wiki/domains/playback.md",
    ]);
    expect(repo.grep("Searchable", "wiki/**/*.md").matches).toEqual([
      expect.objectContaining({
        path: "wiki/domains/playback.md",
        line: 2,
        column: 1,
        text: "Searchable text",
      }),
    ]);
    expect(repo.readFile("wiki/domains/playback.md")).toMatchObject({
      path: "wiki/domains/playback.md",
      content: "# Playback\nSearchable text\n首帧体验\n起播速度\n播放性能\n",
      kind: "markdown",
    });
  });

  test("directory lists one level and exposes only allowed roots", () => {
    mkdirSync(join(root, "knowledge/other"));
    writeFileSync(join(root, "knowledge/secret.md"), "hidden from discovery");
    // A shallow listing must not invoke recursive glob enumeration.
    repo.glob = () => { throw new Error("recursive enumeration"); };
    expect(repo.directory().entries.map(entry => entry.path)).toEqual(["archive", "wiki"]);
    expect(repo.directory("wiki").entries.map(entry => [entry.type, entry.path])).toEqual([
      ["directory", "wiki/_state"], ["directory", "wiki/domains"],
    ]);
    expect(repo.directory("wiki/domains").entries).toEqual([
      expect.objectContaining({ type: "file", name: "playback.md", path: "wiki/domains/playback.md", kind: "markdown" }),
    ]);
    expect(repo.directory("archive").entries).toEqual([]);
    for (const path of ["../", "/tmp", "other", "wiki/../../", "wiki/../archive"]) expect(() => repo.directory(path)).toThrow("invalid_directory_path");
    expect(() => repo.directory("wiki/missing")).toThrow("directory_not_found");
    expect(() => repo.directory("wiki/domains/playback.md")).toThrow("not_a_directory");
  });

  test("directory discovery excludes symlinks, hidden metadata and cycles", () => {
    symlinkSync(join(root, "knowledge/wiki"), join(root, "knowledge/wiki/cycle"));
    symlinkSync(join(root, "README.md"), join(root, "knowledge/wiki/external.md"));
    mkdirSync(join(root, "knowledge/wiki/.private"));
    expect(repo.directory("wiki").entries.map(entry => entry.name)).toEqual(["_state", "domains"]);
    expect(() => repo.directory("wiki/cycle")).toThrow("invalid_directory_path");
  });

  test("optional filename search covers unopened directories without returning the whole catalog", () => {
    writeFileSync(join(root, "knowledge/wiki/domains/独立页方案.md"), "unrelated body");
    expect(repo.grep("独立页", "**/*", { includeFileNames: true })).toMatchObject({
      matches: [], fileMatches: [expect.objectContaining({ path: "wiki/domains/独立页方案.md" })],
    });
    expect(repo.grep("独立页", "**/*").fileMatches).toBeUndefined();
    for (let i = 0; i < 501; i++) writeFileSync(join(root, `knowledge/wiki/unique-${i}.md`), "");
    const limited = repo.grep("unique", "**/*", { includeFileNames: true });
    expect(limited.fileMatches).toHaveLength(500);
    expect(limited.fileMatchesTruncated).toBe(true);
  });

  test("grep skips binary and oversized archives and bounds large result sets", () => {
    writeFileSync(join(root, "knowledge/archive/media.png"), "首帧");
    writeFileSync(join(root, "knowledge/archive/binary.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, "knowledge/archive/large.txt"), "a".repeat(2 * 1024 * 1024 + 1));
    const result = repo.grep("首帧");
    expect(result.skippedFiles).toBe(3);
    expect(result.matches.map(match => match.path)).toEqual(["wiki/domains/playback.md"]);
    writeFileSync(join(root, "knowledge/wiki/many.md"), "中文命中\n".repeat(600));
    const limited = repo.grep("中文命中");
    expect(limited.matches).toHaveLength(500);
    expect(limited.truncated).toBe(true);
  });

  test("grep supports structured any/all queries and explicit regex mode", () => {
    expect(
      repo.grep(
        { queries: ["首帧", "起播"], match: "any" },
        "wiki/**/*.md",
      ).matches.map((match) => match.text),
    ).toEqual(["首帧体验", "起播速度"]);

    expect(
      repo.grep(
        { queries: ["播放", "性能"], match: "all" },
        "wiki/**/*.md",
      ).matches.map((match) => match.text),
    ).toEqual(["播放性能"]);

    expect(
      repo.grep(
        { query: "首帧|起播", mode: "regex" },
        "wiki/**/*.md",
      ).matches.map((match) => match.text),
    ).toEqual(["首帧体验", "起播速度"]);

    expect(repo.grep("首帧|起播", "wiki/**/*.md").matches).toEqual([]);
  });

  test("writes full file content without committing", () => {
    expect(repo.writeFile("archive/seed.md", "# Seed\n")).toMatchObject({
      path: "archive/seed.md",
      written: true,
    });
    expect(readFileSync(join(root, "knowledge/archive/seed.md"), "utf8")).toBe("# Seed\n");
    expect(repo.gitStatus().entries.map((entry) => entry.path)).toContain(
      "knowledge/archive/seed.md",
    );
  });

  test("git status, diff, and commit only include knowledge workspace changes", () => {
    writeFileSync(join(root, "README.md"), "outside changed\n");
    repo.writeFile("wiki/domains/new.md", "# New\n");

    expect(repo.gitStatus().entries.map((entry) => entry.path)).toEqual([
      "knowledge/wiki/domains/new.md",
    ]);
    expect(repo.gitDiff().diff).toContain("knowledge/wiki/domains/new.md");

    const result = repo.gitCommit("docs: add workspace page");
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.commitHash).toHaveLength(40);
    }
    expect(git(root, ["status", "--porcelain", "--", "knowledge"])).toBe("");
    expect(git(root, ["status", "--porcelain", "--", "README.md"])).toContain("README.md");
  });

  test("git commit reports nothing to commit", () => {
    expect(repo.gitCommit("docs: no changes")).toEqual({
      status: "nothing_to_commit",
      message: "nothing to commit in workspace knowledge",
    });
  });

  test("workspace commit preserves unrelated staged and unstaged changes", () => {
    writeFileSync(join(root, "README.md"), "outside staged\n");
    git(root, ["add", "README.md"]);
    writeFileSync(join(root, "README.md"), "outside unstaged\n");
    const staged = git(root, ["diff", "--cached", "--", "README.md"]);
    const unstaged = git(root, ["diff", "--", "README.md"]);
    repo.writeFile("wiki/domains/new.md", "# New\n");

    expect(repo.gitCommit("workspace only").status).toBe("committed");
    expect(git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("knowledge/wiki/domains/new.md");
    expect(git(root, ["show", "HEAD:README.md"])).toBe("outside");
    expect(git(root, ["diff", "--cached", "--", "README.md"])).toBe(staged);
    expect(git(root, ["diff", "--", "README.md"])).toBe(unstaged);
  });
});
