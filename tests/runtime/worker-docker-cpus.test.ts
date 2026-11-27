import { describe, expect, test } from "bun:test";
import {
  effectiveContainerCpus,
  effectiveCpus,
  effectiveMemoryBytes,
  memoryBytes,
  recommendedWorkerCapacity,
} from "@luna/worker/docker-driver";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

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

describe("effectiveContainerCpus", () => {
  test("reserves 0.5 vCPU for host OS and relay on 2-4 core hosts", () => {
    expect(effectiveContainerCpus(8, 2)).toBe(1.5);
    expect(effectiveContainerCpus(2, 2)).toBe(1.5);
    expect(effectiveContainerCpus(8, 4)).toBe(3.5);
    expect(effectiveContainerCpus(1, 2)).toBe(1);
  });
  test("keeps full requested quota on larger hosts", () => {
    expect(effectiveContainerCpus(8, 16)).toBe(8);
    expect(effectiveContainerCpus(8, 0)).toBe(8);
  });
});

describe("effectiveMemoryBytes", () => {
  test("caps 32g default safely on 2C/4G (3.5 GiB) devbox hosts", () => {
    const req32g = memoryBytes("32g");
    // 3.5 GiB host -> reserves 1 GiB -> container gets 2.5 GiB
    expect(effectiveMemoryBytes(req32g, 3.5 * GIB)).toBe(2.5 * GIB);
    // 4 GiB host -> reserves 1 GiB -> container gets 3 GiB
    expect(effectiveMemoryBytes(req32g, 4 * GIB)).toBe(3 * GIB);
  });
  test("caps reserve at 4 GiB on medium/large hosts and keeps fitting requests", () => {
    expect(effectiveMemoryBytes(memoryBytes("32g"), 16 * GIB)).toBe(12 * GIB);
    expect(effectiveMemoryBytes(memoryBytes("32g"), 64 * GIB)).toBe(32 * GIB);
    expect(effectiveMemoryBytes(memoryBytes("2g"), 16 * GIB)).toBe(2 * GIB);
  });
  test("floors container memory at 512 MiB on tiny hosts", () => {
    expect(effectiveMemoryBytes(memoryBytes("32g"), 1.2 * GIB)).toBe(512 * MIB);
  });
});

describe("recommendedWorkerCapacity", () => {
  test("scales capacity to host CPU and RAM", () => {
    expect(recommendedWorkerCapacity(2, 3.5 * GIB)).toBe(1);
    expect(recommendedWorkerCapacity(2, 4 * GIB)).toBe(1);
    expect(recommendedWorkerCapacity(4, 8 * GIB)).toBe(2);
    expect(recommendedWorkerCapacity(16, 32 * GIB)).toBe(8);
  });
});
