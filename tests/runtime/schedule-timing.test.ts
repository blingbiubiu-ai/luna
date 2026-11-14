import { expect, test } from "bun:test";
import { calendarOccurrence, type CalendarRule } from "@luna/service-client/schedule-timing";
const rule = (kind: CalendarRule["kind"], time = "09:00", days = [1]): CalendarRule => ({ kind, time, days });
const next = (r: CalendarRule, zone: string, at: string) => new Date(calendarOccurrence(r, zone, Date.parse(at))).toISOString();
test("daily uses the task timezone and advances strictly after a due occurrence", () => {
  expect(next(rule("daily"), "Asia/Singapore", "2026-11-09T00:00:00Z")).toBe("2026-11-09T01:00:00.000Z");
  expect(next(rule("daily"), "Asia/Singapore", "2026-11-09T01:00:00Z")).toBe("2026-11-10T01:00:00.000Z");
});
test("weekdays skip weekends; weekly/custom choose selected weekdays", () => {
  expect(next(rule("weekdays"), "Asia/Singapore", "2026-11-13T02:00:00Z")).toBe("2026-11-16T01:00:00.000Z");
  expect(next(rule("weekly", "09:00", [5]), "Asia/Singapore", "2026-11-09T02:00:00Z")).toBe("2026-11-13T01:00:00.000Z");
  expect(next(rule("custom", "09:00", [2,4]), "Asia/Singapore", "2026-11-09T02:00:00Z")).toBe("2026-11-10T01:00:00.000Z");
});
test("DST keeps wall clock time, skips nonexistent time and runs an ambiguous time once", () => {
  expect(next(rule("daily"), "America/New_York", "2026-03-07T14:00:00Z")).toBe("2026-03-08T13:00:00.000Z");
  expect(next(rule("daily", "02:30"), "America/New_York", "2026-03-08T00:00:00Z")).toBe("2026-03-09T06:30:00.000Z");
  expect(next(rule("daily", "01:30"), "America/New_York", "2026-11-01T05:30:00Z")).toBe("2026-11-02T06:30:00.000Z");
  expect(new Date(calendarOccurrence(rule("daily", "01:30"), "America/New_York", Date.parse("2026-11-01T06:45:00Z"), "previous")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
});
test("custom hourly and daily intervals stay anchored across boundaries", () => {
  expect(next({...rule("custom", "09:15"), frequency: "hourly", every: 3, startDate: "2026-11-09"}, "Asia/Singapore", "2026-11-09T04:15:00Z")).toBe("2026-11-09T07:15:00.000Z");
  expect(next({...rule("custom"), frequency: "daily", every: 2, startDate: "2026-11-09"}, "Asia/Singapore", "2026-11-09T02:00:00Z")).toBe("2026-11-11T01:00:00.000Z");
  expect(next({...rule("custom"), frequency: "daily", every: 2, startDate: "2026-11-09"}, "Asia/Singapore", "2026-11-01T02:00:00Z")).toBe("2026-11-09T01:00:00.000Z");
});
test("custom every two weeks selects weekdays in anchored weeks only", () => {
  const r: CalendarRule = {...rule("custom", "09:00", [1,3]), frequency: "weekly", every: 2, startDate: "2026-11-09"};
  expect(next(r, "Asia/Singapore", "2026-11-11T02:00:00Z")).toBe("2026-11-23T01:00:00.000Z");
  expect(new Date(calendarOccurrence(r, "Asia/Singapore", Date.parse("2026-11-22T12:00:00Z"), "previous")).toISOString()).toBe("2026-11-11T01:00:00.000Z");
});
test("monthly recurrence skips missing dates and retains every N month anchoring", () => {
  const r: CalendarRule = {...rule("custom"), frequency: "monthly", every: 1, startDate: "2026-01-01", dayOfMonth: 31};
  expect(next(r, "Asia/Singapore", "2026-01-31T02:00:00Z")).toBe("2026-03-31T01:00:00.000Z");
  expect(next({...r, every: 2, dayOfMonth: 15}, "Asia/Singapore", "2026-01-15T02:00:00Z")).toBe("2026-03-15T01:00:00.000Z");
});
test("yearly recurrence supports leap days and previous occurrences", () => {
  const r: CalendarRule = {...rule("custom"), frequency: "yearly", every: 1, startDate: "2026-01-01", month: 2, dayOfMonth: 29};
  expect(next(r, "Asia/Singapore", "2026-01-01T00:00:00Z")).toBe("2028-02-29T01:00:00.000Z");
  expect(new Date(calendarOccurrence(r, "Asia/Singapore", Date.parse("2031-12-01T00:00:00Z"), "previous")).toISOString()).toBe("2028-02-29T01:00:00.000Z");
});
test("monthly multi-date rules advance within month, across intervals and skip invalid days individually", () => {
  const r: CalendarRule = {...rule("custom"), frequency: "monthly", every: 2, startDate: "2026-01-01", monthDays: [3, 1, 2, 2, 31]};
  expect(next(r, "Asia/Singapore", "2026-01-01T01:00:00Z")).toBe("2026-01-02T01:00:00.000Z");
  expect(next(r, "Asia/Singapore", "2026-01-31T01:00:00Z")).toBe("2026-03-01T01:00:00.000Z");
  expect(next({...r, every: 1}, "Asia/Singapore", "2026-02-03T01:00:00Z")).toBe("2026-03-01T01:00:00.000Z");
  expect(new Date(calendarOccurrence(r, "Asia/Singapore", Date.parse("2026-03-02T02:00:00Z"), "previous")).toISOString()).toBe("2026-03-02T01:00:00.000Z");
});
test("yearly multiple dates advance within the selected month and across anchored years", () => {
  const r: CalendarRule = {...rule("custom"), frequency: "yearly", every: 2, startDate: "2026-01-01", month: 2, monthDays: [29, 28, 1]};
  expect(next(r, "Asia/Singapore", "2026-02-01T01:00:00Z")).toBe("2026-02-28T01:00:00.000Z");
  expect(next(r, "Asia/Singapore", "2026-02-28T01:00:00Z")).toBe("2028-02-01T01:00:00.000Z");
  expect(next(r, "Asia/Singapore", "2028-02-28T01:00:00Z")).toBe("2028-02-29T01:00:00.000Z");
  expect(new Date(calendarOccurrence(r, "Asia/Singapore", Date.parse("2028-03-01T00:00:00Z"), "previous")).toISOString()).toBe("2028-02-29T01:00:00.000Z");
  expect(next(rule("weekly", "09:00", [1,3]), "Asia/Singapore", "2026-11-09T01:00:00Z")).toBe("2026-11-11T01:00:00.000Z");
});
