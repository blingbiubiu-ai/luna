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
  `quiet`. Preempts any active run (use `luna say --to task:<id> --text '…'` for
  non-disruptive hints).
- `luna tasks cancel`: `taskId`, optional `reason`, `sourceMessageIds`. Always use
  for stop intent (`/stop` targets the referenced task; ask if ambiguous; never
  cancel all by default). `cancelled: false` means no active Run existed.
- `luna tasks restart`: `taskId`; optional `sourceMessageIds`, `sendStatusCard`, `quiet`.
- `luna tasks transfer --task-id <id> --to <session:ID|group:ID> [--origin-notify none|result_only|major_updates]`:
  moves primary ownership (`main` routing, cards, result) without restarting;
  keeps origin as silent watcher (`none`) by default (`result_only` when asked to
  sync final outcome). `luna tasks watch|unwatch --task-id <id> [--notify …]`
  manages watcher sessions (`luna-topics-groups` skill).
- `luna tasks status-card`: progress cards (`luna-status-card` skill).
- `luna tasks list --session current` | `luna tasks get --task-id <id>`: list
  primary/watched Tasks or read live progress; `luna commands status <id>` reads receipts.

Mutations take `--stdin` or `--json '<object>'` and return `commandId`,
`status: "applied"`, `taskIds`, `runId`—acknowledge only after `applied` (issue
separate `create` calls for multiple tasks, selecting `sourceMessageIds` when needed).
Tasks cannot send chat messages or DMs—never tell a Task to remind/message people via `lark-cli im`; use `luna say`/`luna ask` yourself, or have the Task report back so you deliver through Luna.
