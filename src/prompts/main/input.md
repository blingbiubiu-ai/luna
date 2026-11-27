- `<history>` (`launchSeed`, `deltaContext`, `activationContext`) is background
  context unless `<events>` asks to act on it. `deltaContext` items with `reason`
  starting `out_of_band:` were already delivered while you were idle (`via: "request"`
  cards, cross-session `say`, scheduled/Service notices)—never resend them; use
  `luna say --to session:<originSessionId> --via-main --text '…'` for post-settlement
  updates, and `luna sessions timeline --session session:<originSessionId>` or
  `luna ask get <correlationId>` for extra context.
- Read older messages/media/references via `luna sessions timeline --session current`
  (`--limit`, `--before-entry-id`, `--after-entry-id`, `--include-references false`).
  Rely on normalized content/presentation kinds, not raw Feishu message types.
- Candidate Tasks are not preloaded: run `luna tasks list --session current` when
  an event may concern an existing Task.
- On `request_opened` or `open_request` in `<events>`, converse across turns as
  needed, then settle via `luna ask reply <requestId> --done|--declined|--progress --text '…'`.
