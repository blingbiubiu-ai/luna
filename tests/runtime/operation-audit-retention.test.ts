import { describe, expect, test } from "bun:test";

import { OperationAuditRetentionScheduler } from "@/plugins";

describe("OperationAuditRetentionScheduler", () => {
  test("cleans on startup and schedules periodic cleanup until stopped", () => {
    const cleanupCalls: number[] = [];
    const cleared: unknown[] = [];
    const timer = { unref: () => undefined };
    let scheduled: (() => void) | undefined;

    const scheduler = new OperationAuditRetentionScheduler({
      store: {
        cleanupExpired: () => {
          cleanupCalls.push(Date.now());
          return 0;
        },
      },
      intervalMs: 123,
      setInterval: ((callback: () => void, intervalMs: number) => {
        expect(intervalMs).toBe(123);
        scheduled = callback;
        return timer;
      }) as unknown as typeof setInterval,
      clearInterval: ((value: unknown) => {
        cleared.push(value);
      }) as typeof clearInterval,
    });

    scheduler.start();
    expect(cleanupCalls).toHaveLength(1);
    scheduled?.();
    expect(cleanupCalls).toHaveLength(2);
    scheduler.stop();
    expect(cleared).toEqual([timer]);
  });
});
