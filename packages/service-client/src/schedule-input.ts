import { z } from "zod";
import { calendarOccurrence } from "./schedule-timing";

export const recurrenceSchema = z.object({
  kind: z.enum(["daily", "weekdays", "weekly", "custom"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(0).max(6)).max(7),
  frequency: z.enum(["hourly", "daily", "weekly", "monthly", "yearly"]).optional(),
  every: z.number().int().min(1).max(100).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const at = Date.parse(value + "T00:00:00Z");
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
  }, "无效的开始日期").optional(),
  monthDays: z.array(z.number().int().min(1).max(31)).min(1).max(31).transform(days => [...new Set(days)].sort((a, b) => a - b)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  month: z.number().int().min(1).max(12).optional(),
}).strict().superRefine((r, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (r.kind === "weekly" && !r.days.length) fail("请选择执行日期");
  if (r.kind !== "custom") return;
  if (!r.frequency) { if (!r.days.length) fail("请选择执行日期"); return; }
  if (!r.startDate || !r.every) fail("请设置开始日期和重复间隔");
  if (r.frequency === "weekly" && !r.days.length) fail("请选择执行日期");
  if (["monthly", "yearly"].includes(r.frequency) && !r.monthDays?.length && !r.dayOfMonth) fail("请至少选择一个日期");
  if (r.frequency === "yearly") {
    if (!r.month) fail("请选择月份");
    else if ((r.monthDays ?? (r.dayOfMonth ? [r.dayOfMonth] : [])).some(day => new Date(Date.UTC(2000, r.month! - 1, day)).getUTCMonth() !== r.month! - 1)) fail("该月份不存在所选日期");
  }
});

export const scheduleTimingShape = {
  recurrence: recurrenceSchema.nullable().optional(),
  nextAt: z.number().int().positive().optional(),
  timezone: z.string().min(1),
  intervalMs: z.number().int().min(60000).max(31536000000).nullable().default(null),
};

const timingSchema = z.object(scheduleTimingShape);

/** Shared by dashboard and Runner; wall-clock nextAt is always server-computed. */
export function resolveScheduleTiming(input: z.infer<typeof timingSchema>, now = Date.now()) {
  new Intl.DateTimeFormat("en", { timeZone: input.timezone });
  if (input.recurrence && input.intervalMs != null) throw new Error("Calendar and interval rules cannot be combined");
  const nextAt = input.recurrence ? calendarOccurrence(input.recurrence, input.timezone, now)
    : input.nextAt ?? (input.intervalMs ? now + input.intervalMs : NaN);
  if (!Number.isFinite(nextAt) || nextAt <= now || nextAt >= now + (input.recurrence?.kind === "custom" ? 101 * 366 : 365) * 86400000)
    throw new Error("执行时间必须在允许的未来范围内。");
  return { nextAt, timezone: input.timezone, intervalMs: input.intervalMs ?? null, recurrence: input.recurrence ?? null };
}
