---
name: luna-wiki-query
description: Query and synthesize answers from the persistent Luna LLM Wiki in `knowledge/wiki/` plus local notes under `knowledge/notes/`. Use for questions about locally archived knowledge, sample-app docs, source-derived facts, concepts, entities, decisions, contradictions, open questions, lessons learned, best practices, playbooks, principles, case retrospectives, or any task that may already be documented locally.
---

# Luna Wiki Query

Answer questions from `knowledge/wiki/` first, then consult `knowledge/notes/` for local principles, playbooks, cases, and operating lessons. Raw archive is fallback evidence, not the primary retrieval layer.

Use managed workspace commands instead of direct filesystem reads:

- `luna workspace knowledge read <path>` behaves like reading `knowledge/<path>`.
- `luna workspace knowledge grep <query> --glob <pattern>` behaves like searching `knowledge/<pattern>`.
- `luna workspace knowledge glob <pattern>` behaves like listing files under `knowledge/`.
- Do not use removed semantic query commands such as `luna knowledge route`, `luna knowledge search`, or `luna knowledge index`; query quality comes from reading the index, grepping candidate pages, and reading the matched files.
- Do not pass `LUNA_USER_ID`, `--identity-provider`, `--identity-id`, channel identity, group flags, or department flags. Luna Service resolves the canonical user from the access token and applies direct/indirect grants.
- If the CLI/service reports unauthorized, forbidden, denied, redacted, or missing results, treat that as a policy outcome and report it; do not retry with a forged or guessed identity.
- Direct `rg knowledge/wiki`, `cat knowledge/...`, or other local filesystem reads are not supported as a fallback. If `luna` or Luna Service is missing/broken, report the blocker instead of bypassing the service.

## Query Path

1. Read `knowledge/wiki/index.md`:

   ```bash
   luna workspace knowledge read wiki/index.md
   ```

2. Search `knowledge/wiki/` for relevant pages:

   ```bash
   luna workspace knowledge grep "keyword|alias" --glob "wiki/**/*.md"
   ```

   Expand synonyms when user wording may differ from wiki terminology.

   If search returns zero results, retry with synonyms at least once.

3. Read candidate domain/entity/concept/decision pages:

   ```bash
   luna workspace knowledge read wiki/domains/example.md
   ```

4. Follow source cards and links when the answer needs evidence or details.
   - For "原文怎么说 / 证据在哪 / 为什么这样判断 / SQL / 图 / 实验链接" questions, read `## Evidence Inventory` in the source cards before answering.
   - Read source cards with `luna workspace knowledge read wiki/sources/<source-card>.md`.
   - Use `luna workspace knowledge grep "<source title or fact>" --glob "wiki/sources/*.md"` when the linked source card is unclear.
5. Check `status` and `maturity` before trusting the page:
   - `maturity: seed` means useful orientation, but not complete enough for detailed answers.
   - `maturity: deep` or `canonical` can be treated as query-ready for its scope.
6. Read `knowledge/archive/` only when:
   - wiki pages are missing or too thin,
   - source trace needs verification,
   - the user explicitly asks for raw source details.
7. Search `knowledge/notes/` when the question involves operating rules, lessons learned, playbooks, prior cases, workflow defects, or best practices:

   ```bash
   luna workspace knowledge grep "keyword|alias" --glob "notes/**/*.md"
   ```

   - `knowledge/notes/principles/` for stable discipline, boundaries, and anti-patterns.
   - `knowledge/notes/playbooks/` for reusable procedures and step-by-step workflows.
   - `knowledge/notes/cases/` for concrete incident records, fixes, and retrospectives.
8. Search local repos directly when the wiki or notes point to code paths, or when code/repo reality is required to answer the question.

## Luna Topic Boundaries

- For 首帧、起播、可感知起播、切集起播、卡顿、HLS/m3u8/ts、播放性能成本 or experiment tradeoffs, start with `knowledge/wiki/domains/playback-performance.md`.
- For 播控/播放控制能力, 倍速、进度条、选集、清晰度、字幕、收藏、反馈 or rights-packaged controls, start with `knowledge/wiki/domains/playback-controls.md`.
- PiP、小窗、下载 and 投屏 may be mentioned by playback controls, but detailed answers should route to their independent domain pages when those capabilities are the main subject.

## Answer Standard

Answer directly first, then give source trace.

Include:

- current synthesized answer
- confidence or caveats when needed
- wiki pages used
- notes used when local lessons or playbooks influenced the answer
- source cards or archive paths used
- gaps that should be fixed in the wiki or notes

For deep pages, mention whether the answer came from the domain synthesis, source card evidence inventory, or raw archive fallback. This prevents a polished synthesis from hiding missing evidence.

If the answer relied on `seed` pages, say that the wiki is seed-level for this topic and name which archive/source card would need deepening.

## When Nothing Is Found

1. Retry `luna workspace knowledge grep` with synonyms or English/Chinese equivalents.
2. Search `knowledge/notes/` for principles, playbooks, cases, and lessons.
3. Search relevant local repos directly if the question is about code, build, runtime behavior, or repo configuration.
4. State plainly that `knowledge/wiki/` and `knowledge/notes/` do not yet cover the topic.
5. Suggest `luna-wiki-ingest` or a new note to file back durable knowledge when the missing answer is worth preserving.

Do not treat raw output artifacts under `workspace/outputs/` as knowledge until they are distilled into wiki pages or source cards.

## Filing Back

When the user asks to preserve the result, or the task explicitly says "沉淀/写入 wiki/更新知识库":

1. Use `luna-wiki-ingest` behavior.
2. Update the relevant wiki page.
3. Append `knowledge/wiki/log.md` with `query-fileback`.
4. Run lint.

Do not silently write query answers into the wiki when the user only asked for an answer.

## Output Shape

Use concise Chinese by default for this user.

```markdown
**结论**
[direct answer]

**依据**
- Wiki: ...
- Source: ...

**缺口**
- ...
```

Skip sections that are empty.

## Hard Rules

- Do not answer from memory when `knowledge/wiki/` may contain the answer.
- Do not cite a page you did not read.
- Do not claim the wiki lacks knowledge until `wiki/index.md` and `luna workspace knowledge grep ... --glob "wiki/**/*.md"` were both checked, plus one synonym retry, or the CLI/service blocker was reported.
- Do not replace the v0.1.1-style `index + grep + read` workflow with black-box route/search helpers.
- Do not claim there are no prior local lessons until relevant `knowledge/notes/` roots were checked when the question touches process, playbooks, cases, or operating rules.
- If raw archive was required, state that the wiki needs enrichment.
- Do not treat `seed` pages as complete evidence for high-detail technical answers.
