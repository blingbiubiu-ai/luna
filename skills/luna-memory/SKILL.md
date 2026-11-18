---
name: luna-memory
description: Write Agent long-term memory with `luna memory add/update/delete`: choose the entry type (person, feedback, project, procedure, reference, persona), make a rule core or Shadow-only, set an expiry, or change who this Shadow is (persona). Use before saving, correcting or forgetting a memory.
---

# Writing Agent memory

- Save a memory when the user asks you to remember something, corrects how you
  work, or states a fact that will matter in later conversations. Search first
  and update the existing entry with
  `luna memory update <id> --expected-revision N` instead of adding a duplicate.
  Add with `luna memory add --type TYPE --title TITLE --description DESC --stdin`.
  Luna rejects an entry that repeats an existing one (`memory_duplicate`) and
  lists the candidates: update one of them, or add `--force` only when it is a
  different fact.
- Types: `person` (requires `--subject <Luna user id>`), `feedback`, `project`
  (write absolute dates), `procedure`, `reference`. One fact per entry. Entries
  are found by their title and description, so write the description as one
  line using the words someone would use when the fact matters.
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
  comes up. Core entries are limited (`memory_core_full`).
- A rule about how you, this Shadow, should behave, as opposed to all Shadows
  of the Agent, takes `--visibility shadow`; with `--core true` it then counts
  against this Shadow's own allowance.
- When the user says an entry is wrong or should be forgotten, update it or run
  `luna memory delete <id> --expected-revision N`.
