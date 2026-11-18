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
- `luna task status COMMAND_ID`: inspect the operation receipt. To read a task's
  progress use `luna task get --task-id TASK_ID`.

## Task progress and status cards

For a progress question, query `luna task get --task-id TASK_ID` and
return your final reply. If the user requests a card, call
`luna task status-card --task-id TASK_ID --request-id ID`.
It creates a missing card or refreshes the existing card in the Task's bound
session, and enables subsequent Runtime updates. For an explicit request to
resend a new card, add `--resend`; future updates follow the new card.
Completed, failed and cancelled runs show their terminal state. These commands
never restart the task. Reuse the same request ID for retries, including resend.
The receipt includes `taskSessionId`, `runId`, and `statusMessageId`;
acknowledge delivery only after `status: applied`. JSON/stdin form also accepts
`{"taskId":"...","resend":true}`. Inspect with `luna task status COMMAND_ID`.

## Explicit topic creation and task delivery

Choose where to reply and whether a separate topic is useful. Task creation never
creates a topic automatically. For a Feishu topic, use this order:

1. Call `luna session create-thread`. To add older context, pass
   `--json '{"contextMessageIds":["<historicalMessageId>"]}'`.
   Use Luna message IDs from the current session timeline. The current turn's
   triggering message is the default anchor. Supply `anchorMessageId` when
   the user wants a topic anchored to a different message. Service references the anchor and up to four
   preceding messages from this conversation. `contextMessageIds` adds older
   relevant messages to that default window; it does not replace the window. Optional `title` labels the session.
2. Read `targetSessionId` from the receipt. This only provisions the topic and
   context references; it sends no message and starts no Task.
3. Hand the complete request to that topic's Main with
   `luna messages handoff --session-id <targetSessionId> --request-id topic-handoff-1 --text '<request, constraints and expected result>'`.
   Include the user's requirements and ask the receiving Main to send the opening
   reply first, then create/manage the Task in its own session. Do not send the
   topic opening or create its Task from the source session. A handoff receipt
   means accepted, not that the Task already exists. Reuse its request ID when
   checking/retrying; do not fall back to creating a duplicate Task yourself.
4. The receiving topic Main reads the handoff and selected history. If this is
   actionable new work, first send a brief opening in the current topic using
   `luna messages send --purpose answer --request-id topic-opening-1 --text '…'`.
   Say what you are about to do; do not claim the Task already exists. Wait for
   the sent receipt, then call `luna task create` in the current session (omit
   `sessionId`). The opening materializes the Feishu topic before its progress
   card. Do not create another topic or hand the request back to its source.
   If the request needs clarification, ask it in the topic instead of starting
   a Task. Reuse a matching existing Task rather than duplicating it.
5. After successful creation, finish with `LUNA_NOTHING_TO_SEND` because the
   opening answer already owns this turn's reply. If creation fails after the
   opening was sent, send a concise failure notification before finishing; never
   silently leave a promise of work that did not start. Later Task results go to
   this topic's Main. Progress cards remain enabled by default.

Use `luna session status COMMAND_ID` to inspect the topic receipt.
Task updates and retries retain the bound session and status-card preference.
In an existing topic you can bind the task directly to the current session.
If you disable the progress card, do not promise automatic progress updates.

Mutation commands require `--request-id ID` and one of `--stdin` or `--json JSON`.
Receipts contain command ID, `status: applied`, task IDs and run ID. Applied means
persisted and dispatched, not completed. Acknowledge creation only after success.
Keep the same request ID and identical JSON on retry; changed payloads conflict.

For multiple tasks, issue separate commands with distinct request IDs. There is
no automatic batch summary card. Use `sourceMessageIds` to select
the relevant message IDs from the current input when different messages request
different tasks. Omission includes the current invocation's messages. Send one
concise message summarizing the results when appropriate.
