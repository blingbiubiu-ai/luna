import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { WorkerModelRelease } from "@luna/runner-protocol";
import { ExecutionError } from "@luna/execution-store";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function sortJson(value:unknown):unknown{
  if(Array.isArray(value))return value.map(sortJson);
  if(value===null || typeof value!=="object")return value;
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sortJson(v)]));
}
function safePath(root: string, name: string): string {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..")) {
    throw new ExecutionError(422, "model_release_path_invalid");
  }
  const path = resolve(root, name);
  for (let current = path; current !== root; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ExecutionError(422, "model_release_symlink");
  }
  return path;
}

/** Verify every asset before writing anything; a changed immutable cache fails closed. */
export function installModelRelease(dataRoot: string, raw: unknown): { entrypoint: string; release: WorkerModelRelease } {
  const release = WorkerModelRelease.parse(raw);
  const checksums = JSON.parse(release.checksums) as { schemaVersion: number; files: { path: string; sha256: string }[] };
  if (hash(JSON.stringify(sortJson(checksums))) !== release.releaseSha256) throw new ExecutionError(422, "model_release_checksum_invalid");
  if (checksums.schemaVersion !== 1 || !Array.isArray(checksums.files)) throw new ExecutionError(422, "model_release_checksum_invalid");
  const root = resolve(dataRoot, "plugins", "releases", release.pluginId, release.releaseSha256);
  for(let current=root;current!==resolve(dataRoot);current=dirname(current)){
    if(existsSync(current) && lstatSync(current).isSymbolicLink())throw new ExecutionError(422,"model_release_symlink");
  }
  const expected = new Map(checksums.files.map(file => [file.path, file.sha256]));
  if (expected.size !== checksums.files.length || release.files.length !== expected.size) throw new ExecutionError(422, "model_release_files_invalid");
  const contents = new Map<string, Buffer>();
  let total = 0;
  for (const file of release.files) {
    safePath(root, file.path);
    if (contents.has(file.path)) throw new ExecutionError(422, "model_release_files_invalid");
    const bytes = Buffer.from(file.content, "base64");
    total += bytes.length;
    if (total > 16 * 1024 * 1024 || hash(bytes) !== expected.get(file.path)) throw new ExecutionError(422, "model_release_files_invalid");
    contents.set(file.path, bytes);
  }
  const manifest = JSON.parse(contents.get("manifest.json")?.toString() ?? "null");
  if (manifest?.id !== release.pluginId || manifest?.agentScopeVersion !== 2
    || !manifest.workerModelProviders?.some((p: { id: string; entrypoint: string; protocols: string[] }) =>
      p.id === release.providerId && p.entrypoint === release.entrypoint && p.protocols.length === 1 && p.protocols[0] === "responses")
    || !contents.has(release.entrypoint) || !contents.has("plugin.js") || !contents.has("package.json")) {
    throw new ExecutionError(422, "model_release_manifest_invalid");
  }
  const entrypoint = safePath(root, release.entrypoint);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rel = relative(realpathSync(dataRoot), realpathSync(root));
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new ExecutionError(422, "model_release_path_invalid");
  for (const [name, bytes] of contents) {
    const path = safePath(root, name);
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || hash(readFileSync(path)) !== expected.get(name)) throw new ExecutionError(409, "model_release_cache_changed");
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
    }
  }
  return { entrypoint, release };
}
