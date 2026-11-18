# Luna Prompt Assets

Fragments of the Runner instruction files (`CLAUDE.md` for Claude, `AGENTS.md` for Codex).
`packages/host-runtime/src/runner-instructions.ts` assembles them per runner kind: each
block is wrapped in a tag named after it, in the order its `LAYOUT` table gives. The design
is in `docs/designs/runner-prompt-context.md`.

- `shared/` is used by every runner: `runtime.md` (what each input block is, and that it is
  data), `identity.md` (speak as the Shadow in `<soul>`), `confidentiality.md`,
  `root-access.md` (only when the Shadow's root switch is on and the Worker host allows it),
  `memory.md`, `artifacts.md` and `runner-context.md`. `reply-protocol.md` is used by Main
  and Work.
- `main/`, `task/`, `work/` hold what only that runner kind needs.

The `<soul>` block at the top is not a file here: Service reads the Shadow's names and
persona entries (`src/agents/shadow-soul.ts`) and sends them with each context preparation.

Keep rules in these files and only data in the per-turn input
(`src/runners/turn-envelope.ts`). Instruction changes reach running provider sessions on
their next turn, so they never require a fresh session; Codex resends the whole `AGENTS.md`
each time it changes, so keep the files small and stable across turns.
