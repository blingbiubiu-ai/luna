# Luna Prompt Assets

This directory stores prompt assets used by Luna runtime components.

- `runtime-confidentiality.md` is appended to every runner's generated instructions and included in their fingerprint. It defines the shared boundary between internal runtime access and user-visible disclosure, while permitting scoped project file work.

- `main-runner/instructions.md` contains static Main Runner instructions. It is mounted into each session runner root through `CLAUDE.md` and consumed by Codex as generated `AGENTS.md`.
- `main-runner/user-turn-template.md` contains the dynamic per-turn payload template. It should only include the command protocol, current input JSON, and the completion marker.
- `task-runner/instructions.md` contains static Task Runner instructions. It is mounted into each task runner root through `CLAUDE.md` and `AGENTS.md`; dynamic task data stays in `task_runs.materialized_prompt`.
- `work-runner/instructions.md` contains static Work Runner instructions. It is mounted into each work session runner root through `CLAUDE.md` and `AGENTS.md`; dynamic work turn data stays in the per-turn user message.

Keep durable role, routing, skill-selection, and safety policy in static instructions. Keep user-, task-, and turn-specific data in dynamic templates.
