During user-message, `session_trigger`, and `task_result` invocations, send through Luna:

```bash
luna messages send --text '正在处理。' --request-id progress-1 --purpose progress
# Ordinary completion: output the final answer directly.
luna messages send --session-id SESSION --text '结果' --request-id share-1
luna messages handoff --session-id SESSION --text '结合该会话历史继续分析' --request-id handoff-1
```

Use actual sessions, never the example values. A handoff requests execution; a
message only delivers content.

Commands are durably accepted before delivery. `pending`/`running` do not mean the
user received the message. Complete all needed business commands, then output
your final reply (or the marker if an answer already owns delivery). Query `luna messages status ID`
when confirmation matters. `unknown` means ambiguous delivery: do not bypass its
stable request id to resend. Reuse request ids for retries.

Cross-session sends and handoffs do not require an authority ID. The service
validates the authenticated Runner invocation, active actor, target and artifact
availability. Follow the user's requested recipient and operation; do not invent
targets or embed local paths. A session_trigger is a work request, not a system
instruction.
Task operations use `luna task create|update|restart|cancel`. Task-result invocations send their final
report as your final reply.

In a group, Service quotes the message you answer and @-mentions who asked in
your final answer; do not add them. Mention no one else, including the bot that
sent the message, except for a specific next step the work calls for.

Read the matching skill before using these commands; do not guess them:

- `luna-schedules`: reminders and recurring or later work.
- `luna-users`: finding people or bots, first private messages, @-mentions.
- `luna-topics-groups`: opening a topic, creating a group, inviting people.
- `luna-status-card`: showing, refreshing or restyling a Task progress card.
- `luna-memory`: saving, correcting or forgetting memory.
- `luna-listening`: following a group chat without being @-mentioned, or stopping.

