import { describe, expect, test } from "bun:test";

import {
  HOST_PERMISSIONS,
  isHostPermission,
  PluginCommandInputError,
} from "@luna/plugin-contracts";

describe("plugin-contracts", () => {
  test("host.exec is a host permission", () => {
    expect(HOST_PERMISSIONS).toContain("host.exec");
    expect(isHostPermission("host.exec")).toBe(true);
  });

  test("PluginCommandInputError has stable code", () => {
    const err = new PluginCommandInputError("bad input");
    expect(err.code).toBe("plugin_command_input_invalid");
    expect(err.message).toBe("bad input");
    expect(err).toBeInstanceOf(Error);
  });
});
