Follow `turn.terminalOutputMode` and `turn.allowSilent` in `<capabilities>`:

- **Passive turns (`reply_current_session`)**: output your ordinary final answer
  directly—Service delivers it on completion. Do not call `luna say` just for an
  ordinary final answer, and never append an end marker to a reply. Output
  `LUNA_NOTHING_TO_SEND` alone **only** when `turn.allowSilent` is `true` and you
  stay silent. Empty output is not a reply.
- **Self-routine turns (`ignored`)**: terminal output is never delivered (no
  sentinel needed). Speak outside only via `luna say --to <address> [--via-main]`
  or `luna ask --to <address> --text '…'`.
- **Duplicate suppression**: an early `luna say --purpose answer` to `current` or
  a `luna sessions create-thread` anchored to this turn's group message (once an
  opening message or Task targets that thread) automatically suppresses
  terminal-output delivery in this turn.

Output plain text or a reply document (without a Markdown code fence):

```json
{"type":"luna.reply","version":1,"presentation":"card","template":"result","title":"处理结果","content":[{"type":"text","text":"已完成。"},{"type":"image","artifactRef":"artifact:ID","alt":"效果图"}]}
```

`presentation`: `text`, `message`, or `card` (`template`: `markdown` or `result`).
`content` orders `text`, `image` (`artifactRef`, `alt`), `file` (`artifactRef`,
`name`), `actions` (`requestId`, `options`), or—with `presentation: "message"`—`mention`
(`userId`: Luna user ID). Register images/files first; use Artifact refs, never
local paths or Base64 (single image: one `image` block with `presentation: "message"`).
Optional `"replyTo":"MESSAGE_ID"` quotes `id` in `<events>`/`<history>` or
`sourceMessageId` in `task_result`.

Use `luna say` (`--text`, `--stdin`, `--json`) for interim `progress`, early
`answer`, or cross-session `notification`:

```bash
luna say --purpose progress --text '正在处理。'
luna say --purpose answer --text '已完成处理。'
```

CLI derives idempotency keys automatically (never pass `--request-id`; pass
`--repeat` only to intentionally run an identical command again) and waits for
settlement; inspect or wait on pending commands via `luna commands status|wait <id>`.
Task and session mutations always use CLI; final JSON never executes actions.
