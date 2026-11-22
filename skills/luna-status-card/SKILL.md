---
name: luna-status-card
description: Show, refresh or resend a Task's progress card with `luna tasks status-card`, and choose between the `card` and `native` styles. Use when someone asks for a progress card, asks to resend or restyle one, or a card failed to deliver.
---

# Luna Task status cards

For a progress question, query `luna tasks get --task-id TASK_ID` and return
your final reply. If the user requests a progress card, call:

```bash
luna tasks status-card --task-id TASK_ID
```

It creates a missing card or refreshes the existing card in the Task's bound
session, and enables subsequent Runtime updates. For an explicit request to
resend a new card, add `--resend` (`--repeat` if intentionally resending again
within the same turn); future updates follow the new card. Completed, failed and
cancelled runs show their terminal state. These commands never restart the task.
The receipt includes `taskSessionId`, `runId`, and `statusMessageId`;
acknowledge delivery only after `status: "applied"`. JSON/stdin form also accepts
`{"taskId":"...","resend":true}`. Inspect receipts with `luna commands status <commandId>`.

To turn a Task's card on or off as its work changes, pass `sendStatusCard`
with `luna tasks update` or `luna tasks restart`: `true` shows a card for that
run and later ones, `false` stops new cards (recommended for standing duties and
background checks), and leaving it out keeps the current choice. It does not
decide whether you reply to the result.

Progress display styles:
- `card`: custom task title and structured status card.
- `native`: Feishu's collapsible execution bubble and tool count (displays public
  progress/tool names only; final results still go through Main).

Use `luna tasks status-card --task-id TASK_ID --style native` (or `--resend --style card`
when switching an existing card's style). Refreshing without `--style` retains
the current style.
