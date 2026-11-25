import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const wrapperArchives = [
  "dists/gradle-7.6.3-all/pg6m5ekptetatomzxo7mz3fh/gradle-7.6.3-all.zip",
  "dists/gradle-7.6.3-1.2.3-RC9/8zl7x97lulz2onboq6o014zge/gradle-7.6.3-1.2.3-RC9.zip",
  "dists/gradle-8.2-bin/ectwm6q8tc3mcov8rkhorls2s/gradle-8.2-bin.zip",
];

function seedLink(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  try { symlinkSync(source, target); }
  catch (error) {
    // Concurrent Jobs share HOME. Never replace user files or existing links.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Former entrypoint initialization, executed as the Runner UID before every provider. */
export function prepareRunnerEnvironment(
  input: Readonly<NodeJS.ProcessEnv>,
  assets: { gradleWrapper: string; fswatch: string; runtimeBin?: string } = {
    gradleWrapper: "/opt/luna-cache/gradle-wrapper",
    fswatch: "/usr/bin/fswatch",
    runtimeBin: "/opt/luna-runtime/current/bin",
  },
): NodeJS.ProcessEnv {
  const env = { ...input };
  if (!env.HOME) throw new Error("Runner HOME is required");
  env.npm_config_prefix ||= env.NPM_CONFIG_PREFIX || join(env.HOME, ".npm-global");
  const npmBin = join(env.npm_config_prefix, "bin");
  const path = (env.PATH ?? "").split(":").filter(Boolean);
  const runtimeBin = assets.runtimeBin;
  if (runtimeBin && existsSync(runtimeBin) && !path.includes(runtimeBin)) {
    const usrLocalIdx = path.indexOf("/usr/local/bin");
    if (usrLocalIdx >= 0) path.splice(usrLocalIdx, 0, runtimeBin);
    else path.unshift(runtimeBin);
  }
  if (!path.includes(npmBin)) path.push(npmBin);
  env.PATH = path.join(":");
  env.GRADLE_USER_HOME ||= join(env.HOME, ".gradle");
  env.KONAN_DATA_DIR ||= join(env.HOME, ".konan");
  env.ANDROID_USER_HOME ||= join(env.HOME, ".android");
  for (const directory of [env.npm_config_prefix, env.GRADLE_USER_HOME, env.KONAN_DATA_DIR, env.ANDROID_USER_HOME]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const archive of wrapperArchives) {
    seedLink(join(assets.gradleWrapper, archive), join(env.GRADLE_USER_HOME, "wrapper", archive));
  }
  seedLink(assets.fswatch, join(env.HOME, ".remoteX/fswatch/linux-amd64/fswatch"));

  // Supply safe.directory=* as process config without rewriting or racing on shared gitconfig.
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid GIT_CONFIG_COUNT");
  env[`GIT_CONFIG_KEY_${count}`] = "safe.directory";
  env[`GIT_CONFIG_VALUE_${count}`] = "*";
  env.GIT_CONFIG_COUNT = String(count + 1);
  return env;
}
