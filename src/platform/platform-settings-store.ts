import { eq } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleDB } from "@/data";
import { platformAuthSettings, platformSettings } from "@/data/schema";

const PLATFORM_SETTINGS_ID = "default";

export const DEFAULT_ARTIFACT_SIGNED_URL_TTL_MS = 2 * 60 * 60 * 1000;

export function defaultSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizePublicOriginUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    return null;
  }
  return parsed.origin;
}

const PublicBaseUrlField = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizePublicOriginUrl(value);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "对外访问地址必须是合法的 http(s) 根地址（不含路径、查询参数或锚点）。",
      });
      return z.NEVER;
    }
    return normalized;
  });

const TimezoneField = z
  .string()
  .trim()
  .min(1, "时区不能为空。")
  .refine(isValidIanaTimezone, "必须是合法的 IANA 时区名称（如 Asia/Shanghai）。");

export const PlatformGeneralSettings = z
  .object({
    publicBaseUrl: PublicBaseUrlField.default(""),
    timezone: TimezoneField.default(defaultSystemTimezone),
    artifactSignedUrlTtlMs: z
      .number()
      .int()
      .min(60_000)
      .max(365 * 24 * 3_600_000)
      .default(DEFAULT_ARTIFACT_SIGNED_URL_TTL_MS),
  })
  .strict();
export type PlatformGeneralSettings = z.infer<typeof PlatformGeneralSettings>;

export const PlatformExecutionSettings = z
  .object({
    containerTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 3_600_000)
      .default(30 * 60 * 1000),
    taskTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 3_600_000)
      .default(600 * 60 * 1000),
    maxTransientRetries: z.number().int().min(0).max(10).default(5),
  })
  .strict();
export type PlatformExecutionSettings = z.infer<typeof PlatformExecutionSettings>;

export const PlatformMemorySettings = z
  .object({
    reflectionIdleMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 86_400_000)
      .default(30 * 60 * 1000),
    consolidationIntervalMs: z
      .number()
      .int()
      .min(0)
      .max(365 * 86_400_000)
      .default(24 * 60 * 60 * 1000),
    forgetUnusedMs: z
      .number()
      .int()
      .min(0)
      .max(3650 * 86_400_000)
      .default(180 * 24 * 60 * 60 * 1000),
    episodeRetentionMs: z
      .number()
      .int()
      .min(0)
      .max(3650 * 86_400_000)
      .default(90 * 24 * 60 * 60 * 1000),
    recallLimit: z.number().int().min(0).max(100).default(8),
    coreLimit: z.number().int().min(1).max(500).default(30),
    shadowCoreLimit: z.number().int().min(0).max(500).default(10),
    personaLimit: z.number().int().min(1).max(50).default(5),
  })
  .strict();
export type PlatformMemorySettings = z.infer<typeof PlatformMemorySettings>;

export const PlatformMarketplaceSettings = z
  .object({
    gitUrl: z.string().trim().max(2048).default(""),
    branch: z.string().trim().min(1).max(256).default("main"),
  })
  .strict();
export type PlatformMarketplaceSettings = z.infer<typeof PlatformMarketplaceSettings>;

export const PlatformMessagingSettings = z
  .object({
    maxVisibleSteps: z.number().int().min(1).max(200).default(32),
    feishuDevelopers: z
      .record(
        z.string().trim().min(1).max(128),
        z.string().trim().min(1).max(128),
      )
      .default({}),
  })
  .strict();
export type PlatformMessagingSettings = z.infer<typeof PlatformMessagingSettings>;

export const PlatformRuntimeSettings = z
  .object({
    general: PlatformGeneralSettings.default(() => PlatformGeneralSettings.parse({})),
    execution: PlatformExecutionSettings.default(() => PlatformExecutionSettings.parse({})),
    memory: PlatformMemorySettings.default(() => PlatformMemorySettings.parse({})),
    marketplace: PlatformMarketplaceSettings.default(() => PlatformMarketplaceSettings.parse({})),
    messaging: PlatformMessagingSettings.default(() => PlatformMessagingSettings.parse({})),
  })
  .strict();
export type PlatformRuntimeSettings = z.infer<typeof PlatformRuntimeSettings>;

export const PlatformRuntimeSettingsPatch = z
  .object({
    general: PlatformGeneralSettings.partial().strict().optional(),
    execution: PlatformExecutionSettings.partial().strict().optional(),
    memory: PlatformMemorySettings.partial().strict().optional(),
    marketplace: PlatformMarketplaceSettings.partial().strict().optional(),
    messaging: PlatformMessagingSettings.partial().strict().optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.general !== undefined ||
      patch.execution !== undefined ||
      patch.memory !== undefined ||
      patch.marketplace !== undefined ||
      patch.messaging !== undefined,
    "至少需要提供一个设置分组。",
  );
export type PlatformRuntimeSettingsPatch = z.infer<typeof PlatformRuntimeSettingsPatch>;

export function defaultPlatformRuntimeSettings(): PlatformRuntimeSettings {
  return PlatformRuntimeSettings.parse({});
}

function normalizeStoredPlatformSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const exec = record.execution;
  if (!exec || typeof exec !== "object" || Array.isArray(exec)) return raw;
  const execRecord = exec as Record<string, unknown>;
  if (!("taskRunLimitHours" in execRecord)) return raw;
  const { taskRunLimitHours, ...restExec } = execRecord;
  return {
    ...record,
    execution: {
      ...(typeof taskRunLimitHours === "number" ? { taskTimeoutMs: taskRunLimitHours * 3_600_000 } : {}),
      ...restExec,
    },
  };
}

/** Platform-wide runtime settings stored in SQLite; readable by runtime & signed-in accounts, editable by platform admins. */
export class PlatformSettingsStore {
  constructor(private readonly db: DrizzleDB) {}

  get(): PlatformRuntimeSettings {
    const row = this.db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
      .get();
    if (!row) {
      return defaultPlatformRuntimeSettings();
    }
    const raw = normalizeStoredPlatformSettings(row.settings);
    const parsed = PlatformRuntimeSettings.safeParse(raw);
    return parsed.success ? parsed.data : defaultPlatformRuntimeSettings();
  }

  patch(
    rawPatch: unknown,
    accountId?: string | null,
    now: number = Date.now(),
  ): PlatformRuntimeSettings {
    const patch = PlatformRuntimeSettingsPatch.parse(rawPatch);
    return this.db.transaction(() => {
      const current = this.get();
      const merged = PlatformRuntimeSettings.parse({
        general: { ...current.general, ...patch.general },
        execution: { ...current.execution, ...patch.execution },
        memory: { ...current.memory, ...patch.memory },
        marketplace: { ...current.marketplace, ...patch.marketplace },
        messaging: { ...current.messaging, ...patch.messaging },
      });
      const values = {
        id: PLATFORM_SETTINGS_ID,
        settings: merged,
        updatedByAccountId: accountId ?? null,
        updatedAt: now,
      };
      this.db
        .insert(platformSettings)
        .values(values)
        .onConflictDoUpdate({
          target: platformSettings.id,
          set: values,
        })
        .run();
      return merged;
    });
  }
}

export function resolvePublicBaseUrl(
  db?: DrizzleDB,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (db !== undefined) {
    const fromPlatform = new PlatformSettingsStore(db).get().general.publicBaseUrl;
    if (fromPlatform) {
      return fromPlatform;
    }
    const authRow = db
      .select({ publicBaseUrl: platformAuthSettings.publicBaseUrl })
      .from(platformAuthSettings)
      .where(eq(platformAuthSettings.provider, "feishu"))
      .get();
    if (authRow?.publicBaseUrl) {
      const normalized = normalizePublicOriginUrl(authRow.publicBaseUrl);
      if (normalized) {
        return normalized;
      }
    }
  }
  for (const key of [
    "LUNA_FEISHU_PUBLIC_BASE_URL",
    "LUNA_SERVICE_URL",
    "PUBLIC_BASE_URL",
  ] as const) {
    const raw = env[key]?.trim();
    if (raw) {
      const normalized = normalizePublicOriginUrl(raw);
      if (normalized) {
        return normalized;
      }
    }
  }
  return "";
}

export function resolveArtifactSignedUrlTtlMs(db?: DrizzleDB): number {
  if (db === undefined) {
    return DEFAULT_ARTIFACT_SIGNED_URL_TTL_MS;
  }
  try {
    return new PlatformSettingsStore(db).get().general.artifactSignedUrlTtlMs;
  } catch {
    return DEFAULT_ARTIFACT_SIGNED_URL_TTL_MS;
  }
}
