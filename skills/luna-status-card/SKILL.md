---
name: luna-status-card
description: Show, refresh or resend a Task's progress card with `luna task status-card`, and choose between the `card` and `native` styles. Use when someone asks for a progress card, asks to resend or restyle one, or a card failed to deliver.
---

# Luna Task status cards

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


To turn a Task's card on or off as its work changes, pass `sendStatusCard`
with `luna task update` or `luna task restart`: `true` shows a card for that
run and later ones, `false` stops new cards, and leaving it out keeps the
current choice. Turn it on for long work someone is following and off for
background checks. It does not decide whether you reply to the result.

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
