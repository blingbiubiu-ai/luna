#!/usr/bin/env python3
"""Inventory knowledge/archive without modifying raw sources."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
from typing import Any

from workspace_io import KnowledgeWorkspace


def parse_frontmatter(text: str) -> dict[str, Any]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end == -1:
        return {}
    raw = text[4:end].strip()
    data: dict[str, Any] = {}
    for line in raw.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        data[key] = value
    return data


def first_heading(text: str) -> str | None:
    for line in text.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1).strip()
    return None


def source_id_for(rel_path: str) -> str:
    return "src-" + hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:12]


def inventory(workspace: KnowledgeWorkspace) -> dict[str, Any]:
    sources = []
    for archive_path in workspace.glob("archive/*.md"):
        text = workspace.read_text(archive_path)
        raw = text.encode("utf-8")
        rel_path = workspace.workspace_rel(archive_path)
        fm = parse_frontmatter(text)
        title = str(fm.get("title") or first_heading(text) or archive_path.rsplit("/", 1)[-1].removesuffix(".md"))
        lines = text.count("\n") + (0 if text.endswith("\n") else 1)
        sources.append(
            {
                "source_id": source_id_for(rel_path),
                "path": rel_path,
                "title": title,
                "source_url": fm.get("source", ""),
                "archived": fm.get("archived", ""),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw),
                "lines": lines,
                "legacy_frontmatter": {
                    "domain": fm.get("domain", ""),
                    "distilled_into": fm.get("distilled-into", ""),
                },
                "wiki_source_card": "",
                "status": "unprocessed",
            }
        )
    return {
        "schema_version": 1,
        "archive_root": "knowledge/archive",
        "wiki_root": "knowledge/wiki",
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "source_count": len(sources),
        "sources": sources,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="write knowledge/wiki/_state/source_manifest.json")
    args = parser.parse_args()

    workspace = KnowledgeWorkspace()
    manifest = inventory(workspace)
    if args.write:
        workspace.write_text("wiki/_state/source_manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        print(f"wrote knowledge/wiki/_state/source_manifest.json with {manifest['source_count']} sources")
    else:
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
