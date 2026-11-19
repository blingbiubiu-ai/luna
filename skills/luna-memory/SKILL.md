---
name: luna-memory
description: Write Agent long-term memory with `luna memory add/update/delete`: choose the entry type (person, chat, feedback, project, procedure, reference, persona), make a rule core or Shadow-only, set an expiry, or change who this Shadow is (persona). Use before saving, correcting or forgetting a memory.
---

# Writing Agent memory

- Save a memory when the user asks you to remember something, corrects how you
  work, or states a fact that will matter in later conversations. Search first
  and update the existing entry with
  `luna memory update <id> --expected-revision N --reason WHY` instead of adding a duplicate.
  Every update, delete and restore takes `--reason`: one line on why you
  change the entry, such as "the user moved the launch to 2026-12-05". The
  Agent owner reads it in the entry's history; Luna refuses the change without
  it (`memory_reason_required`).
  Add with `luna memory add --type TYPE --title TITLE --description DESC --stdin`.
  Luna rejects an entry that repeats an existing one (`memory_duplicate`) and
  lists the candidates: update one of them, or add `--force` only when it is a
  different fact.
- An entry answers one question and grows with what is learned about it. When
  something belongs to the question of an existing entry, update that entry,
  and change its title and description too when the answer changed. Put the
  current conclusion first in the body and rewrite it; do not leave a
  conclusion that no longer holds with a dated note under it. A procedure is a
  document to follow: change the steps themselves. When unsure whether it is
  the same question, add a new entry.
- Types. Pick the one whose question the entry answers:
  - `person` (requires `--subject <Luna user id>`): who someone is, their role
    and how they like to work.
  - `chat`: who you are and what you do in the group or direct chat this
    conversation happens in, such as "I am this group's on-call owner: when
    someone reports a problem, investigate and fix it". It is bound to the
    current chat by itself (no `--subject`), is told in full at the start of
    every conversation there, topic threads included, and nowhere else. Keep
    one entry per chat and update it as the role changes. Only the Agent owner
    or a member trusted to write memory can set it, and only from a Main
    conversation in that chat, not from Work.
    In a direct chat, what is about the person goes in their `person` entry,
    which follows them into every chat; only what this direct chat is for,
    such as "send my daily report here every morning", is a `chat` entry.
  - `feedback`: a way of working the user corrected or confirmed.
  - `project`: the state, decisions or schedule of ongoing work, such as "the
    diagnostics launch moved to 2026-12-05; VQoS ships first".
  - `procedure`: reusable steps, such as how to troubleshoot a failure.
  - `reference`: where something is found, such as "the diagnostics guide is
    at https://..." or "feedback is tracked on the 《GHome 反馈看板》". It must
    contain the link, path or document name.
  When an entry is mostly a link or location it is `reference`; when it is
  mostly a state, decision or date it is `project`. "The requirements doc is
  at X" is a reference; "the requirements doc settles launch on 2026-12-05" is
  a project. Luna refuses a reference without a location and says what is
  missing: add it, or choose the type the fact really has. One fact per entry. Entries are found by their title and description,
  so write the description as one line using the words someone would use when
  the fact matters.
- Give an entry that stops mattering on a known date `--expires YYYY-MM-DD`.
- `persona` entries are who you, this Shadow, are: name, voice and standing
  principles. Other Shadows never see them. Only the Agent owner decides them:
  when the owner tells you who to be or how to sound, update the matching
  persona entry or add one with
  `luna memory add --type persona --title TITLE --description DESC --stdin`,
  writing the body as the full text you should follow. Your persona entries
  appear in `<soul>` from your next turn on. Luna refuses persona
  changes asked for by anyone else. What you learn about the people you work
  with is not persona; it belongs in `person` entries.
- `--core true` puts a rule in front of every conversation from its start. Use
  it only when the Agent owner asks for a rule that must hold whatever the
  conversation is about and that the topic itself would not bring to mind, such
  as the reply language or a confirmation required before risky actions. A
  preference tied to one kind of work (how to format a report, which tool to
  use for a task) is not core, even when the user says "always" or "in every
  conversation": save it as a normal entry and it is recalled when that work
  comes up. Core entries are limited (`memory_core_full`). A role or rule that
  holds only in one group is a `chat` entry, not core.
- A rule about how you, this Shadow, should behave, as opposed to all Shadows
  of the Agent, takes `--visibility shadow`; with `--core true` it then counts
  against this Shadow's own allowance.
- When the user says an entry is wrong or should be forgotten, update it or run
  `luna memory delete <id> --expected-revision N --reason WHY`.
