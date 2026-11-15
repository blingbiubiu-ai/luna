import { describe, expect, test } from "bun:test";
import { effectiveCpus } from "@luna/worker/docker-driver";

describe("effectiveCpus", () => {
  test("caps the requested quota at the Docker host CPU count", () => {
    expect(effectiveCpus(8, 3)).toBe(3);
  });
  test("keeps requests that fit the host", () => {
    expect(effectiveCpus(2, 16)).toBe(2);
    expect(effectiveCpus(0.5, 1)).toBe(0.5);
  });
  test("falls back to the request when the host count is unknown", () => {
    expect(effectiveCpus(8, 0)).toBe(8);
  });
});
