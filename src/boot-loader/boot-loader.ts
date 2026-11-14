import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import dayjs from "dayjs";

import {
  config,
  createLogger,
  reloadConfig,
} from "@/shared";

const logger = createLogger("boot-loader");

export function resolveBootLoaderRepoRoot(moduleDir = import.meta.dir): string {
  let current = moduleDir;
  while (true) {
    if (
      existsSync(join(current, "package.json")) &&
      existsSync(join(current, "src"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirname(dirname(moduleDir));
    }
    current = parent;
  }
}

const repoRoot = resolveBootLoaderRepoRoot();
const localUserHome = join(repoRoot, "user-home");

/**
 * The BootLoader is the main entry point for the Luna agent runtime.
 */
class BootLoader {
  /**
   * Bootstraps the application by verifying the integrity and then igniting the kernel.
   */
  public async bootstrap(): Promise<void> {
    await this._verifyIntegrity();
    await this._igniteKernel();
  }

  private async _verifyIntegrity(): Promise<void> {
    if (!existsSync(config.paths.home)) {
      mkdirSync(config.paths.home, { recursive: true });
    }
    if (!existsSync(config.paths.workspace)) {
      mkdirSync(config.paths.workspace, { recursive: true });
    }
    if (!existsSync(config.paths.data)) {
      mkdirSync(config.paths.data, { recursive: true });
    }
    if (!existsSync(config.paths.uploads)) {
      mkdirSync(config.paths.uploads, { recursive: true });
    }
    if (!existsSync(config.paths.outputs)) {
      mkdirSync(config.paths.outputs, { recursive: true });
    }
    if (!existsSync(config.paths.artifacts)) {
      mkdirSync(config.paths.artifacts, { recursive: true });
    }

    if (!existsSync(config.paths.memory)) {
      mkdirSync(config.paths.memory, { recursive: true });
    }
    if (!existsSync(config.paths.claude_home)) {
      mkdirSync(config.paths.claude_home, { recursive: true });
    }
    if (!existsSync(config.paths.skills)) {
      mkdirSync(config.paths.skills, { recursive: true });
    }
    this._ensureHomeLinks();

    // Symlink .agents/skills → .claude/skills so the Codex CLI can also
    // read skills.  Only created once; subsequent boots see the existing link.
    this._ensureSkillsSymlink();

    const configPath = join(config.paths.home, "config.yaml");
    if (!existsSync(configPath)) {
      logger.info("config.yaml not found, generating default configuration...");
      const defaultTimezone =
        Intl.DateTimeFormat().resolvedOptions().timeZone;
      const defaultConfig = `timezone: "${defaultTimezone}"

service:
  host: 127.0.0.1
  port: 8090

paths: {}

logging:
  level: info
  pretty: false

plugins:
  marketplace: {}
  config: {}

messaging:
  default_channel_id: ""
  max_visible_steps: 32
  channels: []
`;
      writeFileSync(configPath, defaultConfig, "utf-8");
    }

    reloadConfig();

    if (!existsSync(config.paths.data)) {
      mkdirSync(config.paths.data, { recursive: true });
    }
  }

  /**
   * Ensures all top-level files under local repo `user-home` are linked into
   * LUNA_HOME, except `.gitignore` and `CLAUDE.md`.
   */
  private _ensureHomeLinks(): void {
    if (!existsSync(localUserHome)) {
      logger.warn(
        { localUserHome },
        "Local user home template not found, skipping home links",
      );
      return;
    }

    const entries = readdirSync(localUserHome, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      if (name === ".gitignore" || name === "CLAUDE.md") {
        continue;
      }

      const sourcePath = join(localUserHome, name);
      const linkPath = join(config.paths.home, name);
      const type = entry.isDirectory() ? "dir" : "file";
      this._ensureSymlink(sourcePath, linkPath, type);
    }

    const sourceGitignorePath = join(localUserHome, ".gitignore");
    const targetGitignorePath = join(config.paths.home, ".gitignore");
    if (existsSync(sourceGitignorePath) && !existsSync(targetGitignorePath)) {
      copyFileSync(sourceGitignorePath, targetGitignorePath);
      logger.info(
        { targetGitignorePath, sourceGitignorePath },
        "Copied .gitignore into LUNA_HOME",
      );
    }

    const sourceClaudeMdPath = join(localUserHome, "CLAUDE.md");
    const targetClaudeMdPath = join(config.paths.home, "CLAUDE.md");
    if (existsSync(sourceClaudeMdPath) && !existsSync(targetClaudeMdPath)) {
      copyFileSync(sourceClaudeMdPath, targetClaudeMdPath);
      logger.info(
        { targetClaudeMdPath, sourceClaudeMdPath },
        "Copied CLAUDE.md into LUNA_HOME",
      );
    }
  }

  /**
   * Creates a symlink at `.agents/skills` → `.claude/skills` so the Codex
   * CLI can discover skills via its native directory.
   */
  private _ensureSkillsSymlink(): void {
    try {
      mkdirSync(config.paths.agents_home, { recursive: true });
      this._ensureSymlink(
        config.paths.skills,
        join(config.paths.agents_home, "skills"),
        "dir",
      );
    } catch (err) {
      logger.warn({ err }, "Failed to create .agents/skills symlink");
    }
  }

  private _ensureSymlink(
    sourcePath: string,
    linkPath: string,
    type: "file" | "dir",
  ): void {
    if (!existsSync(sourcePath)) {
      throw new Error(`Link source not found: ${sourcePath}`);
    }

    const resolvedSourcePath = realpathSync(sourcePath);

    try {
      const stat = lstatSync(linkPath);
      if (
        stat.isSymbolicLink() &&
        realpathSync(linkPath) === resolvedSourcePath
      ) {
        return;
      }
      const backupPath = `${linkPath}.bak-${dayjs().format("YYYYMMDD-HHmmss")}`;
      renameSync(linkPath, backupPath);
      logger.info(
        { linkPath, backupPath },
        "Moved existing path to backup before creating symlink",
      );
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw e;
      }
    }

    symlinkSync(sourcePath, linkPath, type);
    logger.info({ linkPath, sourcePath }, "Created symlink");
  }

  private async _igniteKernel(): Promise<void> {
    const { kernel } = await import("@/kernel");
    logger.info("Starting Luna agent runtime");
    kernel.prepareForRuntimeStart();
    await kernel.start();
    logger.info("Luna agent runtime started");
  }
}

/**
 * Shared boot loader entrypoint used by Luna runtime bootstrapping.
 */
export const bootLoader = new BootLoader();
