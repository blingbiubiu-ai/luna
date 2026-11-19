/*
 * The Executor and the in-container `luna` CLI, built before the Worker and embedded in its
 * bundle as text. Only runner-runtime.ts imports this module, and only dynamically: a Worker
 * run from source before they are built falls back to the copies baked into the image.
 */
// @ts-ignore Build output without type declarations; absent until the Executor is built.
import executor from "../../executor/dist/executor.js" with { type: "text" };
// @ts-ignore Build output without type declarations; absent until the Executor is built.
import jobMain from "../../executor/dist/job-main.js" with { type: "text" };
// @ts-ignore Build output without type declarations; absent until the Executor is built.
import jobProcess from "../../executor/dist/job-process.js" with { type: "text" };
// @ts-ignore Build output without type declarations; absent until the Executor is built.
import ptyMain from "../../executor/dist/pty-main.js" with { type: "text" };
// @ts-ignore Build output without type declarations; absent until the CLI is built.
import client from "../../cli/dist/luna-client.js" with { type: "text" };

export const runnerRuntimeFiles: Record<string, string> = {
  "executor.js": String(executor), "job-main.js": String(jobMain), "job-process.js": String(jobProcess), "pty-main.js": String(ptyMain), "luna-client.js": String(client),
};
