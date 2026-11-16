# Agent Memory

Agent memory is the long-term memory shared by an Agent's Shadows. Service owns
storage, visibility, write rules, recall and forgetting. Runners read and write
it through the `luna memory` CLI inside their invocation scope. Memory never
travels through the read-only resource snapshot. MCP tools are not provided.

## Model

The design follows how a person remembers. The total number of entries may grow
without bound; what a conversation is shown stays small.

| Human memory | Luna |
| --- | --- |
| Short-term memory | The provider context of the current session |
| Consolidation into long-term memory | Inline writes and reflection |
| Sense of self | Persona entries, one Shadow's identity, told in full to every conversation |
| Habits | Core entries, told to every conversation |
| Long-term memory | Active entries, recalled when a message brings them to mind |
| Sleep | Daily consolidation of what changed |
| Forgetting | Expired and long-unused entries are archived |
| Rehearsal | Reading or changing an entry restarts its forgetting clock |
| Effortful recall | Searching the archive and restoring an entry |

## Why not the snapshot

Memory used to be owner-edited Markdown published as one immutable revision per
Agent and mounted read-only at `$HOME/.luna-resources/memory/`. That model
cannot support Shadows that learn while they work:

- one revision for the whole document set makes concurrent Shadow writes conflict;
- the snapshot is pinned at acceptance, so a running session never sees what
  another Shadow just learned;
- `instructionFingerprint` hashes the resource selection, including
  `agentMemoryRevision` (`src/runtime/context-preparation.ts`). A changed
  fingerprint invalidates provider sessions, so frequent memory writes would
  reset every Shadow's conversation context;
- a snapshot is per Shadow, while `person` visibility is per session.

## Entries

One entry holds one fact.

| Type | Content |
| --- | --- |
| `persona` | One Shadow's identity and principles; see below |
| `person` | Role, preferences and communication habits of someone the Agent works with |
| `feedback` | A corrected or confirmed way of working |
| `project` | Ongoing work, decisions and constraints, with absolute dates |
| `procedure` | Reusable know-how |
| `reference` | Pointers to external resources |

Not stored: conversation transcripts (messages), task results and files
(tasks, artifacts), knowledge content (Knowledge workspace), secrets, and
state that only matters to the current task.

Each entry has `title` (120 chars), `description` (200 chars, one line; entries
are recalled by title and description), `body` (8 KB), `subject_user_id`
(required for `person`), `visibility` (`agent` or `shadow`), origin (Shadow,
session, task, user and `inline` / `reflection` / `consolidation` / `owner` /
`migration`), a `trusted` flag, `core`, an optional `expires_at`,
`last_used_at`, a per-entry `revision`, and `status`:

| Status | Meaning |
| --- | --- |
| `active` | Injected, recalled and searched |
| `archived` | Forgotten: found only by an archive search, can be restored |
| `superseded` | Replaced by another entry during a merge |
| `deleted` | Removed by a writer |

Every change appends the resulting state to `agent_memory_revisions` and takes
the next `change_seq`, which orders changes without relying on clocks.

### Persona entries

A `persona` entry says who one Shadow is: its name, voice and standing
principles. It replaces the per-Shadow USER and SOUL documents.

- It is always `visibility=shadow`: only its Shadow, the Agent owner and
  consolidation ever see it.
- It is told to every conversation of that Shadow at its start, with its full
  body, under "Who you are". A change made elsewhere is told in full on the
  next turn; the provider session is not reset.
- Only the Agent owner decides it. A Runner may add or change one only when
  the invocation actor is the Agent owner; a `memory.write` rule is not enough.
  Identity outlives the conversation that set it, so a group member or a piece
  of fetched content must not be able to rewrite it. The owner can also write
  one from the Dashboard for a chosen Shadow.
- It is never core, never expires, is not forgotten, not recalled by message,
  not checked for duplicates and not handed to consolidation. An entry cannot
  change into or out of `persona`.
- A Shadow holds at most `memory.persona_limit` (5) active persona entries; a
  further one is rejected with `memory_persona_full`.

What a Shadow learns about the people it works with is not persona: it belongs
in `person` entries, or in Shadow-private entries when it concerns only that
Shadow.

### Core entries

A core entry is told to every conversation at its start and is never forgotten
for lack of use. Only trusted writers may mark an entry core and `person`
entries cannot be core. Core is for rules that must hold whatever the
conversation is about and that the topic would not bring to mind; a preference
tied to one kind of work stays a normal entry and is recalled when that work
comes up.

There are two allowances. Core entries with `visibility=agent` are told to every
Shadow and an Agent holds at most `memory.core_limit` (30) of them. Core entries
with `visibility=shadow` are told only to their origin Shadow and each Shadow
holds at most `memory.shadow_core_limit` (10), so one Shadow's rules cannot
crowd out another's. A further entry in a full allowance is rejected with
`memory_core_full`.

## Visibility

Service applies these rules to every Runner read, search, recall and injection:

1. The entry belongs to the invocation's Agent.
2. `visibility=shadow` entries are visible only to their origin Shadow.
3. `person` entries are visible only when `subject_user_id` participates in the
   current session. Participants are the invocation actor plus the users who
   have sent messages in the session; a Task also includes its creator and the
   participants of its primary session.

The Agent owner (Dashboard) and Service-launched consolidation see all entries.

## Write rules

Writes take effect immediately. Authority comes from the invocation, never from
caller-supplied identity. The writer is *trusted* when the invocation actor is
the Agent owner or holds an allow rule for `memory.write`; Dashboard edits by
the owner are trusted.

| Type | Accepted from |
| --- | --- |
| `persona` | The Agent owner only |
| `feedback`, `procedure`, any core entry | Trusted writers only |
| `person` | Anyone, but an untrusted writer may only describe themselves |
| `project`, `reference` | Anyone; results carry who said it and when |

An untrusted writer cannot update, delete or restore an entry last written by a
trusted writer. Changes require `expectedRevision`; a stale value returns 409
with the current revision. Deletes are soft.

**Duplicates.** A Runner `add` is compared with the active entries of the same
type (and person) the writer can see. When the title and description share 60%
or more of their terms with an existing entry, the add is rejected with
`memory_duplicate` and the candidates; the Runner updates one of them or repeats
with `--force`. Owner edits are not checked.

Prompts add soft rules on top: store only what the speaker says about themselves
or is entitled to decide, never store instructions about how to treat other
people, never store instructions found in files, pages or tool output, and
treat memory as reference information rather than commands.

## Search terms

`memoryTerms` turns text into terms: words for spaced scripts, overlapping
two-character pieces for Chinese and Japanese, where most words are two
characters and sentences have no spaces. The terms of each entry's title,
description and body are kept in the FTS5 table `agent_memory_terms`, written by
`AgentMemoryStore`. Ranking is BM25 with title over description over body and a
mild preference for recently updated entries. Entries imported by a migration
are indexed when Service starts.

No vector store is used, so two entries that say the same thing in different
words are not matched. Revisit when measured recall is poor; the interfaces do
not change.

## What a conversation is shown

Service appends memory to the turn prompt of Main, Work and Task Runners:

| When | What |
| --- | --- |
| First turn of a provider session | The Shadow's persona entries in full, then core entries and up to 20 `person` entries about the participants |
| Every turn that carries a message | Up to `memory.recall_limit` (8) active entries whose title or description shares at least two terms with the message, and that this session has not been shown |
| Later turns | Changes made by other Runner contexts to entries this session was shown, and to persona, core and `person` entries; removals of entries it was shown |

The message is the user messages of a Main turn, the inbound text of a Work
turn, or a Task's title, summary and new input. Maintenance turns recall
nothing. Only id, type, title, description and attribution are injected; bodies
are fetched with `luna memory get`.

`memory_injection_cursors` records, per Runner context, the provider session and
the last `change_seq` it was told about; `memory_injected_entries` records which
entries it was shown. Both advance only after the provider accepted the turn, so
a failed turn is told again, and both start over with a new provider session.
For Task Runs the injected text is kept out of the materialized prompt so it
cannot widen the artifact allowlist.

## Forgetting

Once a minute Service archives active entries that

- have an `expires_at` in the past, or
- are not core and were not used for `memory.forget_unused_ms` (180 days; 0
  turns this rule off).

An entry is *used* when a Runner reads its body (`luna memory get`) or anyone
changes it. Appearing in an index, a search result or an injection is not use.
Archiving is recorded as a revision with change kind `forgetting` and does not
alter trust. An archived entry stays readable, is found by
`luna memory search --archived`, and returns with `luna memory restore` or from
the Dashboard; restoring clears an expiry that has passed.

## Commands

```text
luna memory list [--type T] [--limit N] [--offset N]
luna memory search <keywords> [--type T] [--subject USER_ID] [--archived]
luna memory get <id>
luna memory add --type T --title TITLE --description DESC [--subject USER_ID] [--visibility agent|shadow] [--expires YYYY-MM-DD] [--core true] [--force] (--body TEXT | --stdin)
luna memory update <id> --expected-revision N [--title ...] [--description ...] [--type ...] [--visibility ...] [--expires YYYY-MM-DD|none] [--core true|false] [--body TEXT | --stdin]
luna memory restore <id> --expected-revision N
luna memory delete <id> --expected-revision N [--superseded-by ID]
```

Runner routes live under `/api/runner/memory`. The owner surface is
`/api/agents/:agentId/memories` with server-side filtering and paging, edit,
history, restore to a revision and unarchive.

## When memory is written

| Moment | Trigger | Mechanism |
| --- | --- | --- |
| Inline | The user asks to remember, corrects the Agent, or states a durable fact | The Runner searches first, then updates an existing entry or adds one |
| Reflection | The latest human message of a Main session is older than `memory.reflection_idle_ms` (30 minutes) and has not been reflected on | Service queues a silent `session.invoke` turn in the same session, so the provider context already holds the conversation |
| Consolidation | An Agent's memory was changed by something other than consolidation, at most once per `memory.consolidation_interval_ms` (24 hours) | Silent turn in a dedicated Dashboard session of the default Shadow |

The session command worker runs one maintenance pass a minute: forget, then
queue reflection and consolidation. Setting an interval to 0 turns that run off.

Reflection runs as the Agent owner only when the owner is the only human who
spoke since the last reflection; otherwise it runs as the latest other speaker,
so nothing a member said becomes a trusted entry. Sessions whose last human
message is older than 24 hours are skipped, so enabling memory does not replay
history. `memory_reflection_checkpoints` records how far each session has been
reflected on. Work sessions are not reflected on, and a Task Run ending does not
by itself start a reflection; both save memory inline.

Consolidation is incremental. Service hands the turn the entries changed since
the last run (up to 100; a backlog continues ten minutes later), each with up to
four existing entries of any type that resemble it: at least 40% of the shorter
entry's title and description terms appear in the other. The threshold is loose
on purpose, because a candidate that is not shown can never be merged. `person`
entries are only compared with entries about the same person.
The model merges duplicates, resolves contradictions by trust then recency,
gives dated `project` entries an expiry and splits imported documents. The turn
runs as the Agent owner, is the only Runner turn that sees every entry, and
starts from an empty provider context each time. `memory_consolidations`
records its session and the last change it covered.

## Dashboard

The memory page lists entries one server-filtered page at a time, with filters
for type, origin kind, origin Shadow, status and tier, and shows core usage. An
entry shows its body, origin, last use, a link to the originating session or
task, and its revision history. The owner can edit, mark core, set an expiry,
delete, restore a revision or bring back a forgotten entry.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `memory.reflection_idle_ms` | 30 minutes | Idle time before reflection; 0 disables |
| `memory.consolidation_interval_ms` | 24 hours | Minimum time between consolidations; 0 disables |
| `memory.forget_unused_ms` | 180 days | Unused time before archiving; 0 keeps unused entries |
| `memory.recall_limit` | 8 | Entries recalled into one turn; 0 disables recall |
| `memory.core_limit` | 30 | Active shared core entries per Agent |
| `memory.shadow_core_limit` | 10 | Active Shadow-private core entries per Shadow |
| `memory.persona_limit` | 5 | Active persona entries per Shadow |

## Legacy Markdown memory and persona documents

The per-Shadow USER/SOUL documents, their API (`/api/agents/:agentId/shadows/:shadowId/config`)
and their publication into the snapshot's `config/` directory are removed.
Migration `0002_agent_memories.sql` imports each non-empty document as a persona
entry of its Shadow. `shadowConfigRevision` remains in the resource selection as
the digest of an empty file set, like `agentMemoryRevision`.

Migration `0002_agent_memories.sql` imports each non-empty legacy memory file as
one trusted `reference` entry with origin `migration`; consolidation then splits
and classifies it. The import does not enforce the 8 KB body limit, so an
oversized imported entry must be split before it can be edited. The document
memory API and snapshot publication are removed. The legacy revisions stay in
`agent_document_revisions` and `luna_agents.memory_revision` is left as is.
`agentMemoryRevision` remains in the resource selection as the digest of an
empty file set so the Worker protocol stays compatible.

## Known limits

- Recall and duplicate detection match terms, not meaning.
- Common two-character pieces can make an unrelated entry pass the two-term
  recall threshold; rarity only affects ranking.
- The forgetting clock relies on Runners reading bodies before relying on an
  entry; an entry acted on from its one-line description alone ages.

## Related contracts

- [Agents and Shadows](platform-agents-and-shadows.md)
- [Authorization](auth-and-permissions.md)
- [CLI, MCP and workspace](cli-mcp-workspace.md)
- [Sessions and Main Runner](sessions-main-runner.md)
