import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function prepareCodexSkills(
  env: NodeJS.ProcessEnv,
  resources: string,
  codexHome: string,
): Promise<void> {
  const { version } = JSON.parse(
    readFileSync(join(resources, "skills", ".codex-plugin", "plugin.json"), "utf8"),
  ) as { version: string };
  const installed = join(
    codexHome,
    "plugins",
    "cache",
    "luna-platform",
    "luna-skills",
    version,
    ".codex-plugin",
    "plugin.json",
  );
  mkdirSync(codexHome, { recursive: true });
  const proc = Bun.spawn([
    "flock",
    join(codexHome, ".luna-skills.lock"),
    "sh",
    "-ec",
    'if [ ! -f "$2" ]; then codex plugin marketplace remove luna-platform >/dev/null 2>&1 || true; '
      + 'codex plugin marketplace add "$1" && codex plugin add luna-skills@luna-platform; fi',
    "sh",
    resources,
    installed,
  ], { env, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`Failed to load Luna Skills in Codex: ${stderr.trim()}`);
}
