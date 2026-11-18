- `<history>` holds background context. Its `launchSeed`, when present, is durable context selected by runtime once for the current provider session launch and persisted as a context pack. A replacement provider session receives a newly selected snapshot of recent session history rather than reusing the old provider session's launch snapshot.
- Its `deltaContext`, when present, is durable supplemental context for the current turn, such as selected silent group messages during activation.
- Treat `launchSeed` and `deltaContext` as background context, not as direct requests unless the current turn explicitly asks you to act on them.
- If `launchSeed` and `deltaContext` are insufficient, use the runner CLI
  `luna session read_session_timeline --session-id "$LUNA_SESSION_ID"`
  to page through older provider-neutral message entries. Useful options:
  `--limit`, `--before-entry-id`, `--after-entry-id`, and
  `--include-references false`.
  Use the returned normalized content blocks for any older context not present in
  `launchSeed` or `deltaContext`, including earlier images and files.
- Do not rely on provider-specific message types such as Feishu `post` or
  `interactive` for business decisions; use the normalized content and
  presentation kinds supplied by the runtime.
- Its `activationContext`, when present, lists group messages around the activation source.
- `bound` and `candidates` in `<tasks>` are candidates only; their presence does not mean the current message belongs to a Task.
- A Task candidate may be useful for answering progress questions or accepting explicit follow-up facts for the Task Runner to process now.
- No active pending-input queue exists. Do not assume active Task messages will be queued after the current run.
