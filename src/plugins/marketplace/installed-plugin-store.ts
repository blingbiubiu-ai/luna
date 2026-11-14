import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { eq, sql } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { pluginInstallations } from "@/data/schema";
import { config } from "@/shared";

import type { PluginReleaseSummary } from "./marketplace-store";

export type PluginDesiredState = "enabled" | "disabled";
export type PluginPendingAction =
  | "none"
  | "enable"
  | "disable"
  | "upgrade"
  | "rollback"
  | "activation_failed";

export interface InstalledRelease {
  readonly pluginId: string;
  readonly version: string;
  readonly releaseSha256: string;
  readonly installedPath: string;
}

export interface PluginInstallationSummary {
  readonly pluginId: string;
  readonly desiredState: PluginDesiredState;
  readonly desiredVersion?: string;
  readonly desiredReleaseSha256?: string;
  readonly desiredInstalledPath?: string;
  readonly activeState: PluginDesiredState;
  readonly activeVersion?: string;
  readonly activeReleaseSha256?: string;
  readonly activeInstalledPath?: string;
  readonly pendingAction: PluginPendingAction;
  readonly lastActivatedAt?: number;
  readonly lastError?: string;
}

export class InstalledPluginStore {
  private readonly _lunaHome: string;

  constructor(
    private readonly _db: DrizzleDB,
    input: { readonly lunaHome?: string } = {},
  ) {
    this._lunaHome = input.lunaHome ?? config.paths.home;
  }

  installRelease(input: {
    readonly release: PluginReleaseSummary;
    readonly releaseRoot: string;
  }): InstalledRelease {
    const installedPath = join(
      this._lunaHome,
      "plugins",
      "installed",
      input.release.pluginId,
      input.release.version,
      input.release.releaseSha256,
    );
    rmSync(installedPath, { recursive: true, force: true });
    mkdirSync(dirname(installedPath), { recursive: true });
    cpSync(input.releaseRoot, installedPath, { recursive: true });
    return {
      pluginId: input.release.pluginId,
      version: input.release.version,
      releaseSha256: input.release.releaseSha256,
      installedPath,
    };
  }

  markEnable(input: {
    readonly installed: InstalledRelease;
    readonly action?: Exclude<PluginPendingAction, "none" | "disable" | "activation_failed">;
  }): PluginInstallationSummary {
    const action = input.action ?? "enable";
    this._db
      .insert(pluginInstallations)
      .values({
        plugin_id: input.installed.pluginId,
        desired_state: "enabled",
        desired_version: input.installed.version,
        desired_release_sha256: input.installed.releaseSha256,
        desired_installed_path: input.installed.installedPath,
        active_state: "disabled",
        active_version: null,
        active_release_sha256: null,
        active_installed_path: null,
        pending_action: action,
        last_activated_at: null,
        last_error: null,
      })
      .onConflictDoUpdate({
        target: pluginInstallations.plugin_id,
        set: {
          desired_state: "enabled",
          desired_version: input.installed.version,
          desired_release_sha256: input.installed.releaseSha256,
          desired_installed_path: input.installed.installedPath,
          pending_action: action,
          last_error: null,
        },
      })
      .run();
    return this.requireInstallation(input.installed.pluginId);
  }

  markDisable(pluginId: string): PluginInstallationSummary {
    this._db
      .insert(pluginInstallations)
      .values({
        plugin_id: pluginId,
        desired_state: "disabled",
        desired_version: null,
        desired_release_sha256: null,
        desired_installed_path: null,
        active_state: "disabled",
        active_version: null,
        active_release_sha256: null,
        active_installed_path: null,
        pending_action: "disable",
        last_activated_at: null,
        last_error: null,
      })
      .onConflictDoUpdate({
        target: pluginInstallations.plugin_id,
        set: {
          desired_state: "disabled",
          desired_version: null,
          desired_release_sha256: null,
          desired_installed_path: null,
          pending_action: "disable",
        },
      })
      .run();
    return this.requireInstallation(pluginId);
  }

  markActivation(input: {
    readonly pluginId: string;
    readonly status: "success" | "failure";
    readonly error?: string;
  }): void {
    if (input.status === "success") {
      this._db
        .update(pluginInstallations)
        .set({
          active_state: "enabled",
          active_version: sql`desired_version`,
          active_release_sha256: sql`desired_release_sha256`,
          active_installed_path: sql`desired_installed_path`,
          pending_action: "none",
          last_activated_at: Date.now(),
          last_error: null,
        })
        .where(eq(pluginInstallations.plugin_id, input.pluginId))
        .run();
      return;
    }
    this._db
      .update(pluginInstallations)
      .set({
        pending_action: "activation_failed",
        last_error: input.error ?? "Plugin activation failed.",
      })
      .where(eq(pluginInstallations.plugin_id, input.pluginId))
      .run();
  }

  listDesiredEnabled(): PluginInstallationSummary[] {
    return this._db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.desired_state, "enabled"))
      .all()
      .map(installationFromRow);
  }

  listInstallations(): PluginInstallationSummary[] {
    return this._db
      .select()
      .from(pluginInstallations)
      .all()
      .map(installationFromRow);
  }

  getInstallation(pluginId: string): PluginInstallationSummary | undefined {
    const row = this._db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.plugin_id, pluginId))
      .get();
    return row === undefined ? undefined : installationFromRow(row);
  }

  requireInstallation(pluginId: string): PluginInstallationSummary {
    const installation = this.getInstallation(pluginId);
    if (installation === undefined) {
      throw new Error(`Plugin installation not found: ${pluginId}`);
    }
    return installation;
  }
}

function installationFromRow(
  row: typeof pluginInstallations.$inferSelect,
): PluginInstallationSummary {
  return {
    pluginId: row.plugin_id,
    desiredState: row.desired_state === "enabled" ? "enabled" : "disabled",
    ...(row.desired_version === null
      ? {}
      : { desiredVersion: row.desired_version }),
    ...(row.desired_release_sha256 === null
      ? {}
      : { desiredReleaseSha256: row.desired_release_sha256 }),
    ...(row.desired_installed_path === null
      ? {}
      : { desiredInstalledPath: row.desired_installed_path }),
    activeState: row.active_state === "enabled" ? "enabled" : "disabled",
    ...(row.active_version === null ? {} : { activeVersion: row.active_version }),
    ...(row.active_release_sha256 === null
      ? {}
      : { activeReleaseSha256: row.active_release_sha256 }),
    ...(row.active_installed_path === null
      ? {}
      : { activeInstalledPath: row.active_installed_path }),
    pendingAction: parsePendingAction(row.pending_action),
    ...(row.last_activated_at === null
      ? {}
      : { lastActivatedAt: row.last_activated_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function parsePendingAction(value: string): PluginPendingAction {
  if (
    value === "enable" ||
    value === "disable" ||
    value === "upgrade" ||
    value === "rollback" ||
    value === "activation_failed"
  ) {
    return value;
  }
  return "none";
}
