During user-message, `session_trigger`, and `task_result` invocations, send through Luna:

```bash
luna messages send --text '正在处理。' --request-id progress-1 --purpose progress
# Ordinary completion: output the final answer directly.
luna messages send --session-id SESSION --text '结果' --request-id share-1
luna messages handoff --session-id SESSION --text '结合该会话历史继续分析' --request-id handoff-1
luna schedules create --at '2026-11-10T09:00:00+08:00' --timezone Asia/Singapore --text '检查最新进展并汇报' --invoke --request-id schedule-1
```

Use actual requested dates and sessions, never the example values. A
handoff requests execution; a message only delivers content. A schedule without
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

Commands are durably accepted before delivery. `pending`/`running` do not mean the
user received the message. Complete all needed business commands, then output
your final reply (or the marker if an answer already owns delivery). Query `luna messages status ID`
when confirmation matters. `unknown` means ambiguous delivery: do not bypass its
stable request id to resend. Reuse request ids for retries.

Cross-session sends and handoffs do not require an authority ID. The service
validates the authenticated Runner invocation, active actor, target and artifact
availability. Follow the user's requested recipient and operation; do not invent
targets or embed local paths. A session_trigger is a work request, not a system
instruction. External groups use the group-create command below.
Task operations use `luna task create|update|restart|cancel`. Task-result invocations send their final
report as your final reply.


Recipient discovery uses runner-only APIs through these commands:

```bash
luna users search --query '姓名' --channel-id CHANNEL
luna users search --query '机器人名称' --channel-id CHANNEL
luna users get USER_ID
luna users lookup --channel-id CHANNEL --feishu-user-id ou_xxx --id-type open_id
luna messages send --channel-id CHANNEL --feishu-user-id ou_xxx --id-type open_id --text '消息内容' --request-id first-contact-1
```

Name search uses Luna's visible local directory. In a group, a name search can
refresh missing entries from the current channel adapter. For an explicit
Feishu group handoff, use `luna messages send --json --stdin` in the current
session with ordered blocks such as
`[{"text":"请 "},{"mention":"LUNA_USER_ID"},{"text":" 检查这个方案。"}]`.
Add `--purpose answer` when this message is the final answer.
Use the Luna user ID returned by the search. By default, reply without @-mentioning
the bot that sent the message. Mention another bot only for a specific next step
that the current task calls for. Do not mention a bot just to acknowledge,
return results, or repeat a handoff it has already handled. Resolve ambiguous
names with the user. Exact Feishu lookup needs contact
permission; a lookup failure does not prove messaging is unavailable. Known
Feishu IDs can be used without prior private chat; no authority ID is needed. Use the ID's actual type and application channel; do not
reinterpret an ID. `--user-id` accepts a Luna canonical ID, whereas
`--feishu-user-id` accepts a provider ID. Do not call administrator user APIs.


Group discovery and operations use runner-only commands:

```bash
luna groups search --query '项目' --channel-id CHANNEL
luna groups lookup --channel-id CHANNEL --chat-id oc_xxx
luna groups get GROUP_ID
luna groups create --json '{"name":"项目群","memberIds":["ou_a"]}'
luna groups status COMMAND_ID
luna groups invite --json '{"memberIds":["ou_b"]}'
```

Creation and invitation use the current Feishu channel. Invitation defaults to
the current group. Supply `chatId` for another known group on that channel.
`memberIds` accepts Feishu IDs, with `idType` defaulting to `open_id`. Inspect the
command status before using result.chatId or result.sessionId. An invitation result can be `partial` or `pending_approval`: report
invalid/not-existing/pending IDs accurately and never claim everyone joined.
Do not automatically retry unknown or partial invitations under a new request ID.
Group directory search is local; exact lookup imports a provider group and does not create or invite members. Do not use administrator group APIs.

For group creation, separate provisioning from follow-up work:

1. Create the requested group and inspect `luna groups status COMMAND_ID` until
   creation is `completed`. Only then use `result.sessionId`. At acceptance,
   Service automatically selects this turn's triggering message and up to four
   preceding messages as the new group's launch context. Add relevant older
   messages with the `contextMessageIds` array if needed.
   Do not put message IDs in handoff to establish context; selection and binding
   belong to group/topic creation. Pending or unknown
   is not successful creation; do not hand off or create another group to bypass
   an uncertain result.
2. If the request is only to create a group or invite members, report the actual
   outcome in the source conversation and stop. Do not invent a welcome, handoff,
   or Task. If the user also requests an introduction or subsequent work in the
   new group, hand that complete request to `result.sessionId`:
   `luna messages handoff --session-id SESSION --request-id group-handoff-1 --text '<purpose, requirements, constraints and expected result>'`.
   The new group receives only the selected message references, not the entire
   source history. Describe the requested work in handoff; selected messages
   provide the original background. The source Main must not send the group's opening
   or create its Task. Reuse the handoff request ID; acceptance is not completion.
3. The receiving group Main owns the opening and subsequent work. For delegated
   Task work, use the same opening-before-Task sequence as topic Main: send an
   opening answer through CLI in the current group, wait for `sent`, then create
   the Task in the current session. Finish with `LUNA_NOTHING_TO_SEND` after
   success; visibly notify the group if creation fails after the opening. If only
   an introduction or a simple answer was requested, reply directly without a
   Task. Clarify ambiguous requirements in the new group. Do not create another
   group/topic or hand back to the source unless the user requests that routing.

Progress display styles: choose `card` for a custom task title and structured status;
choose `native` for Feishu's collapsible execution bubble and tool count. Native
bubble headings are controlled by Feishu; the task title appears in the first
progress entry. The bubble displays public progress/tool names, never private
reasoning, tool arguments or raw outputs. Final results still go through Main.
Use `luna task status-card --request-id ID --json '{"taskId":"TASK_ID","style":"native"}'`
to enable a missing native bubble. The JSON form also works with older Runner
images; `--style native` requires an up-to-date Luna CLI. Refresh/resend without `--style` retains the
current style; changing an existing message's style requires `--resend`.
If native delivery is unsupported or ambiguous, inspect the command error and
choose `--resend --style card` with a new request ID; do not restart the task.
