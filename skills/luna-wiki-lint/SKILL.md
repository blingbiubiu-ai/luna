---
name: luna-wiki-lint
description: Health-check the new Luna LLM Wiki under `knowledge/wiki/`. Use when the user asks to lint, audit, validate, health-check, check source trace, find broken links, find orphan pages, detect contradictions, or verify wiki quality after rebuild/ingest. This is the required verification step for luna-wiki rebuild and ingest.
---

# Luna Wiki Lint

Validate the wiki structure, links, source trace, and operating hygiene.

## Fast Check

Run:

```bash
python3 <luna-wiki-lint-skill-dir>/scripts/wiki_lint.py
```

For machine-readable gateway/client checks, run:

```bash
python3 <luna-wiki-lint-skill-dir>/scripts/wiki_lint.py --json
```

The script always reads through the managed workspace by calling `luna workspace knowledge ...`.
Direct local filesystem reads under `knowledge/` are no longer supported.

Resolve `<luna-wiki-lint-skill-dir>` from this skill's actual filesystem location; do not assume `.claude/skills/...` exists.

Report pass/fail with concrete file paths.

The lint script checks structure plus depth hygiene:

- mojibake/replacement characters
- missing core files
- broken local links
- source cards without archive trace
- active pages that are not `maturity: deep` or `canonical`
- deep/canonical pages missing detailed sections
- deep source cards missing `## Evidence Inventory`
- deep domain pages missing `## Source Coverage`
- maintained pages missing index coverage
- maintained pages missing `sensitivity` frontmatter (`MODERATE`)
- high-risk pages missing explicit `risk_tags` / `riskTags` (`MODERATE`)
- high-risk pages missing explicit ACL frontmatter (`MODERATE`)
- `allowed_users` / `allowedUsers` / `users` values that are not provider-qualified, for example missing `feishu:` (`MODERATE`)
- `allowed_groups` / `allowedGroups` / `groups` and `allowed_departments` / `allowedDepartments` / `departments` values stay in page frontmatter; runtime resolution belongs to Unified Service Principal Directory.

High-risk detection is intentionally body-blind: it only uses the page path and frontmatter fields `title`, `risk_tags`, `riskTags`, `tags`, and `topics`; it does not scan Markdown body text.

ACL alias fields follow runtime priority instead of merging:

- users: `allowed_users`, then `allowedUsers`, then `users`
- groups: `allowed_groups`, then `allowedGroups`, then `groups`
- departments: `allowed_departments`, then `allowedDepartments`, then `departments`
- risk tags: `risk_tags`, then `riskTags`, then `tags`, then `topics`

List values may use YAML inline lists, YAML block lists, or comma-separated strings such as `allowed_groups: risk-reviewers, legal-admins`.

## Manual Review Checklist

Use this after large rebuilds or when the script reports weak coverage:

- `index.md` links every maintained page.
- `log.md` has a new parseable entry for the operation.
- Maintained pages have required frontmatter and `## Sources`.
- Maintained pages declare `sensitivity`.
- High-risk legal/security/risk-reduction pages declare `risk_tags` / `riskTags` and explicit ACL.
- High-risk review is based on path/frontmatter only; do not expect body-only risk terms to trigger lint.
- User ACL values are provider-qualified, such as `feishu:ou_xxx`.
- Group and department ACL values are stable principal slugs that can be imported into Unified Service Principal Directory.
- Source cards link back to archive paths.
- Source cards have `## Source Map` before being marked deep.
- Source cards have `## Evidence Inventory` before being marked deep.
- Domain pages have `## Source Coverage` before being marked deep.
- No wiki page depends on unsupported claims.
- Contradictions are not silently overwritten.
- Orphan pages are either linked or archived.
- Important entities mentioned repeatedly have entity pages or explicit open questions.

## Severity

- Critical: broken source trace, missing required core files, archive mutation, index cannot navigate to generated pages.
- Moderate: missing `## Sources`, broken local link, orphan page, stale manifest, missing `sensitivity`, high-risk ACL gaps, unqualified ACL users.
- Low: formatting drift, weak tags, sparse glossary, missing optional aliases.
- Depth: seed page is acceptable, but active/deep claims must satisfy detailed-section checks.

## Hard Rules

- Lint does not fix by default unless the user asks for repair or the fix is deterministic and low-risk.
- If lint fails after rebuild/ingest, do not claim the wiki is healthy.
- If a check is skipped, name the reason.
