import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  PluginManifestValidationError,
  PluginRegistry,
  loadEnabledPlugins,
  type PluginManifest,
  type PluginRuntimeFactory,
} from "@/plugins";

const manifest = {
  id: "alpha",
  displayName: "Alpha",
  version: "1.0.0",
  source: "bundled",
  requestedHostPermissions: ["artifact.create"],
  operations: [
    {
      id: "alpha.echo",
      pluginId: "alpha",
      title: "Echo",
      inputSchema: { type: "object" },
      riskLevel: "low",
      artifactPolicy: "none",
    },
  ],
  commands: [
    {
      path: ["alpha", "echo"],
      operationId: "alpha.echo",
      argsSchema: { type: "object" },
      help: "Echo input",
    },
  ],
  tools: [
    {
      name: "alpha_echo",
      operationId: "alpha.echo",
      description: "Echo input",
      inputSchema: { type: "object" },
    },
  ],
  skills: [],
} satisfies PluginManifest;

const createRuntime: PluginRuntimeFactory = () => ({
  invoke: async () => ({ status: "success", summary: {}, artifacts: [] }),
});

describe("plugin registry", () => {
  test("loads enabled bundled plugins and registers contributions", () => {
    const registry = loadEnabledPlugins({
      enabledPluginIds: ["alpha"],
      bundledPlugins: [{ manifest, createRuntime }],
      configByPluginId: { alpha: {} },
    });

    expect(registry.getPlugin("alpha")?.manifest.displayName).toBe("Alpha");
    expect(registry.getOperation("alpha.echo")?.pluginId).toBe("alpha");
    expect(registry.resolveCommand(["alpha", "echo"])?.operationId).toBe(
      "alpha.echo",
    );
    expect(registry.getTool("alpha_echo")?.operationId).toBe("alpha.echo");
  });

  test("assigns plugin ownership to manifest operations by default", () => {
    const ownerlessManifest = {
      ...manifest,
      operations: [
        {
          id: "alpha.ownerless",
          title: "Ownerless",
          inputSchema: { type: "object" },
          riskLevel: "low",
          artifactPolicy: "none",
        },
      ],
      commands: [
        {
          path: ["alpha"],
          operationId: "alpha.ownerless",
        },
      ],
      tools: [],
    } satisfies PluginManifest;

    const registry = loadEnabledPlugins({
      enabledPluginIds: ["alpha"],
      bundledPlugins: [{ manifest: ownerlessManifest, createRuntime }],
      configByPluginId: { alpha: {} },
    });

    expect(registry.getOperation("alpha.ownerless")).toMatchObject({
      pluginId: "alpha",
      providerType: "plugin",
    });
  });

  test("does not register disabled bundled plugins", () => {
    const registry = loadEnabledPlugins({
      enabledPluginIds: [],
      bundledPlugins: [{ manifest, createRuntime }],
      configByPluginId: {},
    });

    expect(registry.getPlugin("alpha")).toBeUndefined();
    expect(registry.getOperation("alpha.echo")).toBeUndefined();
  });

  test("rejects duplicate operation ids", () => {
    const duplicate = {
      ...manifest,
      operations: [manifest.operations[0]!, { ...manifest.operations[0]! }],
    } satisfies PluginManifest;

    expect(() =>
      loadEnabledPlugins({
        enabledPluginIds: ["alpha"],
        bundledPlugins: [{ manifest: duplicate, createRuntime }],
        configByPluginId: { alpha: {} },
      }),
    ).toThrow(PluginManifestValidationError);
  });

  test("rejects command path collisions", () => {
    const registry = new PluginRegistry();
    registry.registerPlugin(manifest, createRuntime, {});

    expect(() => registry.registerPlugin(manifest, createRuntime, {})).toThrow(
      PluginManifestValidationError,
    );
  });

  test("keeps command paths distinct when path parts contain spaces", () => {
    const spaceyManifest = {
      ...manifest,
      operations: [
        manifest.operations[0]!,
        {
          id: "alpha.spacey",
          pluginId: "alpha",
          title: "Spacey",
          inputSchema: { type: "object" },
          riskLevel: "low",
          artifactPolicy: "none",
        },
      ],
      commands: [
        {
          path: ["alpha b"],
          operationId: "alpha.echo",
        },
        {
          path: ["alpha", "b"],
          operationId: "alpha.spacey",
        },
      ],
    } satisfies PluginManifest;

    const registry = loadEnabledPlugins({
      enabledPluginIds: ["alpha"],
      bundledPlugins: [{ manifest: spaceyManifest, createRuntime }],
      configByPluginId: { alpha: {} },
    });

    expect(registry.resolveCommand(["alpha b"])?.operationId).toBe("alpha.echo");
    expect(registry.resolveCommand(["alpha", "b"])?.operationId).toBe(
      "alpha.spacey",
    );
  });

  test("rejects unknown host permissions at runtime manifest validation", () => {
    expect(() =>
      loadEnabledPlugins({
        enabledPluginIds: ["alpha"],
        bundledPlugins: [
          {
            manifest: {
              ...manifest,
              requestedHostPermissions: ["artifact.create", "unknown.host"],
            } as PluginManifest,
            createRuntime,
          },
        ],
        configByPluginId: { alpha: {} },
      }),
    ).toThrow(PluginManifestValidationError);
  });

  test("loader rejects missing plugin skill files", () => {
    expect(() =>
      loadEnabledPlugins({
        enabledPluginIds: ["alpha"],
        bundledPlugins: [
          {
            manifest: {
              ...manifest,
              skills: [
                {
                  id: "alpha.missing-skill",
                  path: "plugins/alpha/skills/missing/SKILL.md",
                },
              ],
            },
            createRuntime,
          },
        ],
        configByPluginId: { alpha: {} },
        repoRoot: "/tmp/luna-plugin-missing-skill-root",
      }),
    ).toThrow(PluginManifestValidationError);
  });

  test("loader accepts existing plugin skill files", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-plugin-registry-"));
    try {
      const skillDir = join(root, "plugins", "alpha", "skills", "echo");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: echo\n---\n");
      const registry = loadEnabledPlugins({
        enabledPluginIds: ["alpha"],
        bundledPlugins: [
          {
            manifest: {
              ...manifest,
              skills: [
                {
                  id: "alpha.echo-skill",
                  path: "plugins/alpha/skills/echo/SKILL.md",
                },
              ],
            },
            createRuntime,
          },
        ],
        configByPluginId: { alpha: {} },
        repoRoot: root,
      });

      expect(registry.getSkill("alpha.echo-skill")?.id).toBe("alpha.echo-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("manifest default permission rules", () => {
  test("resolves deny over allow independently of order, with explicit overrides", () => {
    const rules = [
      { pattern: "alpha.*", effect: "allow" },
      { pattern: "alpha.restricted.*", effect: "deny" },
      { pattern: "alpha.restricted.child", effect: "allow" },
    ] as const;
    for (const ordered of [rules, [...rules].reverse()]) {
      const registry = new PluginRegistry();
      const original: PluginManifest = {
        ...manifest,
        defaultPermissionRules: ordered,
        operations: [
          manifest.operations[0]!,
          { ...manifest.operations[0]!, id: "alpha.restricted" },
          { ...manifest.operations[0]!, id: "alpha.restricted.child" },
          { ...manifest.operations[0]!, id: "alpha.restricted.override", defaultDecision: "allow" },
          { ...manifest.operations[0]!, id: "alpha.explicit-deny", defaultDecision: "deny" },
        ],
      };
      registry.registerPlugin(original, createRuntime, {});
      expect(registry.getOperation("alpha.echo")?.defaultDecision).toBe("allow");
      expect(registry.getOperation("alpha.restricted")?.defaultDecision).toBe("deny");
      expect(registry.getOperation("alpha.restricted.child")?.defaultDecision).toBe("deny");
      expect(registry.getOperation("alpha.restricted.override")?.defaultDecision).toBe("allow");
      expect(registry.getOperation("alpha.explicit-deny")?.defaultDecision).toBe("deny");
      expect(registry.getOperation("alpha.*")).toBeUndefined();
      expect(original.operations[0]?.defaultDecision).toBeUndefined();
    }
  });

  test("old manifests and unmatched operations default to deny", () => {
    for (const rules of [undefined, [], [{ pattern: "alpha.echo.child.*", effect: "allow" as const }]]) {
      const registry = new PluginRegistry();
      registry.registerPlugin({ ...manifest, ...(rules === undefined ? {} : { defaultPermissionRules: rules }) }, createRuntime, {});
      expect(registry.getOperation("alpha.echo")?.defaultDecision).toBe("deny");
    }
  });

  test("rejects malformed rules and foreign namespaces atomically", () => {
    for (const rules of [
      null, {}, "alpha.*", [null], [{}],
      [{ pattern: "alpha.*", effect: "ask" }],
      ...["*", "alpha.**", "alpha.*.echo", "beta.*", "alpha2.*", " alpha.*", "alpha."].map(pattern => [{ pattern, effect: "allow" }]),
    ]) {
      const registry = new PluginRegistry();
      expect(() => registry.registerPlugin({ ...manifest, defaultPermissionRules: rules } as unknown as PluginManifest, createRuntime, {})).toThrow(PluginManifestValidationError);
      expect(registry.listOperations()).toHaveLength(0);
      expect(registry.listPlugins()).toHaveLength(0);
    }
    expect(() => new PluginRegistry().registerPlugin({ ...manifest, operations: [{ ...manifest.operations[0]!, defaultDecision: "ask" }] } as unknown as PluginManifest, createRuntime, {})).toThrow(PluginManifestValidationError);
  });
});

 test("proxy plugins may set defaults for their declared CLI namespaces", () => {
   const registry = new PluginRegistry();
   registry.registerPlugin({ ...manifest, id: "cli-proxy", operations: [{...manifest.operations[0]!,pluginId:"cli-proxy"}], defaultPermissionRules:[{pattern:"alpha.*",effect:"allow"}] }, createRuntime, {});
   expect(registry.getOperation("alpha.echo")?.defaultDecision).toBe("allow");
 });
