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
- a snapshot is per Shadow, while `person` visibility is per session.

## Entries

One entry holds one fact.

| Type | Content |
| --- | --- |
| `persona` | One Shadow's identity and principles; see below |
| `person` | Role, preferences and communication habits of someone the Agent works with |
| `chat` | Who the Shadow is and what it does in one group or direct chat, such as being its on-call owner |
| `feedback` | A corrected or confirmed way of working |
| `project` | Ongoing work, decisions and constraints |
| `procedure` | Reusable know-how |
| `reference` | Pointers to external resources |
| `episode` | Something that happened: when, with whom, what was done and how it ended; see below |

Not stored: conversation transcripts (messages), task results and files
(tasks, artifacts), knowledge content (Knowledge workspace), secrets, and
state that only matters to the current task.

Each entry has `title` (120 chars), `description` (200 chars, one line; entries
are recalled by title and description), `body` (8 KB), `subject_id`
(required for `person`, where it is a Luna user id, and for `chat`, where it is
the provider chat id; empty for other types), `visibility` (`agent` or `shadow`), origin (Shadow,
session, task, user and `inline` / `reflection` / `consolidation` / `owner` /
`migration`), a `trusted` flag, `core`, an optional `expires_at`,
`last_used_at`, a per-entry `revision`, and `status`:

| Status | Meaning |
| --- | --- |
| `active` | Injected, recalled and searched |
| `archived` | Forgotten: found only by an archive search, can be restored |
| `deleted` | Removed by a writer; `superseded_by` names the entry that replaced it when a merge retired it |

Every change appends the resulting state to `agent_memory_revisions` and takes
the next `change_seq`, which orders changes without relying on clocks. The
snapshot keeps the writer's one-line `reason` for the change (at most 200
characters). A Runner must give one to update, delete or restore
(`memory_reason_required`); adding needs none. The owner may give one on the
Dashboard; a revert without one records which revision it went back to, and
forgetting records whether the entry expired, went unused or aged out.

### Persona entries

A `persona` entry says who one Shadow is: its name, role and
responsibilities, voice, and standing principles such as what it may do on its
own and what needs the owner's approval first. It replaces the per-Shadow USER
and SOUL documents.

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

### Episodes

Facts say what is true; episodes say what happened. An `episode` entry is
episodic memory: it carries `occurred_at` and `participants` and forms the
Agent's timeline across all its Shadows, which is what answers "what have you
been doing lately".

- Episodes are written by reflection, by the model that took part in the
  conversation, never from a template. Each reflection covers the stretch of
  the conversation since the previous one and writes one episode as a story:
  who asked for what, what was done, including the Tasks started and what they
  did, and how it ended. A handled Task result makes the session due for
  reflection like a human message does, with the Task's creator as the asker.
- One event is one episode. Each reflection is shown the conversation's latest
  episode; when the new stretch is how that event turned out, such as a Task it
  started that has since finished, the reflection extends that episode instead
  of adding one. An episode extended by a reflection is dated to the time of the
  extension and gains the conversation's participants; its body keeps when it
  began. Only the prompt keeps the reflection from adding a second episode.
- `participants` come from the invocation, never from the request: its actor
  and everyone who spoke in its session; for a Task also its creator.
- The Agent owner sees every episode. Anyone else sees only episodes they took
  part in, whoever wrote them and whether or not the writer was trusted. This
  replaces the untrusted-author rule for episodes.
- Episodes are read with `luna memory timeline` and found by search. They are
  never core, never recalled by a message, not checked for duplicates, not
  handed to consolidation, and left out of `luna memory list` unless asked for
  by type. An entry cannot change into or out of `episode`.
- An episode that happened, and was last read, more than
  `memory.episode_retention_ms` (90 days) ago is archived. It stays on
  `luna memory timeline --archived` and can be restored.

### Core entries

A core entry is told to every conversation at its start and is never forgotten
for lack of use. Only trusted writers may mark an entry core and `person` and
`chat` entries cannot be core. Core is for rules that must hold whatever the
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
3. `person` entries are visible only when `subject_id` participates in the
   current session. Participants are the invocation actor plus the users who
   have sent messages in the session; a Task also includes its creator and the
   participants of its primary session.
4. `chat` entries are always Shadow-private and visible only in Main sessions
   whose `group_id` is their `subject_id`: the chat's main conversation and
   every topic thread in it. Work and Dashboard sessions see none, so a role
   set for one group never steers work elsewhere.
5. Untrusted entries are visible only when their author (`origin_user_id`)
   participates in the current session. What an untrusted writer said can
   help that writer's own conversations but never reaches, and so never
   steers, anyone else's. It becomes an ordinary shared entry only when a
   trusted writer vouches for it (see Trust below).

The Agent owner (Dashboard) and Service-launched consolidation see all entries.

## Write rules

Writes take effect immediately. Authority comes from the invocation, never from
caller-supplied identity. The writer is *trusted* when the invocation actor is
the Agent owner or holds an allow rule for `memory.write`; Dashboard edits by
the owner are trusted. Only explicit rules matter: without any rule an actor
reads memory and writes untrusted entries; a deny rule for `memory.read` or
`memory.write` takes that away.

| Type | Accepted from |
| --- | --- |
| `persona` | The Agent owner only |
| `feedback`, `procedure`, any core entry | Trusted writers only |
| `chat` | Trusted writers only, from a Main session in that chat; the chat is taken from the session, never from the request, and an entry never moves to another chat |
| `person` | Anyone, but an untrusted writer may only describe themselves |
| `project`, `reference` | Anyone; results carry who said it and when |

**Trust.** An entry is trusted when a trusted writer wrote it or later vouched
for it: by rewriting what it says (type, title, description, body or subject),
by making it a core rule, or by confirming it as it stands (the owner's
"confirm" on the Dashboard). Maintenance never vouches: consolidation, whatever
it changes, a restore from the archive, and an expiry-only edit leave trust as
it was. Otherwise a routine pass would hand one member's claim to every
conversation. Trust is never lost, since untrusted writers cannot touch trusted
entries. To share what colleagues contribute without reviewing each entry,
grant them `memory.write`.

An untrusted writer can update, delete or restore only entries they wrote
themselves, never a trusted entry or another member's. Changes require
`expectedRevision`; a stale value returns 409 with the current revision.
Deletes are soft and an entry cannot supersede itself. A forgotten entry is
restored before it is edited (`memory_not_active`).

**Duplicates.** A Runner `add` is compared with the active entries of the same
type (and person or chat) the writer can see. When the title and description share 60%
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
mild preference for recently updated entries. A query uses up to 256 distinct
terms, enough for a long Chinese message. Deleted entries have
no terms. Entries imported by a migration are indexed when Service starts.

No vector store is used, so two entries that say the same thing in different
words are not matched. Revisit when measured recall is poor; the interfaces do
not change.

## What a conversation is shown

Service appends memory to the turn prompt of Main, Work and Task Runners:

| When | What |
| --- | --- |
| First turn of a provider session | The Shadow's persona entries in full, then core entries, the `chat` entries of this chat and up to 20 `person` entries about the participants |
| Every turn that carries a message | Up to `memory.recall_limit` (8) active entries whose title or description shares at least two terms with the message, and that this session has not been shown |
| Later turns | Changes made by other Runner contexts to entries this session was shown, and to persona, core, `chat` and `person` entries; `person` entries about people who joined since; removals of entries it was shown, including ones no longer visible to it |

The message is the user messages of a Main turn, the messages of a Work turn,
or a Task Run's new input (its title and summary when there is none).
Maintenance turns recall nothing. Only id, type, title, description and
attribution are injected; bodies are fetched with `luna memory get`. Work
computes the injection after preparing the Runner directory, so a provider
session that starts afresh is told standing memory again.

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

An entry is *used* when a Runner reads its body (`luna memory get`), when a
message recalls it into a turn the provider accepted, or when anyone changes
it. Standing injection, an index and a search result are not use.
Archiving is recorded as a revision with change kind `forgetting` and does not
alter trust. An archived entry stays readable, is found by
`luna memory search --archived`, and returns with `luna memory restore` or from
the Dashboard; restoring clears an expiry that has passed.

## Commands

```text
luna memory list [--type T] [--limit N]
luna memory search <keywords> [--type T] [--subject USER_ID] [--archived]
luna memory timeline [--since 7d|YYYY-MM-DD] [--until YYYY-MM-DD] [--shadow SHADOW_ID] [--with USER_ID] [--limit N] [--archived]
luna memory get <id>
luna memory add --type T --title TITLE --description DESC [--subject USER_ID] [--visibility agent|shadow] [--expires YYYY-MM-DD] [--core true] [--force] (--body TEXT | --stdin)
luna memory update <id> --expected-revision N --reason WHY [--title ...] [--description ...] [--type ...] [--subject USER_ID|none] [--visibility ...] [--expires YYYY-MM-DD|none] [--core true|false] [--body TEXT | --stdin]
luna memory restore <id> --expected-revision N --reason WHY
luna memory delete <id> --expected-revision N --reason WHY [--superseded-by ID]
```

Runner routes live under `/api/runner/memory`. The owner surface is
`/api/agents/:agentId/memories` with server-side filtering and paging, edit,
history, confirm, revert to a revision and restore from the archive. "Restore"
always means bringing a forgotten entry back; going back to an earlier revision
is "revert".

## When memory is written

| Moment | Trigger | Mechanism |
| --- | --- | --- |
| Inline | The user asks to remember, corrects the Agent, or states a durable fact | The Runner searches first, then updates an existing entry or adds one |
| Reflection | The latest reflectable human message of a Main or Work session is older than `memory.reflection_idle_ms` (30 minutes) and has not been reflected on | Service queues a silent `session.invoke` turn in the same session, so the provider context already holds the conversation |
| Consolidation | An Agent's memory was changed by something other than consolidation, at most once per `memory.consolidation_interval_ms` (24 hours) | Silent turn in a dedicated Dashboard session of the default Shadow |

The session command worker runs one maintenance pass a minute: forget, then
evaluate registered `SelfRoutine` definitions (`reflection`, `consolidation`,
per-Shadow `heartbeat`, and correlated-request `request_expiry`; see
[Agent Proactivity](agent-proactivity.md)). Setting an interval to 0 turns that
run off. Heartbeat turns read memory through the `shadowSelf` viewer, which
includes the Agent's shared trusted memory plus that Shadow's own trusted
`chat` and `person` entries, without exposing another Shadow's private memory.

A human message is *reflectable* only when a completed Main Runner turn took it
in: as its trigger or coalesced input, as turn context or launch context
(`session_turn_entries`), or as context of a Service-queued turn
(`context_pack_items` of a pack created for that turn). Group chatter nobody
addressed to the bot, history backfill and the context of memory maintenance
turns never start a reflection. A session with pending inbound messages, a
running turn or a pending Service-queued turn waits for the next pass.

Reflection runs as the Agent owner only when the owner is the only human whose
reflectable messages arrived since the last reflection; otherwise it runs as
the latest other such speaker, so nothing a member said becomes a trusted
entry. Sessions whose last reflectable message is older than 24 hours are
skipped, so enabling memory does not replay history.
`memory_reflection_checkpoints` records how far each session has been
reflected on; it advances when the turn is queued, so reflection is best
effort. A Work session is reflected on the same way, but by its own Runner: its
conversation lives in the Work Runner's provider context, so Service routes the
turn to a silent Work maintenance turn that sends no status card and needs no
answer. A session with no provider context, or one whose context was just
reset, is skipped. A Task Run ending makes the session that started it due
for reflection once its result has been handled there.

Consolidation is incremental. Service hands the turn the entries changed since
the last run (up to 100; a backlog continues ten minutes later), each with up to
four existing entries of any type that resemble it: at least 40% of the shorter
entry's title and description terms appear in the other. The threshold is loose
on purpose, because a candidate that is not shown can never be merged. `person`
and `chat` entries are only compared with entries about the same person or chat. Memory text in
the instruction is made inert so it never forms an `artifact:` reference.
The model merges duplicates of equal trust (it never folds an untrusted entry
into a trusted one or rewrites an untrusted entry), resolves contradictions by
trust then recency,
gives dated `project` entries an expiry and splits imported documents. The turn
runs as the Agent owner, is the only Runner turn that sees every entry, and
starts from an empty provider context, cleared when the run starts.
`memory_consolidations` records its session, the latest run's command and the
range of changes it covered. Only one run of an Agent is outstanding at a time,
and a run that did not complete is handed the same changes again.

## Dashboard

The memory page lists entries one server-filtered page at a time, with filters
for type, origin kind, origin Shadow, status and tier, and shows core usage. An
entry shows its body, origin, last use, a link to the originating session or
task, and its revision history, where each version says what it changed
against the one before (fields, type, status, core, expiry, trust) and the
writer's reason. The owner can edit, mark core, set an expiry,
delete, revert to a revision or restore a forgotten entry. A "waiting for
confirmation" filter lists untrusted entries; confirming one shares it.

## Configuration

Platform administrators manage memory maintenance intervals and quotas live on Dashboard `/platform/settings` (`platform_settings.settings.memory`):

| Key | Default | Meaning |
| --- | --- | --- |
| `memory.reflectionIdleMs` | 30 minutes | Idle time before reflection; 0 disables |
| `memory.consolidationIntervalMs` | 24 hours | Minimum time between consolidations; 0 disables |
| `memory.forgetUnusedMs` | 180 days | Unused time before archiving; 0 keeps unused entries |
| `memory.episodeRetentionMs` | 90 days | Age, since it happened and was last read, at which an episode is archived; 0 keeps episodes |
| `memory.recallLimit` | 8 | Entries recalled into one turn; 0 disables recall |
| `memory.coreLimit` | 30 | Active shared core entries per Agent |
| `memory.shadowCoreLimit` | 10 | Active Shadow-private core entries per Shadow |
| `memory.personaLimit` | 5 | Active persona entries per Shadow |

## Legacy Markdown memory and persona documents

The per-Shadow USER/SOUL documents, the document memory API and their
publication into resource snapshots are removed. Databases that held them are
no longer upgraded: the schema is a single baseline, and
`luna service admin import-config` copies only configuration (Agents, Shadows,
bots, models, plugins) into a new database, not memory. Resource selections
have no `agentMemoryRevision` or `shadowConfigRevision`, and snapshots no
longer have `agent/memory/` or `shadow/config/` parts, so Service, Worker and
the Executor (shipped with the Worker) must be upgraded together.

## Known limits

- A Task whose result is not handled in any session (no primary session)
  leaves no episode.
- Participants leave out system users, such as a Shadow's own reply identity.
- A Work session whose provider context was reset (changed instructions or
  model) before its reflection ran is skipped, so that stretch of work leaves
  no episode.
- Old episodes are archived one by one; they are not condensed into digests. A
  digest would be visible to everyone who took part in any of its episodes and
  so leak the others.
- Recall and duplicate detection match terms, not meaning.
- Common two-character pieces can make an unrelated entry pass the two-term
  recall threshold; rarity only affects ranking.
- In a session where anyone but the owner spoke, reflection writes untrusted
  entries only, so it cannot save `feedback` or `procedure` there. What the
  owner says in such a session is saved inline, in the turn the owner triggers.
- Trust follows the actor of a turn, not the author of each sentence in its
  context. Only prompt rules keep a Runner from saving someone else's words in
  an owner-triggered turn.
- Untrusted entries wait for the owner: nothing notifies the owner that entries
  are waiting for confirmation.

## Related contracts

- [Agents and Shadows](platform-agents-and-shadows.md)
- [Authorization](auth-and-permissions.md)
- [CLI, MCP and workspace](cli-mcp-workspace.md)
- [Sessions and Main Runner](sessions-main-runner.md)
