import { describe, expect, test } from "bun:test";

import { createRootLoggerOptions } from "../../src/shared/logging/index";

describe("runtime logging", () => {
  test("uses structured JSON logging by default", () => {
    const options = createRootLoggerOptions({}, () => {
      throw new Error("pino-pretty should not be resolved by default");
    });

    expect(options.level).toBe("info");
    expect(options.transport).toBeUndefined();
  });

  test("enables pretty logs only when explicitly requested and resolvable", () => {
    const options = createRootLoggerOptions(
      {
        LUNA_LOG_LEVEL: "debug",
        LUNA_LOG_PRETTY: "true",
        NODE_ENV: "production",
      },
      () => "/tmp/pino-pretty.js",
    );

    expect(options.level).toBe("debug");
    expect(options.transport).toMatchObject({
      target: "/tmp/pino-pretty.js",
      options: {
        translateTime: "SYS:MM-DD HH:MM:ss",
      },
    });
  });

  test("falls back to structured logs when pretty transport is unavailable", () => {
    const options = createRootLoggerOptions({ LUNA_LOG_PRETTY: "true" }, () => undefined);

    expect(options.transport).toBeUndefined();
  });
});
