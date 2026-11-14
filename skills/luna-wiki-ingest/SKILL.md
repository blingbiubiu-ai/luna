---
name: luna-wiki-ingest
description: Use when adding archive documents, Feishu/Lark seed URLs plus direct references, changed sources, or durable conversation knowledge into the Luna LLM Wiki under `knowledge/wiki/`.
---

# Luna Wiki Ingest

Incrementally integrate source documents or durable chat outputs into `knowledge/wiki/`. Ingest is not a summary operation; it upgrades the wiki with reusable evidence.

## Gateway And Permission Contract

- Team/SSO mode reads and writes must go through the managed knowledge workspace. Treat `luna workspace knowledge read|grep|glob|write` as the service-backed equivalent of local `cat|rg|find|write` under `knowledge/`.
- MCP callers should use `luna_workspace_read|grep|glob|write|git_commit` with `workspaceId: "knowledge"`; knowledge alias tools are acceptable only as shorthand for the same workspace operations.
- Ordinary users are read-only. If the identity is not in the configured admin group, create a write request/patch proposal instead of editing protected wiki files directly.
- Admin writes must finish with an explicit `luna workspace knowledge git-commit --message ...` or MCP `luna_workspace_git_commit`; `write` only updates workspace files and does not commit.
- Direct filesystem edits under `knowledge/` are not supported; all ingest mutations go through the managed workspace service.
- High-risk legal/security/risk-reduction knowledge must include explicit ACL frontmatter such as `risk_tags`, `allowed_groups`, or `allowed_departments`; do not rely on default internal visibility.

## Core Principles

- Single source of truth: merge the same topic into an existing wiki page or source card instead of creating duplicates.
- Split before ingest: if one source or conversation contains independent topics that answer different questions, route each topic to the correct domain/entity/concept/decision page and keep a linking overview only when the whole source has standalone value.
- Preserve evidence: Feishu/external docs should become traceable archive snapshots plus source cards; do not just bookmark links or paste summaries.
- Handle conflicts explicitly: keep both claims with source trace, update `contradictions.md` when needed, and mark affected pages `needs-review` if reliability is blocked.
- LLM-first extraction: document ingest must use an LLM semantic pass over the archive/source text before any source card is marked `maturity: deep`.
- Full routing: a source-card-only pass is incomplete. After LLM source-card extraction, route evidence into the relevant `domains/`, `entities/`, `concepts/`, or `decisions/` and update back-links/coverage.

## LLM Extraction Contract

This workflow is for an **LLM Wiki**. A script may crawl, normalize, inventory, split batches, call the LLM, stage drafts, refresh state, and lint; a script must not be the final author of a deep source card or deep topic page.

Every ingested document source card must be produced or rewritten by an LLM from the full archive snapshot, or from LLM chunk digests when the archive is too large for one prompt. The final source card must be Chinese by default, unless the source title/field/API names are English. Do not leave English boilerplate source cards unless the user explicitly asks for English.

The LLM source-card pass must preserve:

- exact metrics, dates, experiment IDs, dashboards, links, field names, table names, settings, APIs, code symbols, and formulas;
- source structure and evidence map;
- tables, image/whiteboard/attachment placeholders, and what adjacent text claims they support;
- negative results, failed experiments, contradictory claims, malformed text, and missing evidence;
- gaps where images, tables, attachments, or dashboards cannot be read.

Forbidden final-state patterns:

- promoting script-generated seed/template cards to `active/deep`;
- generic sections such as `文档结构`, `表格与结构化区域`, `语义阅读索引`, `完整单元格见 archive`, `链接共 ...`, or `非文本资源占位` as the main source-card substance;
- stale labels such as `auto-seed`, `script-only`, `source-card only`, `machine-generated`, or duplicated paths such as `knowledge/knowledge/...`;
- `Routed Updates` that say the page was not edited when the source evidence has not actually been routed.

## Inputs

- One or more paths under `knowledge/archive/`.
- A changed archive detected by manifest diff.
- A Feishu/Lark seed document URL whose content and direct document references should be imported into `knowledge/archive/`.
- A durable analysis from conversation that the user asks to file back.

## Feishu Seed Import, Depth 1 Only

Use this mode when the user provides a seed Feishu/Lark document URL and asks to download/import that document plus the documents it references.

This is **not recursive crawl**. Depth is fixed at 1:

- Depth 0: the seed document.
- Depth 1: Feishu/Lark `docx`, `wiki`, or `sheet` links directly present in the seed document.
- Do **not** follow links found inside depth-1 documents.
- Do **not** expand to child pages of a wiki space unless they are explicitly linked in the seed document body.
- Do **not** filter direct document references by topic unless the user explicitly asks for filtering; the user's intent is to preserve the seed doc's immediate evidence bundle.

### Feishu Seed Import Workflow

#### Phase 1: Archive Crawl

1. Read/export the seed document to standard Markdown.
2. Save the seed document as a full source copy under `knowledge/archive/` by writing the workspace path `archive/<safe-file>.md`.
3. Extract direct Feishu/Lark document links from the exported seed Markdown:
   - `https://*.larkoffice.com/docx/...`
   - `https://*.larkoffice.com/wiki/...`
   - `https://*.larkoffice.com/sheets/...`
   - converted `mention-doc` links if the fetch tool returns Feishu tags.
4. Deduplicate links by normalized URL/token.
5. For each direct link, read/export it and save a full source copy under `knowledge/archive/` by writing `archive/<safe-file>.md`.
   - If inaccessible, log `access-denied` and continue.
   - If unsupported, log `unsupported` and continue.
   - If an archive file with the same source URL already exists, compare content and update only if changed.
6. Record the import set in `knowledge/wiki/log.md`, including seed URL, imported count, skipped count, and failed URLs.

#### Phase 2: Wiki Update

1. Run the normal wiki ingest workflow only for the seed and direct-reference archive files that were newly created or changed.
2. Create/update source cards in `knowledge/wiki/sources/` through the **LLM Extraction Contract**. Inventory-only or script-generated cards are drafts, not final wiki pages.
3. Integrate evidence into relevant `domains/`, `entities/`, `concepts/`, or `decisions/` through LLM-assisted synthesis plus manual verification. A Feishu import is not complete while its new source cards are only linked from themselves.
4. Update `index.md`, `_state/page_registry.json`, `_state/link_graph.json`, `open-questions.md` or `contradictions.md` when needed, and `knowledge/wiki/log.md`.
5. Run `refresh_wiki_state.py`, residual-template scan, mojibake scan, and wiki lint.

### Archive File Rules For Feishu Import

- Archive files are full source snapshots, not summaries.
- Preserve source trace in frontmatter:

  ```yaml
  ---
  title: "Feishu document title"
  source: "https://..."
  archived: "YYYY-MM-DD"
  import_mode: "feishu-depth-1"
  seed_source: "https://seed..."
  link_depth: 0 | 1
  ---
  ```

- The filename should use the exported document title when available; if a safe title cannot be derived, use a stable slug from the document token.
- Final archive Markdown must not contain Feishu private tags such as `<lark-table>`, `<mention-doc>`, `<quote-container>`, `<image ...>`, `<callout>`, or `<whiteboard>`.

## Workflow

1. Read the wiki contract:

   ```bash
   luna workspace knowledge read wiki/AGENTS.md
   ```

2. Refresh inventory:

   ```bash
   python3 <luna-wiki-rebuild-skill-dir>/scripts/archive_inventory.py --write
   ```

3. Identify target source records in `_state/source_manifest.json`.
4. Read each source fully with workspace reads:

   ```bash
   luna workspace knowledge read archive/<source>.md
   ```

   For large batches, split targets and use parallel subagents/batches when available; each worker must use the same LLM extraction contract and return concrete file paths and failures.
5. Create or update a source card under `knowledge/wiki/sources/` using LLM semantic extraction.
   - Build `## Source Map` from the full document.
   - Build `## Evidence Inventory` before summarizing; preserve external links/dashboards, SQL/code/tables, images/whiteboards, process analysis, negative results, and malformed source text.
   - Extract `## Evidence Notes` with exact values, formulas, APIs, events, tables, settings, and experiments.
   - Record `## Routed Updates` after updating wiki pages.
   - Record `## Gaps` for unclear or stale evidence.
6. Search existing wiki pages for the same entity, concept, domain, or decision before creating new pages:

   ```bash
   luna workspace knowledge grep "entity|concept|alias" --glob "wiki/**/*.md"
   ```

7. Integrate new knowledge into existing pages when possible. Create new pages only when the topic is genuinely durable and distinct. This routing/fusion step is required after the source-card pass.
   - If the target page is `maturity: seed`, deepen it instead of appending a shallow note.
   - If the target is a domain, update `## Source Coverage` so readers know which source supports which model, metric, implementation, or caveat.
   - Add detailed sections when the source contains implementation, metrics, experiments, or decision evidence.
   - Preserve contradictions instead of normalizing them away.
   - Entity/domain pages must link back to representative source cards; at least one domain or entity must cover every ingested source unless the source is intentionally archived as non-durable/no-op with a documented reason.
8. Update:
   - `index.md`
   - `_state/page_registry.json`
   - `_state/link_graph.json`
   - `contradictions.md` when needed
   - `open-questions.md` when gaps are discovered
   - `log.md`

   Use `luna workspace knowledge write <path> --body-file <file>` or `--body <content>` for every changed archive/wiki/state/log file.
9. Run the verification gate below.

## Fileback From Query Or Conversation

If the user asks to preserve an answer or conversation knowledge:

1. Extract only durable, reusable facts, decisions, playbooks, pitfalls, constraints, or evidence; do not store raw chat transcripts or one-off task chatter.
2. Split independent topics before writing, then route each piece to the right domain/entity/concept/decision page.
3. Include source trace to the wiki/source pages, archive files, repo files, or conversation context that supported the answer.
4. Prefer updating an existing page over creating a one-off page.
5. Append `log.md` with `query-fileback` or `conversation-fileback`.
6. Run wiki lint unless blocked, and report the blocker if skipped.

## Source Card Requirements

Each source card should include:

- raw archive path
- source URL from frontmatter if present
- concise summary
- key facts with exact values where present
- source map with section/headings and reusable evidence
- evidence inventory covering external links, dashboards, SQL/code, tables, images/whiteboards, process analysis, negative results, and ambiguous source text
- evidence notes grouped by theme
- extracted entities and candidate wiki links
- touched wiki pages
- unresolved questions

Required source-card headings for deep pages:

- `## Summary`
- `## Key Facts`
- `## Source Map`
- `## Evidence Inventory`
- `## Evidence Notes`
- `## Extracted Entities`
- `## Routed Updates`
- `## Gaps`
- `## Links`
- `## Sources`

If any required heading is missing, keep the card out of `active/deep` and rerun LLM extraction or repair it before finalizing.

## Deepening Rules

When a source touches an existing domain:

1. Read the current domain page.
2. Read all source cards already listed under its `## Sources`.
3. Merge the new evidence into the right section; do not append a generic "new info" block.
4. If the source includes API/code/config/metric details, the domain must have the matching detailed section.
5. If the source includes investigation flow, failed experiments, or negative results, preserve them under source `Evidence Inventory` and route their conclusion or caveat into the domain.
6. Keep `maturity: seed` unless the domain has enough detail to answer implementation, metric, evidence-trace, and caveat questions without archive fallback.

## Verification Gate

Before reporting ingest complete:

1. Refresh state and run wiki lint:

   ```bash
   python3 <luna-wiki-rebuild-skill-dir>/scripts/refresh_wiki_state.py
   python3 <luna-wiki-lint-skill-dir>/scripts/wiki_lint.py
   ```

   These scripts always read and write through `luna workspace knowledge ...`; direct local
   filesystem access under `knowledge/` is not supported. Resolve each `<...-skill-dir>` from the
   actual skill filesystem location; do not assume `.claude/skills/...` exists.

2. Scan maintained wiki pages, excluding `_state`, for script/template residue:

   ```bash
   rg -n -i --glob '*.md' --glob '!wiki/_state/**' \
     '批量脚本|脚本生成|模板生成|模板补齐|script-only|source-card only|source card only|old script|machine-generated|未经过llm|未经过 LLM|auto-seed|knowledge/knowledge/|文档结构|表格与结构化区域|语义阅读索引|完整单元格见 archive|非文本资源占位|链接共 [0-9]+ 个' wiki
   ```

   Review hits carefully: `TODO`, `占位`, and image placeholders may be valid source evidence when the original document contains them. The forbidden state is a maintained page whose main content is a script/template scaffold rather than LLM semantic extraction.

3. Verify source-card routing coverage for the target batch:
   - every ingested source card is linked from at least one relevant domain/entity/concept/decision page, or explicitly logged as intentionally source-only/non-durable;
   - high-risk pages have `risk_tags` and explicit ACL frontmatter;
   - broken local links are zero.

4. Record counts in `knowledge/wiki/log.md`: sources processed, failures/skips, domains/entities touched, new pages, remaining gaps, and verification results.

5. Review the exact staged workspace changes:

   ```bash
   luna workspace knowledge git-diff
   ```

6. Commit the knowledge update explicitly:

   ```bash
   luna workspace knowledge git-commit --message "docs: ingest <topic-or-source>"
   ```

7. Keep `_state` lean after successful verification. Preserve runtime indexes and audit summaries (`page_registry.json`, `link_graph.json`, `source_manifest.json`, import summaries, final target lists); remove batch chunks, LLM progress logs, failed-output scratch files, and draft synthesis directories when no longer needed.

## Hard Rules

- Do not modify `knowledge/archive/` during normal archive-to-wiki ingest. The only exception is **Feishu Seed Import, Depth 1 Only**, where writing new or changed Feishu snapshots to `knowledge/archive/` is the explicit purpose.
- Do not append raw dumps to wiki pages. Integrate into the relevant structure.
- Do not claim a document is fully ingested until it has passed LLM source-card extraction, domain/entity/concept/decision routing, state refresh, residual-template scan, and wiki lint.
- Do not use script-generated source cards as final deep cards. Scripts can stage drafts; LLM extraction must produce the maintained source-card body.
- Do not create duplicate pages. Search first, then merge or cross-link.
- If evidence is weak, mark the page `needs-review` and state why.
- Do not mark a page `active` unless it is at least `maturity: deep`.
- Always leave the wiki navigable through `index.md`.
