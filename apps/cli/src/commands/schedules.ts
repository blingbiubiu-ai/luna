import type { CliResult, Env } from "@luna/cli-support/types";
import { readOption } from "@luna/cli-support/options";
import { callUnifiedService } from "@luna/cli-support/service-client";
import { recurrenceSchema, scheduleTimingShape } from "@luna/service-client/schedule-input";
import { z } from "zod";

const usage = "luna schedules create --timezone <IANA zone> --text <text> --request-id <id> (--at <ISO timestamp with offset> | --interval-ms <ms> | --repeat daily|weekdays|weekly|hourly|monthly|yearly --time HH:mm [--days 1,3,5] [--month-days 1,15] [--month 2] [--every 2 --start-date YYYY-MM-DD]) [--invoke] [--session-id <id>]";
export async function runSchedulesCli(argv: readonly string[], env: Env): Promise<CliResult> {
    try {
        const options = new Set(["--text", "--at", "--request-id", "--timezone", "--interval-ms", "--session-id", "--repeat", "--time", "--days", "--month-days", "--month", "--every", "--start-date"]);
        for (let i = 1; i < argv.length; i++) {
            const arg = argv[i]!;
            if (arg === "--invoke") continue;
            if (!options.has(arg) || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw new Error("Unknown option or missing value: " + arg);
            if (argv.slice(1, i).includes(arg)) throw new Error("Duplicate option: " + arg);
            i++;
        }
        const opt = (name: string) => readOption(argv, name);
        const text = opt("--text"), at = opt("--at"), key = opt("--request-id"), timezone = opt("--timezone"), interval = opt("--interval-ms"), sessionId = opt("--session-id"), repeat = opt("--repeat");
        if (argv[0] !== "create" || !text || !key || !timezone) throw new Error(usage);
        new Intl.DateTimeFormat("en", {timeZone: timezone});
        if (!/^[\w.-]{1,128}$/.test(key)) throw new Error("Invalid request id");
        if (repeat && (at || interval)) throw new Error("--repeat cannot be combined with --at or --interval-ms");
        const calendarOptions = ["--time", "--days", "--month-days", "--month", "--every", "--start-date"];
        if (!repeat && calendarOptions.some(name => opt(name) !== undefined)) throw new Error("Calendar options require --repeat");
        const list = (name: string) => {
            const value = opt(name);
            if (value === undefined) return [];
            if (!/^\d+(,\d+)*$/.test(value)) throw new Error("Invalid date list: " + name);
            return [...new Set(value.split(",").map(Number))].sort((a,b) => a-b);
        };
        let recurrence;
        if (repeat) {
            if (!["hourly", "daily", "weekdays", "weekly", "monthly", "yearly"].includes(repeat)) throw new Error("Invalid repeat frequency");
            if (opt("--days") && repeat !== "weekly") throw new Error("--days requires weekly");
            if (opt("--month-days") && !["monthly", "yearly"].includes(repeat)) throw new Error("--month-days requires monthly or yearly");
            if (opt("--month") && repeat !== "yearly") throw new Error("--month requires yearly");
            if (repeat === "weekdays" && (opt("--every") || opt("--start-date"))) throw new Error("Weekdays does not accept --every or --start-date");
            const custom = ["hourly", "monthly", "yearly"].includes(repeat) || !!opt("--every") || !!opt("--start-date");
            // Stable within the requested timezone; persisted by the server as the cycle anchor.
            const startDate = opt("--start-date") ?? new Intl.DateTimeFormat("en-CA", {timeZone: timezone, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
            recurrence = recurrenceSchema.parse({ kind: custom ? "custom" : repeat, time: opt("--time"), days: list("--days"),
                ...(custom ? {frequency: repeat, every: Number(opt("--every") ?? 1), startDate} : {}),
                ...(opt("--month-days") ? {monthDays: list("--month-days")} : {}),
                ...(opt("--month") ? {month: Number(opt("--month"))} : {}),
            });
        }
        if (at && !/(Z|[+-]\d{2}:\d{2})$/.test(at)) throw new Error("--at requires an explicit timezone offset");
        if (!repeat && !at && !interval) throw new Error(usage);
        const timing = z.object(scheduleTimingShape).parse({timezone, ...(at ? {nextAt: Date.parse(at)} : {}), intervalMs: interval ? Number(interval) : null, ...(recurrence ? {recurrence} : {})});
        return callUnifiedService(env, { method: "POST", path: "/api/runner/schedules", idempotencyKey: key, body: { target: sessionId ? { kind: "session", sessionId } : { kind: "current_session" }, ...timing, action: { kind: argv.includes("--invoke") ? "session.invoke" : "message.send", content: text } } });
    }
    catch (error) {
        return { status: "error", code: "invalid_schedule", message: String(error) };
    }
}
