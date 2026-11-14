import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export type WorkspaceFileKind = "markdown" | "json" | "yaml" | "text";

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly kind: WorkspaceFileKind;
}

export interface WorkspaceGlobResult {
  readonly workspaceId: string;
  readonly entries: readonly WorkspaceFileEntry[];
}

export interface WorkspaceGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface WorkspaceGrepResult {
  readonly workspaceId: string;
  readonly matches: readonly WorkspaceGrepMatch[];
  readonly skippedFiles?: number;
  readonly truncated?: boolean;
}

export type WorkspaceGrepMode = "literal" | "regex";
export type WorkspaceGrepMatchMode = "any" | "all";

export interface WorkspaceGrepRequest {
  readonly query?: string | undefined;
  readonly queries?: readonly string[] | undefined;
  readonly mode?: WorkspaceGrepMode | undefined;
  readonly match?: WorkspaceGrepMatchMode | undefined;
  readonly glob?: string | undefined;
}

export interface WorkspaceReadResult extends WorkspaceFileEntry {
  readonly content: string;
}

export interface WorkspaceWriteResult extends WorkspaceFileEntry {
  readonly written: true;
}

export interface WorkspaceGitStatusEntry {
  readonly path: string;
  readonly status: string;
}

export interface WorkspaceGitStatusResult {
  readonly workspaceId: string;
  readonly entries: readonly WorkspaceGitStatusEntry[];
  readonly clean: boolean;
}

export interface WorkspaceGitDiffResult {
  readonly workspaceId: string;
  readonly diff: string;
}

export type WorkspaceGitCommitResult =
  | { readonly status: "committed"; readonly commitHash: string }
  | { readonly status: "nothing_to_commit"; readonly message: string };

export interface WorkspaceRepositoryConfig {
  readonly workspaceId: string;
  readonly repoRoot: string;
  readonly root: string;
  readonly gitPath: string;
  readonly allowedReadRoots: readonly string[];
  readonly allowedWriteRoots: readonly string[];
}

export class WorkspaceRepository {
  readonly workspaceId: string;
  readonly repoRoot: string;
  readonly root: string;
  readonly gitPath: string;
  private readonly _allowedReadRoots: ReadonlySet<string>;
  private readonly _allowedWriteRoots: ReadonlySet<string>;

  constructor(config: WorkspaceRepositoryConfig) {
    this.workspaceId = config.workspaceId;
    this.repoRoot = realpathSync(config.repoRoot);
    this.root = existsSync(config.root) ? realpathSync(config.root) : config.root;
    this.gitPath = normalizeGitPath(config.gitPath);
    this._allowedReadRoots = new Set(config.allowedReadRoots);
    this._allowedWriteRoots = new Set(config.allowedWriteRoots);
  }

  resolvePath(path: string, options: { readonly write?: boolean } = {}): string {
    const normalized = normalizeWorkspacePath(path);
    const topLevel = normalized.split("/")[0];
    if (topLevel === undefined || topLevel.length === 0) {
      throw new Error("workspace path must include an allowed root");
    }

    const allowedRoots = options.write ? this._allowedWriteRoots : this._allowedReadRoots;
    if (!allowedRoots.has(topLevel)) {
      throw new Error(`workspace path root is not allowed: ${topLevel}`);
    }

    const absolutePath = resolve(this.root, normalized);
    assertInsideRoot(absolutePath, this.root, "workspace root");
    this._assertNoSymlinkEscape(absolutePath);
    return absolutePath;
  }

  glob(pattern: string): WorkspaceGlobResult {
    const normalizedPattern = normalizeGlobPattern(pattern);
    const entries = [...new Bun.Glob(normalizedPattern).scanSync({ cwd: this.root })]
      .map((path) => path.split(sep).join("/"))
      .filter((path) => this._isReadableFile(path))
      .map((path) => this._fileEntry(path))
      .sort(compareByPath);
    return { workspaceId: this.workspaceId, entries };
  }

  grep(input: string | WorkspaceGrepRequest, globPattern = "**/*"): WorkspaceGrepResult {
    const request = normalizeGrepRequest(input, globPattern);
    if (request.queries.length === 0) {
      return { workspaceId: this.workspaceId, matches: [] };
    }
    const matchers = request.queries.map((query) =>
      request.mode === "regex"
        ? regexLineMatcher(query)
        : literalLineMatcher(query)
    );
    const matches: WorkspaceGrepMatch[] = [];
    let skippedFiles = 0;
    let scannedBytes = 0;
    const maxFileBytes = 2 * 1024 * 1024;
    const maxTotalBytes = 32 * 1024 * 1024;
    for (const entry of this.glob(request.globPattern).entries) {
      if (entry.sizeBytes > maxFileBytes || scannedBytes + entry.sizeBytes > maxTotalBytes || /\.(?:png|jpe?g|gif|webp|ico|pdf|mp[34]|mov|wav|zip|gz|7z|woff2?|ttf)$/i.test(entry.path)) {
        skippedFiles++;
        continue;
      }
      const bytes = readFileSync(this.resolvePath(entry.path));
      if (bytes.includes(0)) { skippedFiles++; continue; }
      scannedBytes += bytes.byteLength;
      const lines = bytes.toString("utf8").split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const matchingColumns = matchers
          .map((matcher) => matcher(line))
          .filter((column) => column >= 0);
        const matched = request.match === "all"
          ? matchingColumns.length === matchers.length
          : matchingColumns.length > 0;
        if (matched) {
          matches.push({
            path: entry.path,
            line: index + 1,
            column: Math.min(...matchingColumns) + 1,
            text: line.slice(0, 2000),
          });
          if (matches.length >= 500) return { workspaceId: this.workspaceId, matches, skippedFiles, truncated: true };
        }
      }
    }
    return { workspaceId: this.workspaceId, matches, ...(skippedFiles ? { skippedFiles } : {}) };
  }

  readFile(path: string): WorkspaceReadResult {
    const absolutePath = this.resolvePath(path);
    const entry = this._fileEntry(path);
    return {
      ...entry,
      content: readFileSync(absolutePath, "utf8"),
    };
  }

  writeFile(path: string, content: string): WorkspaceWriteResult {
    const absolutePath = this.resolvePath(path, { write: true });
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
    return {
      ...this._fileEntry(path),
      written: true,
    };
  }

  gitStatus(): WorkspaceGitStatusResult {
    const stdout = git(this.repoRoot, ["status", "--porcelain", "-uall", "--", this.gitPath]).stdout;
    const entries = stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => ({
        status: line.slice(0, 2).trim(),
        path: line.slice(3).trim(),
      }))
      .sort(compareStatusByPath);
    return {
      workspaceId: this.workspaceId,
      entries,
      clean: entries.length === 0,
    };
  }

  gitDiff(): WorkspaceGitDiffResult {
    git(this.repoRoot, ["add", "-N", "--", this.gitPath]);
    return {
      workspaceId: this.workspaceId,
      diff: git(this.repoRoot, ["diff", "--", this.gitPath]).stdout,
    };
  }

  gitCommit(message: string): WorkspaceGitCommitResult {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
      throw new Error("commit message is required");
    }
    if (this.gitStatus().clean) {
      return {
        status: "nothing_to_commit",
        message: `nothing to commit in workspace ${this.workspaceId}`,
      };
    }
    git(this.repoRoot, ["add", "--", this.gitPath]);
    // Keep other workspaces' staged changes in the index, outside this commit.
    git(this.repoRoot, ["commit", "--only", "-m", trimmedMessage, "--", this.gitPath]);
    return {
      status: "committed",
      commitHash: git(this.repoRoot, ["rev-parse", "HEAD"]).stdout.trim(),
    };
  }

  private _isReadableFile(path: string): boolean {
    try {
      const absolutePath = this.resolvePath(path);
      return statSync(absolutePath).isFile();
    } catch {
      return false;
    }
  }

  private _fileEntry(path: string): WorkspaceFileEntry {
    const normalized = normalizeWorkspacePath(path);
    const absolutePath = this.resolvePath(normalized);
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`workspace path is not a file: ${normalized}`);
    }
    return {
      path: normalized,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      kind: fileKind(normalized),
    };
  }

  private _assertNoSymlinkEscape(absolutePath: string): void {
    const existingPath = nearestExistingPath(absolutePath);
    if (existingPath === undefined) {
      assertInsideRoot(dirname(absolutePath), this.root, "workspace root");
      return;
    }
    assertInsideRoot(realpathSync(existingPath), this.root, "workspace root");
  }
}

interface NormalizedGrepRequest {
  readonly queries: readonly string[];
  readonly mode: WorkspaceGrepMode;
  readonly match: WorkspaceGrepMatchMode;
  readonly globPattern: string;
}

function normalizeGrepRequest(
  input: string | WorkspaceGrepRequest,
  globPattern: string,
): NormalizedGrepRequest {
  if (typeof input === "string") {
    return {
      queries: [input.trim()].filter((query) => query.length > 0),
      mode: "literal",
      match: "any",
      globPattern,
    };
  }
  return {
    queries: [
      input.query,
      ...(input.queries ?? []),
    ].filter((query): query is string =>
      typeof query === "string" && query.trim().length > 0
    ).map((query) => query.trim()),
    mode: input.mode ?? "literal",
    match: input.match ?? "any",
    globPattern: input.glob ?? globPattern,
  };
}

function literalLineMatcher(query: string): (line: string) => number {
  const normalizedQuery = query.toLowerCase();
  return (line) => line.toLowerCase().indexOf(normalizedQuery);
}

function regexLineMatcher(query: string): (line: string) => number {
  const regex = new RegExp(query, "i");
  return (line) => line.search(regex);
}

function normalizeWorkspacePath(path: string): string {
  if (isAbsolute(path)) {
    throw new Error("workspace path must be relative");
  }
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("workspace path traversal is not allowed");
  }
  const result = segments.join("/");
  if (result.length === 0) {
    throw new Error("workspace path is required");
  }
  return result;
}

function normalizeGlobPattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll("\\", "/");
  if (normalized.length === 0 || normalized === ".") {
    return "**/*";
  }
  if (isAbsolute(normalized) || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("workspace glob pattern must stay inside workspace root");
  }
  return normalized;
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function fileKind(path: string): WorkspaceFileKind {
  switch (extname(path).toLowerCase()) {
    case ".md":
    case ".mdx":
      return "markdown";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      return "text";
  }
}

function nearestExistingPath(path: string): string | undefined {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      return undefined;
    }
    candidate = parent;
  }
  return candidate;
}

function assertInsideRoot(path: string, root: string, label: string): void {
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(rootWithSeparator)) {
    throw new Error(`path escapes ${label}`);
  }
}

function compareByPath(left: WorkspaceFileEntry, right: WorkspaceFileEntry): number {
  return left.path.localeCompare(right.path);
}

function compareStatusByPath(
  left: WorkspaceGitStatusEntry,
  right: WorkspaceGitStatusEntry,
): number {
  return left.path.localeCompare(right.path);
}

function git(cwd: string, args: readonly string[]): { readonly stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_"))) });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return { stdout: result.stdout };
}
