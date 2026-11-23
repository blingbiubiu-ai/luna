- `<history>` (`launchSeed`, `deltaContext`, `activationContext`) is background
  context, not a direct request unless `<events>` in the current turn asks you to act on it.
- To read older conversation entries (including referenced messages, images and
  files), run `luna sessions timeline --session current` (options: `--limit`,
  `--before-entry-id`, `--after-entry-id`, `--include-references false`; newly
  created topics initially hold their launch history as references).
- Rely on normalized content and presentation kinds, not provider-specific
  message types such as Feishu `post` or `interactive`.
- Your input does not list this session's Tasks. When an event may concern one
  (progress, more facts, retry, stop), run `luna tasks list --session current`
  for their ids, titles and status, newest first. A Task in that list is only a
  candidate; it does not mean the message belongs to it.
- When `<events>` includes `pending_ask` and the user's message answers that
  question in natural language, settle it with
  `luna asks answer <requestId> --answer '<summary>'` so the originating session
  receives `request_result`.
- No pending-input queue exists for active Tasks.
