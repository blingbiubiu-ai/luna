import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import type { PluginManifest } from "@luna/plugin-contracts";
import { PluginRegistry } from "@/plugins";

import { canonicalJson, sha256Content, sha256File } from "./checksums";
import type { ReleaseValidationInput, ReleaseValidationResult } from "./types";

interface ChecksumsFile {
  readonly schemaVersion: 1;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

export function validateReleasePackage(
  input: ReleaseValidationInput,
): ReleaseValidationResult {
  const releasePath = resolve(input.marketplaceRoot, input.releaseRelativePath);
  assertInside(input.marketplaceRoot, releasePath, "release path");
  const stat = statSync(releasePath);
  if (stat.isFile()) {
    return validateReleaseArchive(input, releasePath);
  }
  if (!stat.isDirectory()) {
    throw new Error(`release path is not a directory or .tgz archive: ${releasePath}`);
  }
  return validateReleaseDirectory(input, releasePath);
}

function validateReleaseArchive(
  input: ReleaseValidationInput,
  archivePath: string,
): ReleaseValidationResult {
  if (!archivePath.endsWith(".tgz")) {
    throw new Error("release package must be a .tgz archive");
  }
  if (input.expectedPackageSha256 === undefined) {
    throw new Error("release package checksum is required for archive releases");
  }
  assertEqual(
    sha256File(archivePath),
    input.expectedPackageSha256,
    "release package checksum",
  );

  const extractionRoot = mkdtempSync(join(tmpdir(), "luna-plugin-release-"));
  const cleanup = () => rmSync(extractionRoot, { recursive: true, force: true });
  try {
    extractReleaseArchive(archivePath, extractionRoot);
    const releaseRoot = findExtractedReleaseRoot(extractionRoot);
    return {
      ...validateReleaseDirectory(input, releaseRoot),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function validateReleaseDirectory(
  input: ReleaseValidationInput,
  releaseRoot: string,
): ReleaseValidationResult {
  assertNoEscapingSymlinks(releaseRoot);

  const manifestPath = join(releaseRoot, "manifest.json");
  const pluginJsPath = join(releaseRoot, "plugin.js");
  const packageJsonPath = join(releaseRoot, "package.json");
  const checksumsPath = join(releaseRoot, "checksums.json");
  if (
    !existsSync(manifestPath) ||
    !existsSync(pluginJsPath) ||
    !existsSync(packageJsonPath) ||
    !existsSync(checksumsPath)
  ) {
    throw new Error(
      "release package must contain manifest.json, plugin.js, package.json, and checksums.json",
    );
  }

  const manifestSha256 = sha256File(manifestPath);
  const pluginJsSha256 = sha256File(pluginJsPath);
  const checksums = parseChecksums(readFileSync(checksumsPath, "utf8"));
  const releaseSha256 = sha256Content(canonicalJson(checksums));

  assertEqual(manifestSha256, input.expectedManifestSha256, "manifest checksum");
  assertEqual(pluginJsSha256, input.expectedPluginJsSha256, "plugin.js checksum");
  assertEqual(releaseSha256, input.expectedReleaseSha256, "release checksum");
  verifyListedFiles(releaseRoot, checksums);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
  if (
    manifest.id !== input.expectedPluginId ||
    manifest.version !== input.expectedVersion
  ) {
    throw new Error(
      "release manifest plugin id or version does not match marketplace index",
    );
  }
  if (manifest.source !== "marketplace") {
    throw new Error('release manifest source must be "marketplace"');
  }
  if (!isLunaApiCompatible(input.currentLunaApiVersion, manifest.lunaApiVersion)) {
    throw new Error(
      `plugin "${manifest.id}" is incompatible with Luna API ${input.currentLunaApiVersion}`,
    );
  }
  validateManifestPaths(releaseRoot, manifest);
  validateManifestShape(manifest);

  return {
    status: "valid",
    releaseRoot,
    manifest,
    manifestSha256,
    pluginJsSha256,
    releaseSha256,
  };
}

function extractReleaseArchive(archivePath: string, extractionRoot: string): void {
  const listed = spawnSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (listed.status !== 0) {
    throw new Error(
      `release package could not be inspected: ${listed.stderr || listed.stdout}`,
    );
  }
  for (const entry of listed.stdout.split("\n").filter(Boolean)) {
    assertSafeArchiveEntry(entry);
  }

  const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", extractionRoot], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (extracted.status !== 0) {
    throw new Error(
      `release package could not be extracted: ${extracted.stderr || extracted.stdout}`,
    );
  }
}

function findExtractedReleaseRoot(extractionRoot: string): string {
  if (existsSync(join(extractionRoot, "manifest.json"))) {
    return extractionRoot;
  }
  const npmStyleRoot = join(extractionRoot, "package");
  if (existsSync(join(npmStyleRoot, "manifest.json"))) {
    return npmStyleRoot;
  }
  const directories = readdirSync(extractionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(extractionRoot, entry.name));
  if (directories.length === 1 && existsSync(join(directories[0]!, "manifest.json"))) {
    return directories[0]!;
  }
  throw new Error("release package must extract to a directory containing manifest.json");
}

function assertSafeArchiveEntry(entry: string): void {
  const normalized = entry.replace(/\/+$/, "");
  if (normalized.length === 0) {
    return;
  }
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`release package entry escapes extraction root: ${entry}`);
  }
}

function parseChecksums(content: string): ChecksumsFile {
  const parsed = JSON.parse(content) as ChecksumsFile;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
    throw new Error("invalid checksums.json");
  }
  return parsed;
}

function verifyListedFiles(releaseRoot: string, checksums: ChecksumsFile): void {
  const expected = new Map(checksums.files.map((entry) => [entry.path, entry.sha256]));
  for (const entry of checksums.files) {
    assertReleaseRelative(releaseRoot, entry.path, `checksum path ${entry.path}`);
  }
  for (const filePath of listFiles(releaseRoot)) {
    const rel = relative(releaseRoot, filePath);
    if (rel === "checksums.json") {
      continue;
    }
    const expectedSha = expected.get(rel);
    if (expectedSha === undefined) {
      throw new Error(`release file is missing from checksums.json: ${rel}`);
    }
    assertEqual(sha256File(filePath), expectedSha, `checksum for ${rel}`);
  }
}

function validateManifestPaths(releaseRoot: string, manifest: PluginManifest): void {
  assertReleaseRelative(
    releaseRoot,
    manifest.runtime?.entrypoint ?? "plugin.js",
    "runtime entrypoint",
  );
  for (const skill of manifest.skills ?? []) {
    if (skill.path !== undefined) {
      assertReleaseRelative(releaseRoot, skill.path, `skill ${skill.id}`);
    }
  }
  for (const command of manifest.containerCommands ?? []) {
    assertReleaseRelative(
      releaseRoot,
      command.shimScript,
      `container command ${command.binary}`,
    );
    if (command.runtimeDirectory !== undefined) {
      const label = `container command ${command.binary} runtime directory`;
      assertReleaseRelative(releaseRoot, command.runtimeDirectory, label);
      const directory = resolve(releaseRoot, command.runtimeDirectory);
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(`${label} must be a directory`);
      }
    }
  }
}

function validateManifestShape(manifest: PluginManifest): void {
  new PluginRegistry().registerPlugin(
    manifest,
    () => ({
      invoke: async () => ({ status: "success", summary: {}, artifacts: [] }),
    }),
    {},
  );
}

function assertReleaseRelative(root: string, value: string, label: string): void {
  if (isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error(`${label} must stay inside release root`);
  }
  assertInside(root, resolve(root, value), label);
}

function assertNoEscapingSymlinks(root: string): void {
  for (const path of listEntries(root)) {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) {
      continue;
    }
    const target = realpathSync(path);
    try {
      assertInside(root, target, "symlink");
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "symlink escapes root",
      );
    }
  }
}

function listEntries(root: string): string[] {
  if (!existsSync(root)) {
    throw new Error(`release root does not exist: ${root}`);
  }
  const entries: string[] = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    entries.push(path);
    if (item.isDirectory()) {
      entries.push(...listEntries(path));
    }
  }
  return entries;
}

function listFiles(root: string): string[] {
  return listEntries(root).filter((path) => lstatSync(path).isFile());
}

function assertInside(root: string, child: string, label: string): void {
  const rootPath = realpathSync(root);
  const childPath = existsSync(child) ? realpathSync(child) : resolve(child);
  const rel = relative(rootPath, childPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes root`);
  }
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch`);
  }
}

function isLunaApiCompatible(
  current: string,
  range: string | undefined,
): boolean {
  return range === current || range === `^${current}` || range === "^0.1.0";
}
