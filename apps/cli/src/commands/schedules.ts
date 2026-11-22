import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  assertNoLegacyRequestId,
  callUnifiedService,
  deriveCommandIdempotencyKey,
  servicePathWithQuery,
  submitAndWaitCommand,
} from "@luna/cli-support/service-client";
import {
  recurrenceSchema,
  scheduleTimingShape,
} from "@luna/service-client/schedule-input";
import { z } from "zod";

const SCHEDULES_USAGE = [
  "Usage:",
  "  luna schedules create --timezone <IANA zone> --text <text> [--title <title>] [--to <address>] (--at <ISO timestamp with offset> | --interval-ms <ms> | --frequency daily|weekdays|weekly|hourly|monthly|yearly [--time HH:mm] [--days 1,3,5] [--month-days 1,15] [--month 2] [--every 2] [--start-date YYYY-MM-DD]) [--invoke | --task-id <id>] [--repeat]",
  "  luna schedules list [--status active|paused|finished]",
  "  luna schedules get <schedule-id>",
  "  luna schedules update <schedule-id> [--title <title>] [--to <address>] [--timezone <IANA zone>] [--at <ISO> | --interval-ms <ms> | --frequency ...] [--text <text> [--invoke | --task-id <id>]] [--expected-revision <n>] [--json '<object>' | --stdin]",
  "  luna schedules pause <schedule-id> [--expected-revision <n>]",
  "  luna schedules resume <schedule-id> [--expected-revision <n>]",
  "  luna schedules cancel <schedule-id>",
].join("\n");

const CREATE_VALUE_OPTIONS = new Set([
  "--text",
  "--title",
  "--to",
  "--at",
  "--timezone",
  "--interval-ms",
  "--frequency",
  "--time",
  "--days",
  "--month-days",
  "--month",
  "--every",
  "--start-date",
  "--task-id",
]);

function parseTimingOptions(
  argv: readonly string[],
  timezoneFallback?: string,
) {
  const opt = (name: string) => readOption(argv, name);
  const timezone = opt("--timezone") ?? timezoneFallback;
  const at = opt("--at");
  const interval = opt("--interval-ms");
  const frequency = opt("--frequency");
  if (timezone) {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  }
  if (frequency && (at || interval)) {
    throw new Error("--frequency cannot be combined with --at or --interval-ms");
  }
  const calendarOptions = [
    "--time",
    "--days",
    "--month-days",
    "--month",
    "--every",
    "--start-date",
  ];
  if (!frequency && calendarOptions.some(name => opt(name) !== undefined)) {
    throw new Error("Calendar options require --frequency");
  }
  const list = (name: string) => {
    const value = opt(name);
    if (value === undefined) return [];
    if (!/^\d+(,\d+)*$/.test(value)) throw new Error("Invalid date list: " + name);
    return [...new Set(value.split(",").map(Number))].sort((a, b) => a - b);
  };
  let recurrence;
  if (frequency) {
    if (
      !["hourly", "daily", "weekdays", "weekly", "monthly", "yearly"].includes(
        frequency,
      )
    ) {
      throw new Error("Invalid frequency");
    }
    if (opt("--days") && frequency !== "weekly") {
      throw new Error("--days requires weekly");
    }
    if (opt("--month-days") && !["monthly", "yearly"].includes(frequency)) {
      throw new Error("--month-days requires monthly or yearly");
    }
    if (opt("--month") && frequency !== "yearly") {
      throw new Error("--month requires yearly");
    }
    if (frequency === "weekdays" && (opt("--every") || opt("--start-date"))) {
      throw new Error("Weekdays does not accept --every or --start-date");
    }
    const custom =
      ["hourly", "monthly", "yearly"].includes(frequency) ||
      !!opt("--every") ||
      !!opt("--start-date");
    const effectiveTz = timezone ?? "UTC";
    const startDate =
      opt("--start-date") ??
      new Intl.DateTimeFormat("en-CA", {
        timeZone: effectiveTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    recurrence = recurrenceSchema.parse({
      kind: custom ? "custom" : frequency,
      time: opt("--time"),
      days: list("--days"),
      ...(custom
        ? {
            frequency,
            every: Number(opt("--every") ?? 1),
            startDate,
          }
        : {}),
      ...(opt("--month-days") ? { monthDays: list("--month-days") } : {}),
      ...(opt("--month") ? { month: Number(opt("--month")) } : {}),
    });
  }
  if (at && !/(Z|[+-]\d{2}:\d{2})$/.test(at)) {
    throw new Error("--at requires an explicit timezone offset");
  }
  return { at, interval, frequency, recurrence, timezone };
}

export async function runSchedulesCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const sub = argv[0];
  if (!sub || sub === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { status: "ok", output: SCHEDULES_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);
    if (argv.includes("--session-id")) {
      return {
        status: "error",
        code: "legacy_target_removed",
        message:
          "--session-id is removed in Protocol v2; pass a unified address via --to (current, self, user:<id>, session:<id>, group:<id>)",
      };
    }

    if (sub === "list") {
      return await callUnifiedService(env, {
        method: "GET",
        path: servicePathWithQuery("/api/runner/schedules", {
          status: readOption(argv, "--status"),
        }),
      });
    }

    if (sub === "get") {
      const id = argv[1];
      if (!id || id.startsWith("--")) throw new Error(SCHEDULES_USAGE);
      return await callUnifiedService(env, {
        method: "GET",
        path: `/api/runner/schedules/${encodeURIComponent(id)}`,
      });
    }

    if (sub === "pause" || sub === "resume") {
      const id = argv[1];
      if (!id || id.startsWith("--")) throw new Error(SCHEDULES_USAGE);
      const revRaw = readOption(argv, "--expected-revision");
      return await callUnifiedService(env, {
        method: "POST",
        path: `/api/runner/schedules/${encodeURIComponent(id)}/state`,
        body: {
          enabled: sub === "resume",
          ...(revRaw !== undefined ? { expectedRevision: Number(revRaw) } : {}),
        },
      });
    }

    if (sub === "cancel") {
      const id = argv[1];
      if (!id || id.startsWith("--")) throw new Error(SCHEDULES_USAGE);
      return await callUnifiedService(env, {
        method: "DELETE",
        path: `/api/runner/schedules/${encodeURIComponent(id)}`,
      });
    }

    if (sub === "update") {
      const id = argv[1];
      if (!id || id.startsWith("--")) throw new Error(SCHEDULES_USAGE);
      const inline = readOption(argv, "--json");
      const stdin = hasFlag(argv, "--stdin");
      if (inline !== undefined && stdin) {
        throw new Error("Choose --json '<object>' or --stdin, not both");
      }
      let body: Record<string, unknown> = {};
      if (inline !== undefined || stdin) {
        const parsed: unknown = JSON.parse(
          stdin ? await Bun.stdin.text() : inline!,
        );
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Expected a JSON object");
        }
        body = { ...(parsed as Record<string, unknown>) };
      }
      const title = readOption(argv, "--title");
      const to = readOption(argv, "--to")?.trim();
      const text = readOption(argv, "--text");
      const taskId = readOption(argv, "--task-id")?.trim();
      const invoke = hasFlag(argv, "--invoke");
      if (invoke && taskId) {
        throw new Error("Choose --invoke or --task-id, not both");
      }
      const revRaw = readOption(argv, "--expected-revision");
      if (title !== undefined) body.title = title;
      if (to !== undefined) body.address = to;
      if (revRaw !== undefined) body.expectedRevision = Number(revRaw);
      if (text !== undefined) {
        body.action = taskId
          ? { kind: "task.run", taskId, content: text }
          : { kind: invoke ? "session.invoke" : "message.send", content: text };
      }
      const { at, interval, recurrence, timezone } = parseTimingOptions(argv);
      if (timezone !== undefined) body.timezone = timezone;
      if (at !== undefined) body.nextAt = Date.parse(at);
      if (interval !== undefined) body.intervalMs = Number(interval);
      if (recurrence !== undefined) body.recurrence = recurrence;

      return await callUnifiedService(env, {
        method: "PUT",
        path: `/api/runner/schedules/${encodeURIComponent(id)}`,
        body,
      });
    }

    if (sub !== "create") {
      throw new Error(SCHEDULES_USAGE);
    }

    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--invoke" || arg === "--repeat") {
        if (arg === "--repeat" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
          throw new Error(
            "In Protocol v2, use --frequency for calendar recurrence; --repeat is a boolean flag for duplicate execution",
          );
        }
        continue;
      }
      if (
        !CREATE_VALUE_OPTIONS.has(arg) ||
        !argv[i + 1] ||
        argv[i + 1]!.startsWith("--")
      ) {
        throw new Error("Unknown option or missing value: " + arg);
      }
      if (argv.slice(1, i).includes(arg)) {
        throw new Error("Duplicate option: " + arg);
      }
      i++;
    }

    const text = readOption(argv, "--text");
    const title = readOption(argv, "--title");
    const to = readOption(argv, "--to")?.trim() || "current";
    const taskId = readOption(argv, "--task-id")?.trim();
    const invoke = hasFlag(argv, "--invoke");
    if (invoke && taskId) {
      throw new Error("Choose --invoke or --task-id, not both");
    }
    const { at, interval, frequency, recurrence, timezone } =
      parseTimingOptions(argv);
    if (!text || !timezone || (!frequency && !at && !interval)) {
      throw new Error(SCHEDULES_USAGE);
    }
    const timing = z.object(scheduleTimingShape).parse({
      timezone,
      ...(at ? { nextAt: Date.parse(at) } : {}),
      intervalMs: interval ? Number(interval) : null,
      ...(recurrence ? { recurrence } : {}),
    });
    const action = taskId
      ? { kind: "task.run" as const, taskId, content: text }
      : {
          kind: invoke ? ("session.invoke" as const) : ("message.send" as const),
          content: text,
        };
    const body = {
      ...(title !== undefined ? { title } : {}),
      address: to,
      ...timing,
      action,
    };
    const key = deriveCommandIdempotencyKey(env, "schedules.create", body, {
      repeat: hasFlag(argv, "--repeat"),
    });
    return await submitAndWaitCommand(env, {
      method: "POST",
      path: "/api/runner/schedules",
      idempotencyKey: key,
      body,
    });
  } catch (error) {
    return {
      status: "error",
      code: "invalid_schedule",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
