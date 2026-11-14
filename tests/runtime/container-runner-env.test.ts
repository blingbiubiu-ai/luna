import { describe, expect, test } from "bun:test";

import { rewriteLocalhostForContainer } from "../../src/runners/container-service-url";

describe("container runner environment", () => {
  test("rewrites only loopback addresses for local containers", () => {
    expect(rewriteLocalhostForContainer({ LUNA_SERVICE_URL: "http://127.0.0.1:8090" }).LUNA_SERVICE_URL).toBe("http://host.docker.internal:8090");
    expect(rewriteLocalhostForContainer({ LUNA_SERVICE_URL: "https://luna.example.com" }).LUNA_SERVICE_URL).toBe("https://luna.example.com");
  });
  test("preserves remote Service addresses and bypasses the local Docker gateway proxy", () => {
    expect(rewriteLocalhostForContainer({
      LUNA_SERVICE_URL: "http://192.0.2.10:8090",
      HTTP_PROXY: "http://proxy.example:8118",
      NO_PROXY: "localhost,127.0.0.1,192.0.2.0/24",
      no_proxy: "localhost",
    })).toMatchObject({
      LUNA_SERVICE_URL: "http://192.0.2.10:8090",
      HTTP_PROXY: "http://proxy.example:8118",
      NO_PROXY: "localhost,127.0.0.1,192.0.2.0/24,host.docker.internal",
      no_proxy: "localhost,host.docker.internal",
    });
  });
});
