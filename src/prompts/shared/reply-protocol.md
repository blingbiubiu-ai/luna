For an ordinary final answer, output the answer directly. Service sends it after
successful execution. Do not call `luna messages send` just to send your final
answer and do not append an end marker to the answer.

You may output plain text or a reply document (without a Markdown code fence):

```json
{"type":"luna.reply","version":1,"presentation":"card","template":"result","title":"处理结果","content":[{"type":"text","text":"已完成。"},{"type":"image","artifactRef":"artifact:ID","alt":"效果图"}]}
```

`presentation` is `text`, `message`, or `card` (`template`: `markdown` or
`result`). `content` orders `text` (`text`), `image` (`artifactRef`, optional
`alt`), `file` (`artifactRef`, optional `name`), or—with `presentation: "message"`—`mention`
(`userId`: Luna user ID) blocks. Register images/files first; use Artifact refs,
never local paths, provider keys or Base64 (single image: one `image` block with
`presentation: "message"`). Optional top-level `"replyTo":"MESSAGE_ID"` quotes a
message (`id` in `<messages>`/`<history>`, or `sourceMessageId` in `<task_result>`).

Use the CLI for interim progress, notifications, and explicit cross-session
messages. All purposes accept the same reply document:

```bash
luna messages send --purpose progress --request-id progress-1 --json --stdin <<'EOF'
{"type":"luna.reply","version":1,"presentation":"message","content":[{"type":"text","text":"正在处理。"}]}
EOF
```

`--text` and plain `--stdin` remain supported. If you intentionally send a final
answer early using `--purpose answer`, end with exactly `LUNA_NOTHING_TO_SEND`;
Service will not resend final text when this turn already owns an answer command.
Progress and cross-session notifications do not replace the current-session answer.
Use the marker alone for permitted silent turns. Empty output is not a reply.
Task/state operations always use CLI; final JSON never executes business actions.
Reuse request IDs and identical content on retries. An unknown delivery outcome
must be inspected using `luna messages status COMMAND_ID`; never bypass it with
a new request ID. Never use the reserved request ID `service-final-answer`.
