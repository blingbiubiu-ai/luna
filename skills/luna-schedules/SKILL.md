---
name: luna-schedules
description: Create, list or change scheduled reminders and recurring work with `luna schedules`. Use when someone asks for a reminder or for something to happen later or repeatedly: "每天X点", "每周X", "每月X号", "N分钟后", "明天X点", "提醒我", "定时", "周期", recurring, reminder.
---

# Luna schedules

```bash
luna schedules create --at '2026-11-10T09:00:00+08:00' --timezone Asia/Singapore --text '检查最新进展并汇报' --invoke --request-id schedule-1
```

Use the actual requested date, time and timezone (see `now` and `timezone` in your input), never the example values.

A schedule without
`--invoke` delivers the fixed text without invoking Main. `--interval-ms` creates
fixed elapsed-time recurrence; it is not a wall-clock cron rule. It may omit
`--at`: the server starts it one interval after creation.

Calendar recurrence is natively supported through the same scheduler as the
dashboard. Use `--repeat` with `--time HH:mm` and `--timezone`:
- `daily` or `weekdays`: the specified local time.
- `weekly --days 1,3,5`: Monday/Wednesday/Friday (0=Sunday, 1=Monday … 6=Saturday).
- `monthly --month-days 1,15`: the 1st and 15th of each month.
- `yearly --month 2 --month-days 28,29`: selected days of February.
- `hourly --every 3`: every three wall-clock hours from the start date/time.
Use `--every N --start-date YYYY-MM-DD` for anchored custom cycles (not weekdays).
Every defaults to 1; the start date defaults to today's date in the specified
timezone. Keep an explicit start date for custom rules and reuse the exact
arguments and request ID on retries, including across midnight.
Calendar options cannot be combined with `--at` or `--interval-ms`.
Missing dates (e.g. February 29 in non-leap years) are skipped, never moved to
month end. Invalid dates for a selected yearly month are rejected.

For a monthly analysis, use the actual requested time and timezone, for example:
`luna schedules create --repeat monthly --month-days 1 --time 09:00 --start-date 2026-11-10 --timezone Asia/Singapore --text '执行每月汇总并汇报' --invoke --request-id monthly-summary-1`

The scheduler advances recurring tasks itself. Do not implement calendar
recurrence by asking Main to create another one-shot task after each execution.
Only report successful creation after the command succeeds; report validation
errors rather than claiming a schedule exists.
