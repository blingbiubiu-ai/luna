import { createLogger } from "./shared";

import { startAgentRuntime, stopAgentRuntime } from "./runtime";

const _logger = createLogger("agent-runtime-main");

let _stopping = false;

/**
 * Start the runtime as a foreground process.
 */
async function _main(): Promise<void> {
  await startAgentRuntime();
  _logger.info("Agent runtime foreground process started");
  const keepAlive = setInterval(() => {}, 60_000);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      resolve();
    });
    process.once("SIGTERM", () => {
      resolve();
    });
  });
  clearInterval(keepAlive);
  await _stop();
}

async function _stop(): Promise<void> {
  if (_stopping) {
    return;
  }
  _stopping = true;
  await stopAgentRuntime();
  _logger.info("Agent runtime foreground process stopped");
}

_main().catch((err: unknown) => {
  _logger.error({ err }, "Agent runtime foreground process failed");
  process.exitCode = 1;
});
