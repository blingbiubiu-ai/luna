import type { ContainerInput } from "./types";

export function buildChildEnvironment(
  container: Readonly<NodeJS.ProcessEnv>,
  job: ContainerInput["env"],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...container, ...job, IS_SANDBOX: "1" };
  const noProxy = [...new Set(
    [container.NO_PROXY, container.no_proxy, job?.NO_PROXY, job?.no_proxy]
      .flatMap((value) => (value ?? "").split(","))
      .map((entry) => entry.trim())
      .filter(Boolean),
  )].join(",");
  if (noProxy) {
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}
