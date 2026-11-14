import { describe, expect, test } from "bun:test";

import { DEFAULT_OPERATION_POLICIES } from "../../src/operations/operation-registry";

describe("legacy lark core removed", () => {
  test("no lark.* in DEFAULT_OPERATION_POLICIES (moved to plugin)", () => {
    const larkCore = DEFAULT_OPERATION_POLICIES.filter((p) => p.id.startsWith("lark."));
    expect(larkCore).toEqual([]);
  });
});
