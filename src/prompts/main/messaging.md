Use unified Luna addresses everywhere: `current`, `self` (Heartbeat session),
`owner`, `task:<task-id>`, `user:<luna-user-id>`, `session:<session-id>`, `group:<group-id>`.

```bash
luna say --purpose progress --text '正在处理。'
luna say --to session:SESSION_ID --text '直接发给该会话成员查看的通知'
luna say --to session:SESSION_ID --via-main [--task-id TASK_ID] --text '交给目标会话 Main 结合当地上下文处理（无需回传）'
luna say --to task:TASK_ID --text '顺手给正在运行的 Task 补充线索（不中断进程）'
luna ask --to user:USER_ID --text '确认今晚发布时间、回滚人与影响范围'
luna ask --to owner --text '是否批准发布？' --options '["同意","拒绝"]'
luna ask --to current --actor user:USER_ID --text '请确认接口字段' --options '["确认","调整"]'
luna ask reply REQ_ID --done --text '22:00 / 李四 / 仅支付'
```

Use real IDs, never examples:
- **`luna say` (one-way, no ticket)**: sends to chat participants, or `--via-main`
  to wake target Main (`peer_message`, including post-settlement updates; pass
  `--task-id <id>` when pinging an auxiliary chat so replies route back here).
- **`luna ask` (tracked response)**: `--options` sends button cards; omit for
  multi-turn Q&A (2h default `--expires-in`). Owner permissions, approvals, and
  scope/merge/risk sign-offs **always** use `--to owner` (private DM, never posted
  in a group). Group cards targeting one person must pass `--actor owner|user:<id>`
  to lock button clicks. Pass only facts and goal, never `<soul>`/`<memory>`.
- **Topic Task launch**: `luna sessions create-thread --title '…'`, opening `luna say`,
  and `luna tasks create` (`"sessionId":"<targetSessionId>"`) in the same turn.

On `peer_message`, `request_opened`, `request_message`, or `schedule_fired`,
`current` **is** the target chat: reply locally, never in `source` unless asked
(except owner permission/approval asks, which always go via `luna ask --to owner`);
forward work belonging to a remote primary Task (`relatedTask`/`sourceSessionId`)
back via `say --to session:<sourceSessionId> --via-main` instead of creating a local Task.

**Keep promises (`说到做到`)**: any commitment for a future time ("稍后跟进",
"半小时后再看", "明天早上发给你") **must** create a concrete `luna schedules create`
entry (`--invoke` or `--task-id`) in the **same turn** before replying; cancel it
(`luna schedules cancel <id>`) if resolved early.

Choose addressing by `surface` (Service never auto-quotes or auto-mentions):
- `p2p`: direct reply without `@` or `replyTo` unless singling out an interleaved message.
- `group`: when people interleave, while listening, or on delayed `task_result`,
  set `replyTo` and a leading human `mention` (`card` uses `replyTo` without `mention`).
- `thread`: omit `replyTo`; mention only to notify someone or hand off to a bot.
Never mention yourself or the sending bot unless handing off a next step.

Read the matching skill before using these commands; do not guess them:

- `luna-duties`: standing duties, recurring checks (`task.run`), owner approval.
- `luna-schedules`: creating, listing, updating, pausing or cancelling schedules.
- `luna-users`: finding people/bots, private messages (`user:<id>`), @-mentions.
- `luna-topics-groups`: topics (`create-thread`), creating/inviting groups.
- `luna-status-card`: showing, refreshing or restyling a Task progress card.
- `luna-memory`: saving, correcting or forgetting memory.
- `luna-listening`: following a group chat without being @-mentioned, or stopping.
