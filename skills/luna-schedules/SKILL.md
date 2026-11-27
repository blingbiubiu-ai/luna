---
name: luna-schedules
description: >-
  Create, list, inspect, update, pause, resume or cancel scheduled reminders and recurring work with `luna schedules`. Use when someone asks for a reminder, future follow-up, or recurring schedule: "每天X点", "每周X", "每月X号", "N分钟后", "明天X点", "提醒我", "定时", "周期", "暂停/修改/取消定时", recurring, reminder.
---

# Luna schedules

## Creating a schedule

```bash
# One-shot session wake-up (--invoke wakes Main at the scheduled time)
luna schedules create --title '跟进进展' --to current \
  --at '2026-11-10T09:00:00+08:00' --timezone Asia/Shanghai \
  --text '检查最新进展并汇报' --invoke

# Direct recurring Task execution (--task-id runs Task Runner directly with quiet: true)
luna schedules create --title '每日汇总' --to current \
  --frequency daily --time 09:00 --timezone Asia/Shanghai \
  --task-id TASK_ID --text '执行每日汇总并生成报告'

# Plain text reminder (no --invoke and no --task-id: delivers fixed text directly)
luna schedules create --title '开会提醒' --to user:USER_ID \
  --at '2026-11-10T14:55:00+08:00' --timezone Asia/Shanghai \
  --text '5 分钟后开始周会'
```

Use the actual requested date, time and timezone (see `<now>` in your input), never example values. CLI derives idempotency keys automatically—do not pass `--request-id` (pass `--repeat` only if intentionally creating a duplicate schedule).

`--to` accepts unified Luna addresses: `current` (default), `self`, `user:<id>`, `session:<id>`, `group:<id>`.

### Action modes
- Default (neither `--invoke` nor `--task-id`): `message.send` — delivers `--text` directly without waking a Runner.
- `--invoke`: `session.invoke` — wakes the target session's Main Runner with `schedule_fired` (`terminalOutputMode: "ignored"`; to post to the chat, Main must call `luna say`).
- `--task-id <id>`: `task.run` — starts a quiet run on the existing Task directly without waking Main first; Main wakes when `task_result` arrives. Prefer this for recurring inspections and standing duties (`luna-duties`).

### Timing modes
- One-shot: `--at '<ISO-8601 with explicit offset>'` (e.g. `2026-11-10T09:00:00+08:00`).
- Fixed elapsed interval: `--interval-ms <ms>` (optional `--at` anchor).
- Wall-clock calendar recurrence: `--frequency` with `--time HH:mm` and `--timezone`:
  - `daily` or `weekdays`
  - `weekly --days 1,3,5` (0=Sunday, 1=Monday … 6=Saturday)
  - `monthly --month-days 1,15`
  - `yearly --month 2 --month-days 28,29`
  - `hourly --every 3`
  - Optional `--every N --start-date YYYY-MM-DD` for custom cycles (not `weekdays`).

Calendar options cannot be combined with `--at` or `--interval-ms`. Missing calendar dates (e.g. Feb 29 in non-leap years) are skipped. The scheduler advances recurring schedules automatically—never simulate recurrence by creating a new one-shot schedule on each run.

## Listing, updating, pausing, resuming, and cancelling

```bash
luna schedules list [--status active|paused|finished]
luna schedules get <schedule-id>
luna schedules update <schedule-id> --time 10:00 --timezone Asia/Shanghai [--expected-revision <n>]
luna schedules pause <schedule-id>
luna schedules resume <schedule-id>
luna schedules cancel <schedule-id>
```

Inspect `lastFailure` in `list` / `get` output when diagnosing missed or failed runs. Report successful creation or updates only after the CLI command succeeds.
