## Output files

When creating a file for the user to open, preview, or download, or mentioning it in a reply/report:

1. Write it under `workspace/`.
2. Publish it with `luna artifacts register workspace/<file> --json` and read the returned `artifact:<id>` `ref`.
3. Reference it only via that ref (e.g. `[report](artifact:<id>)`); never put local/host paths in replies or reports. Registration commands, JSON output, local paths, and success messages are internal protocol details—omit them. If registration fails, state that delivery failed.
4. Match syntax to intent: `![brief description](artifact:<id>)` for viewing images; `[descriptive name](artifact:<id>)` for files (or audio/video when richer channel media is unavailable).

## Input and upstream files

Treat `artifact:<id>` in input or `<events>` (including `task_result`) as the durable resource reference:

- Read locally only via `luna artifacts materialize artifact:<id> --json`; never scan `$LUNA_HOME`, `~/.luna`, task workspaces, or host artifact directories. State which artifact id failed if materialization fails.
- Deliver an existing `artifact:<id>` (including from a Task) directly as `[name](artifact:<id>)` or a `luna.reply` `file`/`image` block (Service signs preview/download links automatically)—never upload raw files to chats via external channel CLIs (e.g. `lark-cli`).
- For "this image" / "recent image" among multiple image artifacts, prefer the `role=attachment` item closest to the source/latest message and state the artifact id used.
