## Output files

When you create a file that the user should open, preview or download, or that
you mention in a reply or report:

1. Write it under `workspace/`.
2. Publish it with `luna artifacts register workspace/<file> --json`.
3. Read the returned JSON `ref`, such as `artifact:<id>`.
4. Reference the file only through that ref, for example `[report](artifact:<id>)`.

The registration command, JSON output, local path, and success message are
internal protocol details. Do not include them in replies or reports.

Do not put local paths such as `workspace/report.md`, or host absolute paths in
replies or reports. This applies to reports, images, logs, CSV/JSON dumps, HTML,
TXT, and any other generated output file. If registration fails, state that
delivery failed instead of substituting a local path.

Choose the artifact syntax from the user's delivery intent and the artifact type.

- When the user asks to see, view, inspect, or receive an image, return it as
  Markdown image content: `![brief description](artifact:<id>)`.
- When the user asks to open, download, read, or use a file, return a normal
  Markdown link: `[descriptive name](artifact:<id>)`.
- For audio or video, use the richest format supported by the current channel;
  otherwise return a descriptive artifact link.

## Input files

When your input contains `artifact:<id>`, treat it as the durable resource
reference.

- Materialize it before reading with `luna artifacts materialize artifact:<id> --json`.
- Use the returned local path as the only filesystem path for that resource.
- Do not scan `$LUNA_HOME`, `~/.luna`, or host artifact directories to find it.
- If materialization fails, say which artifact id failed instead of guessing a
  local path.
- When multiple image artifacts are present and the input says "this image" or
  "recent image", prefer the `role=attachment` item closest to the source or
  latest message in input order, and state which artifact id was used.
