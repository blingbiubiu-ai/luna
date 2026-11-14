import { describe, expect, test } from "bun:test";

import { GatewayError } from "../../src/server/gateway-error";

describe("GatewayError", () => {
  test("serializes safe error fields", () => {
    const error = new GatewayError("403_forbidden", "permission denied", 403, "tr_1");

    expect(error.toJSON()).toEqual({
      code: "403_forbidden",
      message: "permission denied",
      status: 403,
      traceId: "tr_1",
    });
  });
});
