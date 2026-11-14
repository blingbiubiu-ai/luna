import { spawn } from "node:child_process";
import { dlopen, FFIType } from "bun:ffi";
import { cleanupJobChildren } from "./process-cleanup";

const PR_SET_CHILD_SUBREAPER = 36;

async function main(): Promise<number> {
  const [uid, gid, home, entry] = process.argv.slice(2);
  if (!uid || !gid || !home || !entry) throw new Error("Missing Runner process configuration");
  const libc = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  });
  if (libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0) throw new Error("Unable to register Job subreaper");
  libc.close();

  let cleanup: Promise<void> | undefined;
  const clean = () => cleanup ??= cleanupJobChildren();
  const stop = () => { void clean().catch(() => {}); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const child = spawn("/usr/bin/setpriv", [
    `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups",
    "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs",
    "--", process.execPath, entry,
  ], { cwd: home, stdio: "inherit" });
  const code = await new Promise<number>((resolve) => {
    child.once("exit", code => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
  await clean();
  return code;
}

if (import.meta.main) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(error instanceof Error ? error.message : "Job process cleanup failed");
    process.exit(125);
  });
}
