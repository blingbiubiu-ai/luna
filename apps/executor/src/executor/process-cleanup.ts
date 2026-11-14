import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

interface ProcessIdentity {
  pid: number;
  parent: number;
  state: string;
  start: string;
}

function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0], parent = fields[1], start = fields[19];
    if (state && parent && start) return { pid, parent: Number(parent), state, start };
  } catch (error) {
    if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  return undefined;
}

/** Linux process birth ticks distinguish a live process from later PID reuse. */
export function processStartTime(pid: number): string {
  const identity = processIdentity(pid);
  if (!identity || !/^\d+$/.test(identity.start)) throw new Error("Invalid Linux process identity");
  return identity.start;
}

function descendants(parent: number): ProcessIdentity[] {
  const children = new Map<number, ProcessIdentity[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const identity = processIdentity(Number(name));
    if (!identity) continue;
    const siblings = children.get(identity.parent) ?? [];
    siblings.push(identity);
    children.set(identity.parent, siblings);
  }
  const family = [...(children.get(parent) ?? [])];
  for (const child of family) family.push(...(children.get(child.pid) ?? []));
  return family.filter(child => child.state !== "Z");
}

/** Called by the Job's subreaper, which adopts descendants that outlive their original parent. */
export async function cleanupJobChildren(): Promise<void> {
  const started = Date.now();
  for (;;) {
    const running = descendants(process.pid);
    if (!running.length) return;
    const elapsed = Date.now() - started;
    if (elapsed >= 7000) throw new Error("Job process cleanup incomplete");
    for (const child of running.reverse()) {
      try {
        if (processIdentity(child.pid)?.start === child.start) {
          process.kill(child.pid, elapsed < 500 ? "SIGTERM" : "SIGKILL");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await delay(25);
  }
}
