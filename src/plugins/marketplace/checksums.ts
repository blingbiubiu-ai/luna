import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256Content(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Content(readFileSync(path));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
