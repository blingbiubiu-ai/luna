import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync, renameSync, realpathSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

export const resourceNames = [".runner-skills", ".runner-bin", "memory", ".runner_prompt"] as const;
export type ResourceName = typeof resourceNames[number];
export interface ResourceFile { path: string; content: string; mode: number; }
export interface ResourceBundle { revision: string; files: ResourceFile[]; }
export const resourceDigest = (files: ResourceFile[]) => createHash("sha256").update(JSON.stringify(files)).digest("hex");
const MAX_BYTES = 128 * 1024 * 1024;
export function collectRunnerResources(home: string, overrides: Partial<Record<ResourceName, string>> = {}): ResourceBundle {
  const files: ResourceFile[] = []; let size = 0;
  function visit(path: string, relative: string, ancestors: Set<string>) {
    const actual = realpathSync(path);
    if (ancestors.has(actual)) throw new Error("Resource symlink cycle");
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const next = new Set(ancestors).add(actual);
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`, next);
    } else if (stat.isFile()) {
      size += stat.size; if (size > MAX_BYTES || files.length >= 20000) throw new Error("Runner resources exceed limit");
      files.push({ path: relative, content: readFileSync(path).toString("base64"), mode: stat.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  for (const name of resourceNames) { const path = overrides[name] ?? join(home, name); if (existsSync(path)) visit(path, name, new Set()); }
  return { revision: resourceDigest(files), files };
}
export function validateRunnerResources(input: unknown): ResourceBundle {
  const bundle = input as ResourceBundle;
  if (!bundle || !Array.isArray(bundle.files) || bundle.files.length > 20000 || !/^[a-f0-9]{64}$/.test(bundle.revision)) throw new Error("Invalid resource bundle");
  let size = 0; const paths = new Set<string>();
  for (const file of bundle.files) {
    if (typeof file.path !== "string" || !resourceNames.includes(file.path.split("/")[0] as ResourceName)
      || file.path.split("/").length < 2 || file.path.split("/").some(p => !p || p === "." || p === "..") || /[\\\0]/.test(file.path)
      || typeof file.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)
      || ![0o644, 0o755].includes(file.mode) || paths.has(file.path)) throw new Error("Invalid resource entry");
    paths.add(file.path); size += Buffer.byteLength(file.content, "base64");
    if (size > MAX_BYTES) throw new Error("Runner resources exceed limit");
  }
  if (resourceDigest(bundle.files) !== bundle.revision) throw new Error("Resource digest mismatch");
  return bundle;
}
/** Caller must stop all consumers first and persist applying before calling. */
export function applyRunnerResources(home: string, bundle: ResourceBundle, overrides: Partial<Record<ResourceName, string>> = {}): void {
  validateRunnerResources(bundle);
  const staged = new Map<ResourceName, string>();
  try {
    for (const name of resourceNames) {
      const target = overrides[name] ?? join(home, name);
      const temp = `${target}.tmp-${process.pid}`;
      rmSync(temp, { recursive: true, force: true }); mkdirSync(temp, { recursive: true }); staged.set(name, temp);
    }
    for (const file of bundle.files) {
      const [name, ...parts] = file.path.split("/");
      const root = staged.get(name as ResourceName)!; const target = resolve(root, ...parts);
      if (!target.startsWith(resolve(root) + sep)) throw new Error("Invalid resource path");
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(file.content, "base64"), { mode: file.mode });
    }
    for (const name of resourceNames) {
      const target = overrides[name] ?? join(home, name);
      rmSync(target, { recursive: true, force: true }); renameSync(staged.get(name)!, target);
    }
  } finally { for (const temp of staged.values()) rmSync(temp, { recursive: true, force: true }); }
}
