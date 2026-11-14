import pino from "pino";
import { createRequire } from "node:module";

const VALID_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

type LoggerEnv = {
  LUNA_LOG_LEVEL?: string;
  LUNA_LOG_PRETTY?: string;
  NODE_ENV?: string;
};

function parseLevel(env: LoggerEnv = process.env): pino.Level {
  const raw = env.LUNA_LOG_LEVEL?.toLowerCase();
  if (raw && VALID_LEVELS.includes(raw as (typeof VALID_LEVELS)[number])) {
    return raw as pino.Level;
  }
  return "info";
}

function wantsPrettyLogs(env: LoggerEnv = process.env): boolean {
  const raw = env.LUNA_LOG_PRETTY?.toLowerCase();
  return raw ? TRUE_VALUES.has(raw) : false;
}

const requireFromHere = createRequire(import.meta.url);

function resolvePrettyTransportTarget(): string | undefined {
  try {
    return requireFromHere.resolve("pino-pretty");
  } catch {
    return undefined;
  }
}

export function createRootLoggerOptions(
  env: LoggerEnv = process.env,
  resolvePrettyTarget: () => string | undefined = resolvePrettyTransportTarget,
): pino.LoggerOptions {
  const options: pino.LoggerOptions = {
    level: parseLevel(env),
  };
  const prettyTarget = wantsPrettyLogs(env) ? resolvePrettyTarget() : undefined;
  if (prettyTarget) {
    const isProd = env.NODE_ENV === "production";
    return {
      ...options,
      transport: {
        target: prettyTarget,
        options: {
          colorize: true,
          translateTime: isProd ? "SYS:MM-DD HH:MM:ss" : "SYS:HH:MM:ss",
          ignore: "hostname,pid,topic",
        },
      },
    };
  }
  return options;
}

const rootOptions = createRootLoggerOptions();

const rootLogger = pino(rootOptions);
const DEFAULT_LOGGER_TOPIC = "luna-agent-runtime";

/** Default logger with topic "luna-agent-runtime" (no topic shown in output). */
export const logger = rootLogger.child({ topic: DEFAULT_LOGGER_TOPIC });

/**
 * Creates a child logger with the given topic. Use for session-scoped or
 * context-specific logging.
 *
 * @param topic - Topic string (e.g. `session-${sessionId}`).
 * @returns A Pino child logger with topic binding.
 */
export function createLogger(topic: string): pino.Logger {
  return rootLogger.child({
    topic,
    ...(topic !== DEFAULT_LOGGER_TOPIC && { name: topic }),
  });
}

export type { Logger } from "pino";
