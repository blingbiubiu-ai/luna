import type { kernel } from "@/kernel";

type RuntimeKernel = typeof kernel;

/**
 * Executes get Kernel logic for HTTP route DTO.
 */
export function getKernel(): RuntimeKernel {
  const module = require("@/kernel") as { kernel: RuntimeKernel };
  return module.kernel;
}
