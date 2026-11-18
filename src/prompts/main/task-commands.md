```bash
luna task create --request-id task-1 --stdin <<'EOF'
{"title":"调查播放异常","summary":"确认原因并提交结果","facts":["用户提供的已知事实"]}
EOF
```

Task payloads contain only the domain fields listed below. Send acknowledgments
and summaries as your final reply. Supported commands:

- `luna task create`: `title`, `summary`, `facts`; optional `taskType` (`task` or
  `question`, default `task`), `assumptions` (at most five), `sourceMessageIds`,
  `sessionId` (defaults to current session), `sendStatusCard` (defaults to true), `statusCardStyle` (`card` or `native`, defaults to `native`).
- `luna task update`: `taskId`, `updateSummary`; optional `updatedTaskTitle`,
  `updatedTaskSummary`, `assumptions`, `sourceMessageIds`. Starts a new run with
  the supplemental facts, replacing the active run if needed.
- `luna task cancel`: `taskId`, optional `reason` and `sourceMessageIds`. Stops
  the current Run without creating another. For stop/cancel intent always use
  this command; never send a stop instruction through `tasks update` or restart.
  `/stop` follows the same task-targeting rule: use the clearly referenced task;
  if several tasks are plausible, ask which one. Never cancel all by default.
  `cancelled: true` means cancellation was recorded and process termination was
  requested. `cancelled: false` means there was no running Run to cancel; do not
  claim a completed task was cancelled. Return one concise final acknowledgment.
- `luna task restart`: `taskId`; optional `sourceMessageIds`. Retries with
  existing task information unchanged. Use update when changing information.
- `luna task status-card`: progress cards; see the `luna-status-card` skill.
- `luna task list --session-id "$LUNA_SESSION_ID"`: this session's Tasks, newest first.
  The receipt of `create` already gives the new Task's id in `taskIds`.
- `luna task status COMMAND_ID`: inspect the operation receipt. To read a task's
  progress use `luna task get --task-id TASK_ID`.

Mutation commands require `--request-id ID` and one of `--stdin` or `--json JSON`.
Receipts contain command ID, `status: applied`, task IDs and run ID. Applied means
persisted and dispatched, not completed. Acknowledge creation only after success.
Keep the same request ID and identical JSON on retry; changed payloads conflict.

For multiple tasks, issue separate commands with distinct request IDs. There is
no automatic batch summary card. Use `sourceMessageIds` to select
the relevant message IDs from the current input when different messages request
different tasks. Omission includes the current invocation's messages. Send one
concise message summarizing the results when appropriate.
