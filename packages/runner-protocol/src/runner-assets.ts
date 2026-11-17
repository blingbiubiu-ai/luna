import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const absoluteRunnerPath = z.string().min(1).refine(
  value => isAbsolute(value) && !value.includes("\0") && !value.includes(","),
  "Runner path must be an absolute mount path",
);

export const RunnerLayout = z.object({
  home: absoluteRunnerPath,
  runners: absoluteRunnerPath,
}).strict();
export type RunnerLayout = z.infer<typeof RunnerLayout>;

export function runnerResourcesPath(home: string): string {
  return join(home, ".luna-resources");
}

export function runnerAssetPaths(home: string) {
  const resources = runnerResourcesPath(home);
  return {
    skillPlugin: join(resources, "skills"),
    commands: join(resources, "commands"),
  };
}
