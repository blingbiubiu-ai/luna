---
name: luna-wiki-rebuild
description: Rebuild the new LLM Wiki under `knowledge/wiki/` from immutable raw sources in `knowledge/archive/`. Use this whenever the user asks to rebuild, bootstrap, regenerate, pilot, or refresh the personal knowledge wiki from archive documents. This is the Luna knowledge rebuild path.
---

# Luna Wiki Rebuild

Build or refresh the persistent LLM Wiki layer in `knowledge/wiki/` from raw archive documents in `knowledge/archive/`.

## Goal

Create a maintained wiki, not a summary dump and not RAG chunks. The output should be durable pages with source trace, cross-links, contradictions, and an updated index/log.

Depth is part of correctness. A page that only summarizes a source is a `seed`, not a complete rebuild result.

## Gateway And Permission Contract

- Team/SSO mode reads and writes must go through the managed knowledge workspace. Treat `luna workspace knowledge read|grep|glob|write` as the service-backed equivalent of local `cat|rg|find|write` under `knowledge/`.
- MCP callers should use `luna_workspace_read|grep|glob|write|git_commit` with `workspaceId: "knowledge"`; knowledge alias tools are acceptable only as shorthand for the same workspace operations.
- Ordinary users are read-only. For non-admin identities, produce a rebuild plan or patch proposal rather than mutating protected wiki pages.
- Admin writes must finish with an explicit `luna workspace knowledge git-commit --message ...` or MCP `luna_workspace_git_commit`; direct filesystem edits under `knowledge/` are not supported.
- High-risk legal/security/risk-reduction pages must carry explicit ACL metadata (`risk_tags`, `allowed_groups`, `allowed_departments`) before being published as queryable knowledge.

## Roots

| Root | Meaning |
| --- | --- |
| `knowledge/archive/` | Immutable raw markdown sources. Read only. |
| `knowledge/wiki/` | Generated and maintained wiki layer. |
| `knowledge/wiki/AGENTS.md` | Schema and operation contract. Read this before rebuilding. |
| `knowledge/wiki/_state/source_manifest.json` | Archive inventory and source processing state. |

## Modes

### Bootstrap

Use when `knowledge/wiki/` is missing or empty.

1. Create the core files and directories from the schema.
2. Run archive inventory.
3. Run lint to prove the scaffold is valid.
4. Append `log.md`.

### Pilot Rebuild

Use before any full rebuild. Select 15-30 representative sources across core topics, then build enough pages to validate quality.

### Luna Topic Boundaries

- `domains/playback-performance.md` is the independent topic for 首帧、起播、可感知起播、切集起播、卡顿、HLS/m3u8/ts、播放性能成本、实验权衡 and performance-vs-risk tradeoffs.
- `domains/playback-controls.md` is the broad 播控/播放控制能力 topic for controls and user-facing playback capabilities such as 倍速、进度条、选集、清晰度、字幕、收藏、反馈、小窗、下载、投屏 and rights packaging.
- Do not merge playback performance into playback controls. If a source contains both, route performance evidence to `playback-performance.md` and control/UI evidence to `playback-controls.md`; keep PiP/download/screencast in their independent domains when they are the main subject.

### Full Rebuild

Use only after pilot quality is accepted. Process archive in batches. Keep progress visible.

When the user has explicitly asked to continue automatically until the rebuild is done, a successful batch is not a stop point. After `refresh_wiki_state.py`, mojibake scan, and wiki lint all pass, immediately select and start the next coherent batch in the same turn. Stop only for a real stop condition: lint failure that is not deterministic to fix, unreadable/missing source, source conflict requiring user judgment, changed user priority, or tool/runtime interruption. If the runtime forces a turn boundary, report that the rebuild is still incomplete with current counts and state that continuation has not started unless a next-batch command has actually been run.

### Deepen Existing Pages

Use when the user says the wiki is too shallow, asks to improve quality, or wants a domain to become query-ready.

1. Pick 1-2 domains only.
2. Read every source card already linked by the domain.
3. Read the raw archive for source cards whose source map is missing or thin.
4. Upgrade source cards with `Source Map`, `Evidence Notes`, `Routed Updates`, and `Gaps`.
5. Add `Evidence Inventory` to source cards before summarizing so external links, SQL, images, process analysis, negative results, and malformed source text are not lost.
6. Run an entity extraction pass before marking the domain deep:
   - Identify systems, modules, metrics, experiments, datasets, APIs, services, settings, tables, and code symbols that appear in the selected sources.
   - Promote a candidate into `entities/` when it is reused by multiple sources/pages, anchors implementation or metrics, or would otherwise make the domain page too dense.
   - Reuse/merge existing entity pages instead of creating duplicates.
   - Link the domain page to the entity page, link the entity page back to source cards, and add the entity to `index.md`.
   - If a candidate is not promoted, record the reason in the domain `Gaps` or `Conflicts And Caveats`.
7. Upgrade the domain page with `Source Coverage`, `Detailed Model`, `Data And Metrics`, `Implementation Notes`, and `Experiments And Evidence`.
8. Change `maturity` from `seed` to `deep` only when the page can answer detailed queries without archive fallback for the selected scope and obvious entity candidates have been promoted or explicitly deferred.

## Workflow

1. Read the wiki contract:

   ```bash
   luna workspace knowledge read wiki/AGENTS.md
   ```

2. Run inventory:

   ```bash
   python3 <luna-wiki-rebuild-skill-dir>/scripts/archive_inventory.py --write
   ```

3. Define the rebuild batch:
   - If the user specified files or topics, use that scope.
   - If not, start with a pilot batch.
4. For each source, read the full document through the workspace and create/update a source card in `knowledge/wiki/sources/`:

   ```bash
   luna workspace knowledge read archive/<source>.md
   ```

   - Add `## Source Map` with headings, important tables, code blocks, metrics, and TODO sections.
   - Add `## Evidence Inventory` with external links/dashboards, SQL/code/tables, images/whiteboards, process analysis, negative results, and ambiguous/truncated source text.
   - Add `## Evidence Notes` with exact formulas, thresholds, APIs, SQL/Hive tables, settings, experiment IDs, rollout states, risks, and open questions.
   - Add `## Routed Updates` naming every domain/entity/concept/decision page touched.
   - Add `## Gaps` if the source cannot be fully interpreted.
5. Extract durable knowledge into the correct page family:
   - `domains/` for integrated topic models.
   - `entities/` for systems, metrics, experiments, datasets, APIs, and modules.
   - `concepts/` for cross-cutting ideas.
   - `decisions/` for ADR-style decisions and tradeoffs.
   - During deepening, entity extraction is not optional; every deep batch must scan for reusable systems, metrics, experiments, APIs, datasets, services, settings, tables, and code symbols.
6. Update `index.md` so query agents can navigate without reading every file.
7. Update `_state/page_registry.json` and `_state/link_graph.json` when pages are created or materially changed.
8. Append `log.md`.
9. Write every changed wiki/state/log file through the workspace:

   ```bash
   luna workspace knowledge write wiki/<path>.md --body-file /tmp/<path>.md
   ```

10. Run lint:

   ```bash
   python3 <luna-wiki-lint-skill-dir>/scripts/wiki_lint.py
   ```

These scripts always read and write through `luna workspace knowledge ...`; direct local
filesystem access under `knowledge/` is not supported. Resolve each `<...-skill-dir>` from the
actual skill filesystem location; do not assume `.claude/skills/...` exists.

11. Review and commit the exact workspace changes:

   ```bash
   luna workspace knowledge git-diff
   luna workspace knowledge git-commit --message "docs: rebuild <scope>"
   ```

12. Report what was rebuilt, what failed, and what remains unprocessed.

## Integration Standard

Each maintained page should be able to answer common questions about its subject without returning to raw archive. Keep formulas, thresholds, metrics, experiment results, timelines, tradeoffs, and implementation details when they matter.

Do not over-compress source material. Remove duplication and process chatter, but preserve unique facts.

### Domain Depth Standard

For any domain page intended to be query-ready, include:

- `Detailed Model`: mechanisms, data flow, state transitions, ranking/distribution rules, fallback paths.
- `Source Coverage`: source-by-source coverage notes, including what remains only in source cards or raw archive.
- `Data And Metrics`: exact values, numerator/denominator, date or experiment scope, and known口径 caveats.
- `Implementation Notes`: APIs, services, classes, methods, settings, Hive tables, event names, log fields, schemas.
- `Experiments And Evidence`: experiment groups, results, rollout state, and interpretation.
- `Entity Links`: reusable systems, metrics, experiments, datasets, APIs, services, settings, tables, and modules promoted to `entities/` or explicitly deferred with a reason.
- `Conflicts And Caveats`: stale claims, contradictory values, and what remains unresolved.

If these sections are missing or thin, keep `status: seed` and `maturity: seed`; do not mark the page `active`.

### Entity Extraction Standard

Deep rebuild and deepening must grow the entity layer while synthesizing domains. Do not postpone entity extraction until after all domains are deep.

Create or update an `entities/` page when a candidate:

- appears in two or more source cards or domains;
- defines a metric, experiment, dataset, API, service, table, setting, module, or code symbol;
- carries implementation details that multiple topics need to cite;
- is a named product/infra component whose behavior, ownership, rollout, or risk changes over time.

Each entity page should include:

- `Summary`, `Key Facts`, `Links`, and `Sources`;
- `Role In System` for what the entity does and where it fits;
- `Implementation Notes` for APIs, tables, settings, code symbols, schemas, logs, or dependencies;
- `Evidence And Usage` for source-by-source facts, experiments, dashboards, or metric usage;
- `Gaps` for unknown ownership, stale values, missing source cards, or unresolved conflicts.

A domain page should not be marked `maturity: deep` when obvious reusable entities remain embedded only as prose. Either promote them, merge them into an existing entity, or record why promotion is deferred.

### Source Card Depth Standard

A source card should make raw archive fallback rare. It must preserve enough source structure that a query agent can jump to the right evidence:

- section map
- evidence inventory for external links, dashboards, SQL/code, images/whiteboards, process analysis, negative results, and malformed text
- exact facts and values
- code/API/schema snippets summarized with names and fields
- source links and related docs
- update routing
- gaps

## Conflict Handling

When sources disagree:

1. Keep both claims with source trace.
2. Mark the current best understanding if evidence supports it.
3. Add or update `knowledge/wiki/contradictions.md`.
4. Mark affected pages `needs-review` if the conflict blocks reliable synthesis.

## Hard Rules

- Do not edit `knowledge/archive/`.
- Do not write generated wiki content outside `knowledge/wiki/`.
- Do not create orphan pages. Every new page must be reachable from `index.md` or a linked page.
- Do not claim full rebuild if only a pilot or batch completed.
- Do not call a page complete when it is only seed-level. Label it honestly.
- Do not drop implementation details just because they look verbose. If they define behavior, route them into `Implementation Notes`.
- Always run lint after file generation unless blocked; report the exact blocker.
