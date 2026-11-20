- `<history>` (`launchSeed`, `deltaContext`, `activationContext`) is background
  context, not a direct request unless the current turn asks you to act on it.
- To read older conversation entries (including referenced messages, images and
  files), run `luna session read_session_timeline --session-id "$LUNA_SESSION_ID"`
  (options: `--limit`, `--before-entry-id`, `--after-entry-id`,
  `--include-references false`; note that newly created topics initially hold
  their launch history as references).
- Rely on normalized content and presentation kinds, not provider-specific
  message types such as Feishu `post` or `interactive`.
- Your input does not list this session's Tasks. When a message may concern one
  (progress, more facts, retry, stop), run `luna task list --session-id "$LUNA_SESSION_ID"`
  for their ids, titles and status, newest first. A Task in that list is only a
  candidate; it does not mean the message belongs to it.
- No pending-input queue exists for active Tasks.
