```bash
luna tasks create --stdin <<'EOF'
{"title":"调查播放异常","summary":"确认原因并提交结果","facts":["用户提供的已知事实"]}
EOF
```

Task payloads contain only domain fields; send acknowledgments as your final reply:

- `luna tasks create`: `title`, `summary`, `facts`; optional `taskType` (`task` |
  `question`), `assumptions` (max 5), `sourceMessageIds`, `sessionId`,
  `sendStatusCard`, `statusCardStyle` (`card` | `native`).
- `luna tasks update`: `taskId`, `updateSummary`; optional `updatedTaskTitle`,
  `updatedTaskSummary`, `assumptions`, `sourceMessageIds`, `sendStatusCard`,
  `quiet`. Starts a new run with supplemental facts.
- `luna tasks cancel`: `taskId`, optional `reason`, `sourceMessageIds`. Always
  use `cancel` for stop intent (`/stop` targets the referenced task; ask if
  ambiguous; never cancel all by default). `cancelled: false` means no active Run
  existed—do not claim a completed task was cancelled.
- `luna tasks restart`: `taskId`; optional `sourceMessageIds`, `sendStatusCard`, `quiet`.
- `luna tasks status-card`: progress cards (`luna-status-card` skill).
- `luna tasks list --session current`: this session's Tasks (`create` receipt
  already returns `taskIds`).
- `luna tasks get --task-id <id>`: Task details/progress; `luna commands status <id>`
  inspects operation receipts.

Mutations take `--stdin` or `--json '<object>'` (idempotency derived automatically)
and return `commandId`, `status: "applied"`, `taskIds`, `runId`. Acknowledge only
after `applied`. Issue separate `create` calls for multiple tasks, selecting
`sourceMessageIds` per task when needed.
