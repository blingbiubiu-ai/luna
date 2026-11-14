import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { DataConnection } from "@/data";
import * as lunaSchema from "@/data/schema";
import { pluginInstallations } from "@/data/schema";
import { config, setLunaHome } from "@/shared";
import { AppConfig as AppConfigSchema } from "@/shared/config/schema";
import { loadInstalledPlugins } from "@/plugins/installed-loader";
import {
  canonicalJson,
  sha256Content,
  sha256File,
} from "@/plugins/marketplace/checksums";
import { parseMarketplaceIndex } from "@/plugins/marketplace/marketplace-index";
import { syncGitMarketplace } from "@/plugins/marketplace/git-marketplace";
import { PluginMarketplaceService } from "@/plugins/marketplace/marketplace-service";
import { validateReleasePackage } from "@/plugins/marketplace/release-validator";

describe("plugin marketplace schema", () => {
  test("config accepts a trusted marketplace git source", () => {
    const parsed = AppConfigSchema.parse({
      messaging: { default_channel_id: "", channels: [] },
      plugins: {
        marketplace: {
          gitUrl: "git@example.com:luna/luna-plugins.git",
          branch: "main",
        },
      },
    });

    expect(parsed.plugins.marketplace.gitUrl).toBe(
      "git@example.com:luna/luna-plugins.git",
    );
    expect(parsed.plugins.marketplace.branch).toBe("main");
  });

  test("marketplace tables are exported from the Luna schema", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-marketplace-schema-"));
    const previousHome = config.paths.home;
    try {
      mkdirSync(join(home, "data"), { recursive: true });
      setLunaHome(home);
      const db = new DataConnection(lunaSchema);
      try {
        expect(lunaSchema.pluginMarketplaces).toBeDefined();
        expect(lunaSchema.pluginReleases).toBeDefined();
        expect(lunaSchema.pluginInstallations).toBeDefined();
      } finally {
        db.close();
      }
    } finally {
      setLunaHome(previousHome);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("plugin marketplace index and release validation", () => {
  test("parses a minimal marketplace index", () => {
    const index = parseMarketplaceIndex({
      schemaVersion: 1,
      name: "Luna Trusted Plugin Marketplace",
      plugins: [
        {
          id: "echo",
          displayName: "Echo",
          description: "Echo plugin",
          latestVersion: "0.1.0",
          versions: [
            {
              version: "0.1.0",
              packagePath: "plugins/echo/release/0.1.0/echo-0.1.0.tgz",
              lunaApiVersion: "^0.1.0",
              manifestSha256: "a".repeat(64),
              pluginJsSha256: "b".repeat(64),
              packageSha256: "c".repeat(64),
              releaseSha256: "d".repeat(64),
              publishedAt: "2026-06-27T00:00:00.000Z",
            },
          ],
        },
      ],
    });

    expect(index.plugins[0]?.id).toBe("echo");
    expect(index.plugins[0]?.versions[0]?.version).toBe("0.1.0");
  });

  test("rejects release paths that escape marketplace root", () => {
    expect(() =>
      parseMarketplaceIndex({
        schemaVersion: 1,
        name: "Bad",
        plugins: [
          {
            id: "bad",
            displayName: "Bad",
            description: "Bad plugin",
            latestVersion: "0.1.0",
            versions: [
              {
                version: "0.1.0",
                packagePath: "../outside.tgz",
                lunaApiVersion: "^0.1.0",
                manifestSha256: "a".repeat(64),
                pluginJsSha256: "b".repeat(64),
                packageSha256: "c".repeat(64),
                releaseSha256: "d".repeat(64),
                publishedAt: "2026-06-27T00:00:00.000Z",
              },
            ],
          },
        ],
      }),
    ).toThrow(/release package path/i);
  });

  test("canonical JSON is stable for checksum manifests", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test("validates a self-contained release package", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-release-valid-"));
    try {
      const release = writeEchoReleaseArchive(root);

      const result = validateReleasePackage({
        marketplaceRoot: root,
        releaseRelativePath: release.packagePath,
        expectedPluginId: "echo",
        expectedVersion: "0.1.0",
        expectedManifestSha256: release.manifestSha256,
        expectedPluginJsSha256: release.pluginJsSha256,
        expectedPackageSha256: release.packageSha256,
        expectedReleaseSha256: release.releaseSha256,
        currentLunaApiVersion: "0.1.0",
      });

      try {
        expect(result.status).toBe("valid");
        expect(result.manifest.id).toBe("echo");
      } finally {
        result.cleanup?.();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects release package checksum mismatch", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-release-package-mismatch-"));
    try {
      const release = writeEchoReleaseArchive(root);

      expect(() =>
        validateReleasePackage({
          marketplaceRoot: root,
          releaseRelativePath: release.packagePath,
          expectedPluginId: "echo",
          expectedVersion: "0.1.0",
          expectedManifestSha256: release.manifestSha256,
          expectedPluginJsSha256: release.pluginJsSha256,
          expectedPackageSha256: "f".repeat(64),
          expectedReleaseSha256: release.releaseSha256,
          currentLunaApiVersion: "0.1.0",
        }),
      ).toThrow(/release package checksum mismatch/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects release checksum mismatch", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-release-checksum-mismatch-"));
    try {
      const releaseRoot = join(root, "plugins", "echo", "release", "0.1.0");
      mkdirSync(releaseRoot, { recursive: true });
      const manifest = JSON.stringify({
        id: "echo",
        displayName: "Echo",
        version: "0.1.0",
        source: "marketplace",
        lunaApiVersion: "^0.1.0",
        runtime: { entrypoint: "plugin.js" },
        requestedHostPermissions: [],
        operations: [],
      }, null, 2);
      const pluginJs = "export const plugin = {};\n";
      const packageJson = JSON.stringify({
        name: "@luna-plugin/echo",
        version: "0.1.0",
        private: true,
      }, null, 2);
      const checksums = canonicalJson({
        schemaVersion: 1,
        files: [
          { path: "manifest.json", sha256: sha256Content(manifest) },
          { path: "package.json", sha256: sha256Content(packageJson) },
          { path: "plugin.js", sha256: sha256Content(pluginJs) },
        ],
      });
      writeFileSync(join(releaseRoot, "manifest.json"), manifest);
      writeFileSync(join(releaseRoot, "package.json"), packageJson);
      writeFileSync(join(releaseRoot, "plugin.js"), pluginJs);
      writeFileSync(join(releaseRoot, "checksums.json"), checksums);

      expect(() =>
        validateReleasePackage({
          marketplaceRoot: root,
          releaseRelativePath: "plugins/echo/release/0.1.0",
          expectedPluginId: "echo",
          expectedVersion: "0.1.0",
          expectedManifestSha256: sha256Content(manifest),
          expectedPluginJsSha256: sha256Content(pluginJs),
          expectedReleaseSha256: "f".repeat(64),
          currentLunaApiVersion: "0.1.0",
        }),
      ).toThrow(/release checksum mismatch/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects release symlinks escaping the release root", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-release-symlink-"));
    try {
      const releaseRoot = join(root, "plugins", "bad", "release", "0.1.0");
      mkdirSync(releaseRoot, { recursive: true });
      writeFileSync(join(root, "outside.txt"), "secret");
      symlinkSync(join(root, "outside.txt"), join(releaseRoot, "outside.txt"));

      expect(() =>
        validateReleasePackage({
          marketplaceRoot: root,
          releaseRelativePath: "plugins/bad/release/0.1.0",
          expectedPluginId: "bad",
          expectedVersion: "0.1.0",
          expectedManifestSha256: "a".repeat(64),
          expectedPluginJsSha256: "b".repeat(64),
          expectedReleaseSha256: "c".repeat(64),
          currentLunaApiVersion: "0.1.0",
        }),
      ).toThrow(/symlink/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("plugin marketplace service", () => {
  test("an existing marketplace cache refreshes from the new configured Git source", async () => {
    const first = createEchoMarketplaceRepo();
    const second = createEchoMarketplaceRepo();
    const cache = mkdtempSync(join(tmpdir(), "luna-marketplace-switch-"));
    try {
      git(second.root, ["checkout", "-b", "codex/marketplace-switch"]);
      writeFileSync(join(second.root, "source.txt"), "new marketplace source\n");
      git(second.root, ["add", "source.txt"]);
      git(second.root, ["commit", "-m", "mark new marketplace"]);
      const input = { id: "trusted", branch: "main", localPath: cache };
      await syncGitMarketplace({ ...input, gitUrl: first.root });
      const synced = await syncGitMarketplace({
        ...input, gitUrl: second.root, branch: "codex/marketplace-switch",
      });
      expect(synced.commit).toBe(git(second.root, ["rev-parse", "HEAD"]));
    } finally {
      for (const path of [first.root, second.root, cache]) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  }, 15_000);

  test("refresh indexes marketplace releases without enabling plugins", async () => {
    await withFreshDb("luna-marketplace-refresh-", async ({ db, home }) => {
      const repo = createEchoMarketplaceRepo();
      try {
        const service = new PluginMarketplaceService({
          db,
          marketplace: {
            id: "trusted",
            gitUrl: repo.root,
            branch: "main",
            localPath: join(home, "plugins", "marketplace", "trusted"),
          },
          lunaHome: home,
          currentLunaApiVersion: "0.1.0",
        });

        const result = await service.refresh();

        expect(result.status).toBe("success");
        expect(service.releases().map((release) => release.pluginId)).toEqual([
          "echo",
        ]);
        expect(service.installations()).toEqual([]);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  });

  test("enable copies release to installed cache and marks pending restart", async () => {
    await withFreshDb("luna-marketplace-enable-", async ({ db, home }) => {
      const repo = createEchoMarketplaceRepo();
      try {
        const service = new PluginMarketplaceService({
          db,
          marketplace: {
            id: "trusted",
            gitUrl: repo.root,
            branch: "main",
            localPath: join(home, "plugins", "marketplace", "trusted"),
          },
          lunaHome: home,
          currentLunaApiVersion: "0.1.0",
        });
        await service.refresh();

        const result = await service.enable({
          pluginId: "echo",
          version: "0.1.0",
        });

        expect(result.status).toBe("success");
        expect(result.restartRequired).toBe(true);
        expect(result.installation.pendingAction).toBe("enable");
        expect(result.installation.desiredInstalledPath).toContain(
          "plugins/installed/echo/0.1.0",
        );
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  });

  test("disable records desired disabled without mutating active state", async () => {
    await withFreshDb("luna-marketplace-disable-", async ({ db, home }) => {
      const repo = createEchoMarketplaceRepo();
      try {
        const service = new PluginMarketplaceService({
          db,
          marketplace: {
            id: "trusted",
            gitUrl: repo.root,
            branch: "main",
            localPath: join(home, "plugins", "marketplace", "trusted"),
          },
          lunaHome: home,
          currentLunaApiVersion: "0.1.0",
        });
        await service.refresh();
        const enabled = await service.enable({
          pluginId: "echo",
          version: "0.1.0",
        });
        db.update(pluginInstallations)
          .set({
            active_state: "enabled",
            active_version: "0.1.0",
            active_release_sha256: enabled.installation.desiredReleaseSha256,
            active_installed_path: enabled.installation.desiredInstalledPath,
            pending_action: "none",
          })
          .where(eq(pluginInstallations.plugin_id, "echo"))
          .run();

        const disabled = await service.disable("echo");

        expect(disabled.installation.desiredState).toBe("disabled");
        expect(disabled.installation.activeState).toBe("enabled");
        expect(disabled.installation.pendingAction).toBe("disable");
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  });

  test("refresh failure preserves previous release rows", async () => {
    await withFreshDb("luna-marketplace-refresh-failure-", async ({ db, home }) => {
      const repo = createEchoMarketplaceRepo();
      try {
        const service = new PluginMarketplaceService({
          db,
          marketplace: {
            id: "trusted",
            gitUrl: repo.root,
            branch: "main",
            localPath: join(home, "plugins", "marketplace", "trusted"),
          },
          lunaHome: home,
          currentLunaApiVersion: "0.1.0",
        });
        await service.refresh();
        writeFileSync(join(repo.root, "marketplace.json"), "{ bad json");
        git(repo.root, ["add", "marketplace.json"]);
        git(repo.root, ["commit", "-m", "break marketplace"]);

        const failed = await service.refresh();

        expect(failed.status).toBe("error");
        expect(service.releases().map((release) => release.pluginId)).toEqual([
          "echo",
        ]);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }, 15_000);

  test("same-version release checksum drift is marked invalid and cannot be enabled", async () => {
    await withFreshDb("luna-marketplace-integrity-drift-", async ({ db, home }) => {
      const repo = createEchoMarketplaceRepo();
      try {
        const service = new PluginMarketplaceService({
          db,
          marketplace: {
            id: "trusted",
            gitUrl: repo.root,
            branch: "main",
            localPath: join(home, "plugins", "marketplace", "trusted"),
          },
          lunaHome: home,
          currentLunaApiVersion: "0.1.0",
        });
        await service.refresh();
        rewriteEchoReleaseWithDrift(repo.root);
        git(repo.root, ["add", "."]);
        git(repo.root, ["commit", "-m", "drift same version"]);

        await service.refresh();

        const release = service.releases()[0];
        expect(release?.validationStatus).toBe("invalid");
        expect(release?.validationError).toContain("integrity drift");
        await expect(service.enable({ pluginId: "echo", version: "0.1.0" }))
          .rejects.toThrow(/invalid/i);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }, 15_000);
});

describe("installed plugin loader", () => {
  test("service boot loader loads desired enabled installed plugin releases", async () => {
    await withFreshDb("luna-installed-loader-", async ({ db, home }) => {
      const repo = createEchoMarketplaceRepo();
      try {
        const service = new PluginMarketplaceService({
          db,
          marketplace: {
            id: "trusted",
            gitUrl: repo.root,
            branch: "main",
            localPath: join(home, "plugins", "marketplace", "trusted"),
          },
          lunaHome: home,
          currentLunaApiVersion: "0.1.0",
        });
        await service.refresh();
        await service.enable({ pluginId: "echo", version: "0.1.0" });

        const registry = await loadInstalledPlugins({
          db,
          configByPluginId: { echo: { greeting: "hello" } },
        });

        expect(registry.resolveCommand(["echo"])?.operationId).toBe("echo.echo");
        expect(registry.getOperation("echo.echo")?.id).toBe("echo.echo");
        expect(registry.getPlugin("echo")?.config).toEqual({ greeting: "hello" });
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  });

  test("installed loader records activation failure without failing all plugins", async () => {
    await withFreshDb("luna-installed-loader-failure-", async ({ db, home }) => {
      const repo = createEchoMarketplaceRepo();
      try {
        const service = new PluginMarketplaceService({
          db,
          marketplace: {
            id: "trusted",
            gitUrl: repo.root,
            branch: "main",
            localPath: join(home, "plugins", "marketplace", "trusted"),
          },
          lunaHome: home,
          currentLunaApiVersion: "0.1.0",
        });
        await service.refresh();
        const enabled = await service.enable({
          pluginId: "echo",
          version: "0.1.0",
        });
        rmSync(join(enabled.installation.desiredInstalledPath!, "plugin.js"), {
          force: true,
        });

        const registry = await loadInstalledPlugins({ db });

        expect(registry.getPlugin("echo")).toBeUndefined();
        const row = db
          .select()
          .from(pluginInstallations)
          .where(eq(pluginInstallations.plugin_id, "echo"))
          .get();
        expect(row?.pending_action).toBe("activation_failed");
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  });
});

async function withFreshDb(
  prefix: string,
  fn: (input: {
    readonly home: string;
    readonly db: DataConnection<typeof lunaSchema>["db"];
  }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const previousHome = config.paths.home;
  mkdirSync(join(home, "data"), { recursive: true });
  setLunaHome(home);
  const connection = new DataConnection(lunaSchema);
  try {
    await fn({ home, db: connection.db });
  } finally {
    connection.close();
    setLunaHome(previousHome);
    rmSync(home, { recursive: true, force: true });
  }
}

interface EchoReleaseFixture {
  readonly packagePath: string;
  readonly manifestSha256: string;
  readonly pluginJsSha256: string;
  readonly packageSha256: string;
  readonly releaseSha256: string;
}

function createEchoMarketplaceRepo(): { readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "luna-marketplace-repo-"));
  const release = writeEchoReleaseArchive(root);
  writeEchoMarketplaceIndex(root, release);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "luna@example.com"]);
  git(root, ["config", "user.name", "Luna Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return { root };
}

function writeEchoReleaseArchive(
  root: string,
  input: { readonly drifted?: boolean } = {},
): EchoReleaseFixture {
  const packagePath = "plugins/echo/release/0.1.0/echo-0.1.0.tgz";
  const archivePath = join(root, packagePath);
  mkdirSync(dirname(archivePath), { recursive: true });
  const stagingRoot = mkdtempSync(join(tmpdir(), "luna-echo-release-"));
  const releaseRoot = join(stagingRoot, "package");
  mkdirSync(join(releaseRoot, "skills", "echo"), { recursive: true });
  const manifest = JSON.stringify(
    {
      id: "echo",
      displayName: "Echo",
      version: "0.1.0",
      source: "marketplace",
      lunaApiVersion: "^0.1.0",
      runtime: { entrypoint: "plugin.js" },
      requestedHostPermissions: [],
      operations: [
        {
          id: "echo.echo",
          pluginId: "echo",
          providerType: "plugin",
          title: "Echo",
          inputSchema: { type: "object" },
          riskLevel: "low",
          artifactPolicy: "none",
        },
      ],
      commands: [{ path: ["echo"], operationId: "echo.echo" }],
      skills: [
        {
          id: "echo.echo",
          title: "Echo",
          path: "skills/echo/SKILL.md",
        },
      ],
    },
    null,
    2,
  );
  const pluginJs = [
    "export const plugin = {",
    "  createRuntime: () => ({",
    input.drifted
      ? "    invoke: async () => ({ status: 'success', summary: { drifted: true }, artifacts: [] }),"
      : "    invoke: async () => ({ status: 'success', summary: { echoed: true }, artifacts: [] }),",
    "  }),",
    "};",
    "export default plugin;",
    "",
  ].join("\n");
  const packageJson = JSON.stringify({
    name: "@luna-plugin/echo",
    version: "0.1.0",
    private: true,
  }, null, 2);
  const skill = "# Echo\n";
  writeFileSync(join(releaseRoot, "manifest.json"), manifest);
  writeFileSync(join(releaseRoot, "package.json"), packageJson);
  writeFileSync(join(releaseRoot, "plugin.js"), pluginJs);
  writeFileSync(join(releaseRoot, "skills", "echo", "SKILL.md"), skill);
  const checksums = canonicalJson({
    schemaVersion: 1,
    files: [
      { path: "manifest.json", sha256: sha256Content(manifest) },
      { path: "package.json", sha256: sha256Content(packageJson) },
      { path: "plugin.js", sha256: sha256Content(pluginJs) },
      { path: "skills/echo/SKILL.md", sha256: sha256Content(skill) },
    ],
  });
  writeFileSync(join(releaseRoot, "checksums.json"), checksums);
  tar(stagingRoot, ["-czf", archivePath, "package"]);
  rmSync(stagingRoot, { recursive: true, force: true });
  return {
    packagePath,
    manifestSha256: sha256Content(manifest),
    pluginJsSha256: sha256Content(pluginJs),
    packageSha256: sha256File(archivePath),
    releaseSha256: sha256Content(checksums),
  };
}

function rewriteEchoReleaseWithDrift(root: string): void {
  const release = writeEchoReleaseArchive(root, { drifted: true });
  writeEchoMarketplaceIndex(root, release);
}

function writeEchoMarketplaceIndex(
  root: string,
  release: EchoReleaseFixture,
): void {
  writeFileSync(
    join(root, "marketplace.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: "Luna Test Marketplace",
        plugins: [
          {
            id: "echo",
            displayName: "Echo",
            description: "Echo plugin",
            latestVersion: "0.1.0",
            versions: [
              {
                version: "0.1.0",
                packagePath: release.packagePath,
                lunaApiVersion: "^0.1.0",
                manifestSha256: release.manifestSha256,
                pluginJsSha256: release.pluginJsSha256,
                packageSha256: release.packageSha256,
                releaseSha256: release.releaseSha256,
                publishedAt: "2026-06-27T00:00:00.000Z",
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}

function tar(cwd: string, args: readonly string[]): void {
  const result = spawnSync("tar", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `tar ${args.join(" ")} failed`);
  }
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}
