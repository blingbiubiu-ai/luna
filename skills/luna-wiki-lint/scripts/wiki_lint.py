#!/usr/bin/env python3
"""Structural and depth lint for knowledge/wiki."""

from __future__ import annotations

import json
import posixpath
import re
import sys
from pathlib import Path
from typing import TypedDict

REBUILD_SCRIPT_DIR = Path(__file__).resolve().parents[2] / "luna-wiki-rebuild" / "scripts"
sys.path.insert(0, str(REBUILD_SCRIPT_DIR))
from workspace_io import KnowledgeWorkspace, resolve_markdown_link  # noqa: E402

class LintError(TypedDict):
    severity: str
    message: str


FrontmatterValue = str | list[str]


CORE_FILES = [
    "AGENTS.md",
    "index.md",
    "log.md",
    "glossary.md",
    "contradictions.md",
    "open-questions.md",
    "_state/source_manifest.json",
    "_state/page_registry.json",
    "_state/link_graph.json",
]

PAGE_DIRS = ["sources", "domains", "entities", "concepts", "decisions"]
LOCAL_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
MOJIBAKE_PATTERNS = ["�", "��", "\ufffd"]
RISK_TAG_FIELDS = ["risk_tags", "riskTags"]
RISK_DETECTION_FIELDS = RISK_TAG_FIELDS + ["tags", "topics"]
USER_ACL_FIELDS = ["allowed_users", "allowedUsers", "users"]
GROUP_ACL_FIELDS = ["allowed_groups", "allowedGroups", "groups"]
DEPARTMENT_ACL_FIELDS = ["allowed_departments", "allowedDepartments", "departments"]
HIGH_RISK_TERMS = [
    "legal-risk",
    "risk_reduction",
    "risk-reduction",
    "legal",
    "法务",
    "security",
    "安全",
    "risk",
    "降险",
    "合规",
    "风险",
]
REQUIRED_BY_TYPE = {
    "source": ["## Summary", "## Key Facts", "## Source Map", "## Evidence Inventory", "## Evidence Notes", "## Links", "## Sources"],
    "domain": [
        "## Summary",
        "## Current Model",
        "## Source Coverage",
        "## Key Facts",
        "## Detailed Model",
        "## Data And Metrics",
        "## Implementation Notes",
        "## Experiments And Evidence",
        "## Timeline",
        "## Conflicts And Caveats",
        "## Links",
        "## Sources",
    ],
    "entity": ["## Summary", "## Key Facts", "## Evidence Notes", "## Relationships", "## Links", "## Sources"],
    "concept": ["## Summary", "## Key Facts", "## Evidence Notes", "## How It Connects", "## Links", "## Sources"],
    "decision": ["## Summary", "## Key Facts", "## Context", "## Options", "## Decision", "## Consequences", "## Links", "## Sources"],
}
DEEP_MATURITIES = {"deep", "canonical"}


def rel(path: str) -> str:
    return f"knowledge/{path}"


def add(errors: list[LintError], severity: str, message: str) -> None:
    errors.append({"severity": severity, "message": message})


def parse_frontmatter(text: str) -> dict[str, FrontmatterValue]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end == -1:
        return {}
    data: dict[str, FrontmatterValue] = {}
    current_list_key: str | None = None
    for line in text[4:end].splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if current_list_key and line.startswith((" ", "\t")) and stripped.startswith("- "):
            value = clean_yaml_scalar(stripped[2:].strip())
            if value:
                existing = data.get(current_list_key)
                if isinstance(existing, list):
                    existing.append(value)
            continue
        current_list_key = None
        if line.startswith((" ", "\t")) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if value == "":
            data[key] = []
            current_list_key = key
        elif is_inline_yaml_list(value):
            data[key] = parse_inline_yaml_list(value)
        else:
            data[key] = clean_yaml_scalar(value)
    return data


def clean_yaml_scalar(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if " #" in value:
        value = value.split(" #", 1)[0].rstrip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def is_inline_yaml_list(value: str) -> bool:
    return value.startswith("[") and value.endswith("]")


def parse_inline_yaml_list(value: str) -> list[str]:
    inner = value[1:-1].strip()
    if not inner:
        return []
    items: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escape = False
    for char in inner:
        if escape:
            current.append(char)
            escape = False
            continue
        if char == "\\" and quote == '"':
            escape = True
            current.append(char)
            continue
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            continue
        if char in {'"', "'"}:
            quote = char
            current.append(char)
            continue
        if char == ",":
            item = clean_yaml_scalar("".join(current).strip())
            if item:
                items.append(item)
            current = []
            continue
        current.append(char)
    item = clean_yaml_scalar("".join(current).strip())
    if item:
        items.append(item)
    return items


def strings_from_value(value: FrontmatterValue | None) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def read_string_list(value: FrontmatterValue | None) -> list[str]:
    if isinstance(value, str):
        return [item for item in (clean_yaml_scalar(item) for item in value.split(",")) if item]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    return []


def first_present_list(frontmatter: dict[str, FrontmatterValue], fields: list[str]) -> list[str]:
    for field in fields:
        if field in frontmatter:
            return read_string_list(frontmatter.get(field))
    return []


def first_value(frontmatter: dict[str, FrontmatterValue], field: str, default: str) -> str:
    values = strings_from_value(frontmatter.get(field))
    return values[0] if values else default


def detect_risk_tags(path: str, frontmatter: dict[str, FrontmatterValue]) -> list[str]:
    candidates = [
        rel(path),
        *strings_from_value(frontmatter.get("title")),
        *first_present_list(frontmatter, RISK_DETECTION_FIELDS),
    ]
    normalized_candidates = [candidate.lower() for candidate in candidates]
    tags: list[str] = []
    for term in HIGH_RISK_TERMS:
        normalized_term = term.lower()
        if any(normalized_term in candidate for candidate in normalized_candidates):
            tags.append(term)
    return tags


def check_core(workspace: KnowledgeWorkspace, errors: list[LintError]) -> None:
    for item in CORE_FILES:
        path = f"wiki/{item}"
        if not workspace.exists(path):
            add(errors, "CRITICAL", f"missing core file {rel(path)}")
    for item in PAGE_DIRS + ["templates"]:
        path = f"wiki/{item}"
        if not workspace.dir_exists(path):
            add(errors, "CRITICAL", f"missing directory {rel(path)}")


def check_manifest(workspace: KnowledgeWorkspace, errors: list[LintError]) -> None:
    if not workspace.exists("wiki/_state/source_manifest.json"):
        return
    try:
        manifest = json.loads(workspace.read_text("wiki/_state/source_manifest.json"))
    except Exception as exc:  # noqa: BLE001
        add(errors, "CRITICAL", f"invalid manifest JSON: {exc}")
        return
    sources = manifest.get("sources", [])
    archive_files = workspace.glob("archive/*.md")
    if manifest.get("source_count") != len(sources):
        add(errors, "MODERATE", "manifest source_count does not match sources length")
    if sources and len(sources) != len(archive_files):
        add(errors, "MODERATE", f"manifest has {len(sources)} sources but archive has {len(archive_files)} markdown files")
    for source in sources:
        if not workspace.exists(str(source.get("path", ""))):
            add(errors, "CRITICAL", f"manifest source path missing: {source.get('path')}")


def check_links(workspace: KnowledgeWorkspace, errors: list[LintError]) -> None:
    for path in workspace.glob("wiki/**/*.md"):
        text = workspace.read_text(path)
        for match in LOCAL_LINK_RE.finditer(text):
            target = match.group(1).strip()
            target_path = resolve_markdown_link(path, target)
            if target_path is None:
                if target.startswith("/") or target.startswith("../"):
                    add(errors, "MODERATE", f"{rel(path)} links outside workspace: {target}")
                continue
            if not workspace.exists(target_path):
                add(errors, "MODERATE", f"{rel(path)} has broken link: {target}")


def check_text_hygiene(workspace: KnowledgeWorkspace, errors: list[LintError]) -> None:
    for path in workspace.glob("wiki/**/*.md"):
        text = workspace.read_text(path)
        for pattern in MOJIBAKE_PATTERNS:
            if pattern in text:
                add(errors, "MODERATE", f"{rel(path)} contains mojibake/replacement characters")
                break


def check_index_coverage(workspace: KnowledgeWorkspace, errors: list[LintError]) -> None:
    if not workspace.exists("wiki/index.md"):
        return
    index_text = workspace.read_text("wiki/index.md")
    for dirname in PAGE_DIRS:
        for path in workspace.glob(f"wiki/{dirname}/*.md"):
            name = posixpath.basename(path)
            if dirname == "concepts" and name.startswith("_"):
                continue
            index_target = f"{dirname}/{name}"
            if index_target not in index_text:
                add(errors, "MODERATE", f"{rel(path)} missing from knowledge/wiki/index.md")


def check_maintained_pages(workspace: KnowledgeWorkspace, errors: list[LintError]) -> None:
    for dirname in PAGE_DIRS:
        for path in workspace.glob(f"wiki/{dirname}/*.md"):
            text = workspace.read_text(path)
            fm = parse_frontmatter(text)
            if not text.startswith("---\n"):
                add(errors, "MODERATE", f"{rel(path)} missing YAML frontmatter")
            if not strings_from_value(fm.get("sensitivity")):
                add(errors, "MODERATE", f"{rel(path)} missing sensitivity frontmatter")
            page_type = first_value(fm, "type", dirname.rstrip("s"))
            maturity = first_value(fm, "maturity", "seed")
            status = first_value(fm, "status", "seed")
            user_acl = first_present_list(fm, USER_ACL_FIELDS)
            group_acl = first_present_list(fm, GROUP_ACL_FIELDS)
            department_acl = first_present_list(fm, DEPARTMENT_ACL_FIELDS)
            required = ["## Summary", "## Key Facts", "## Links", "## Sources"]
            if maturity in DEEP_MATURITIES or status == "active":
                required = REQUIRED_BY_TYPE.get(page_type, required)
            for section in required:
                if section not in text:
                    add(errors, "MODERATE", f"{rel(path)} missing section {section}")
            if status == "active" and maturity not in DEEP_MATURITIES:
                add(errors, "MODERATE", f"{rel(path)} is active but maturity is {maturity or 'missing'}")
            if dirname == "sources" and "knowledge/archive/" not in text:
                add(errors, "MODERATE", f"{rel(path)} source card missing archive path")
            if maturity in DEEP_MATURITIES and dirname == "sources" and "## Source Map" not in text:
                add(errors, "MODERATE", f"{rel(path)} deep source card missing source map")
            if maturity in DEEP_MATURITIES and dirname == "sources" and "## Evidence Inventory" not in text:
                add(errors, "MODERATE", f"{rel(path)} deep source card missing evidence inventory")
            if maturity in DEEP_MATURITIES and dirname == "domains" and "## Source Coverage" not in text:
                add(errors, "MODERATE", f"{rel(path)} deep domain page missing source coverage")
            if detect_risk_tags(path, fm):
                if not first_present_list(fm, RISK_TAG_FIELDS):
                    add(errors, "MODERATE", f"{rel(path)} high-risk page missing risk_tags/riskTags")
                if not any((user_acl, group_acl, department_acl)):
                    add(errors, "MODERATE", f"{rel(path)} high-risk page missing explicit ACL frontmatter")
            for user_id in user_acl:
                if ":" not in user_id:
                    add(errors, "MODERATE", f"{rel(path)} allowed_users value must be provider-qualified: {user_id}")

def emit_json(errors: list[LintError]) -> None:
    print(json.dumps({"status": "fail" if errors else "pass", "errorCount": len(errors), "errors": errors}, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    json_output = "--json" in args
    errors: list[LintError] = []
    workspace = KnowledgeWorkspace()
    check_core(workspace, errors)
    check_manifest(workspace, errors)
    check_text_hygiene(workspace, errors)
    check_links(workspace, errors)
    check_index_coverage(workspace, errors)
    check_maintained_pages(workspace, errors)

    if json_output:
        emit_json(errors)
        return 1 if errors else 0

    if errors:
        print("Luna wiki lint failed:")
        for error in errors:
            print(f"- {error['severity']}: {error['message']}")
        return 1
    print("Luna wiki lint passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
