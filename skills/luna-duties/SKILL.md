---
name: luna-duties
description: >-
  Accept, persist, execute, list, adjust, pause or cancel standing duties and recurring inspections ("以后你盯 X", "每天巡检 Y", "每隔一小时看下告警", "现在我给你派了哪些常驻活", "暂停/取消这个值守") using Agent memory, background Tasks, and `task.run` schedules.
---

# Luna standing duties (`luna-duties`)

A **standing duty** is an ongoing responsibility delegated to this Shadow (for example: monitoring CI/alert dashboards, daily bug triage, periodic report delivery, or watching a group's on-call queue). Main never runs external checks directly; duties execute through a persistent background Task triggered on schedule via `task.run`.

## 1. Who may assign a standing duty

Check the requester's `role` in `<events>` (and owner identity in `<soul>`):

- **Agent owner (`role: "owner"`)**: accept directly once scope, cadence, target conversation, and notification condition ("report every run" vs "speak only when something changed or broke") are clear.
- **Anyone else**: do **not** create the Task or schedule yet. First ask the Agent owner for approval using `luna asks create`:
  ```bash
  luna asks create --to user:OWNER_USER_ID \
    --question '成员请求新增常驻职责：<职责摘要、频率、汇报会话、外部写操作边界>。是否同意接下？' \
    --options '["同意","拒绝"]'
  ```
  Tell the requester you have asked your owner for confirmation. Create the duty only after the owner's `request_result` (`answered` with `"同意"`) arrives; if declined or expired, inform the requester politely.

## 2. Setting up an accepted duty

Perform all four steps so the duty survives restarts and can be managed later:

1. **Save standing duty memory** (`procedure`, Shadow-scoped) with `luna memory add`:
   ```bash
   luna memory add --type procedure --visibility shadow \
     --title '值守：<职责名>' \
     --description '常驻职责：<触发频率、检查内容、汇报条件、关联 taskId 与 scheduleId>' \
     --stdin <<'EOF'
   - 目标与检查步骤：...
   - 静默与汇报条件：无异常时静默（quiet），仅发现新问题或状态变化时在目标会话汇报
   - 工作笔记目录：$HOME/duties/<slug>/
   - 绑定 Task ID / Schedule ID：（创建后用 luna memory update 补齐）
   EOF
   ```
   When the duty defines your role in the **current group chat**, also add or update that group's `chat` memory entry (`luna memory add --type chat ...`, no `--subject`).

2. **Create the persistent background Task** (`sendStatusCard: false` so recurring checks do not spam progress cards):
   ```bash
   luna tasks create --stdin <<'EOF'
   {
     "title": "常驻巡检：<职责名>",
     "summary": "按计划执行巡检，读写 $HOME/duties/<slug>/state.json 比对增量，在报告中写明是否有需要通知的新发现",
     "facts": ["工作笔记路径：$HOME/duties/<slug>/", "无新异常时在报告首行注明 NO_ALERT_CHANGE"],
     "sendStatusCard": false
   }
   EOF
   ```
   Read `taskIds[0]` from the receipt.

3. **Create the `task.run` schedule** targeting the conversation that should receive findings (`--to current`, `group:<id>`, or `user:<id>`):
   ```bash
   luna schedules create --title '常驻巡检：<职责名>' \
     --to current \
     --frequency daily --time 09:30 --timezone Asia/Shanghai \
     --task-id TASK_ID \
     --text '执行常驻巡检，读取并更新 $HOME/duties/<slug>/ 下的上次状态，汇报本次结论'
   ```
   Service runs `task.run` directly on the Task Runner with `quiet: true` without waking Main first. When the Task Run submits `luna tasks report`, Main wakes on `task_result` with `turn.allowSilent: true`:
   - If nothing requires attention, Main outputs `LUNA_NOTHING_TO_SEND`.
   - If something changed or broke, Main sends a concise report to the conversation.

4. **Record `taskId` and `scheduleId` in the `procedure` memory entry** (`luna memory update <memId> --expected-revision 1 --reason '记录已创建的 taskId 与 scheduleId' --stdin`).

## 3. Inspecting, adjusting, pausing, or cancelling duties

- **List current duties**: combine `luna schedules list` with `luna memory search '常驻职责'` so you report exact schedule IDs, cadence, next run time, and any `lastFailure`.
- **Change cadence or instruction**: `luna schedules update <scheduleId> --time 10:00 ...` (and update the `procedure` memory entry).
- **Pause / resume**: `luna schedules pause <scheduleId>` / `luna schedules resume <scheduleId>`.
- **Cancel**: `luna schedules cancel <scheduleId>`, cancel any running Task Run if needed (`luna tasks cancel`), and delete or archive the `procedure` memory entry with `--reason '用户取消该常驻职责'`.
- **Failure handling**: if a duty check fails repeatedly (auth expired, endpoint unreachable), report the failure reason once to the owner or target chat and pause or wait for fixes rather than spamming every cycle.
