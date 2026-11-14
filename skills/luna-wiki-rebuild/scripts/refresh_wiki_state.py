#!/usr/bin/env python3
"""Refresh Luna wiki registry, source manifest, and link graph."""

from __future__ import annotations

import json
import re
import sys
import posixpath
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from workspace_io import KnowledgeWorkspace, resolve_markdown_link  # noqa: E402

PAGE_DIRS = ["decisions", "domains", "entities", "concepts", "sources"]


def parse_frontmatter(text: str) -> dict:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}
    frontmatter: dict = {}
    for line in text[4:end].splitlines():
        if ":" not in line or line.strip().startswith("#"):
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        elif value.startswith("[") and value.endswith("]"):
            value = [
                part.strip().strip("\"'")
                for part in value[1:-1].split(",")
                if part.strip()
            ]
        elif value.isdigit():
            value = int(value)
        frontmatter[key] = value
    return frontmatter


def collect_pages(workspace: KnowledgeWorkspace) -> tuple[list[dict], dict[str, str]]:
    pages: list[dict] = []
    source_card_by_archive: dict[str, str] = {}
    for dirname in PAGE_DIRS:
        for workspace_path in workspace.glob(f"wiki/{dirname}/*.md"):
            text = workspace.read_text(workspace_path)
            fm = parse_frontmatter(text)
            if not fm.get("type"):
                continue
            rel_path = workspace.workspace_rel(workspace_path)
            item = {
                "path": rel_path,
                "type": fm.get("type", ""),
                "title": fm.get("title", Path(workspace_path).stem),
                "status": fm.get("status", ""),
                "maturity": fm.get("maturity", ""),
                "updated": str(fm.get("updated", "")),
                "source_count": fm.get("source_count", 0),
            }
            pages.append(item)
            if item["type"] == "source" and fm.get("archive_path"):
                source_card_by_archive[str(fm["archive_path"])] = rel_path
    return pages, source_card_by_archive


def refresh_manifest(workspace: KnowledgeWorkspace, source_card_by_archive: dict[str, str], now: str) -> tuple[int, int]:
    manifest = json.loads(workspace.read_text("wiki/_state/source_manifest.json"))
    for source in manifest.get("sources", []):
        card = source_card_by_archive.get(source.get("path", ""))
        if card:
            source["wiki_source_card"] = card
            source["status"] = "processed"
        elif source.get("status") != "out-of-scope":
            source["wiki_source_card"] = ""
            source["status"] = "unprocessed"
    manifest["generated_at"] = now
    manifest["source_count"] = len(manifest.get("sources", []))
    workspace.write_text(
        "wiki/_state/source_manifest.json",
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )
    processed = sum(1 for source in manifest["sources"] if source.get("status") == "processed")
    return processed, len(manifest["sources"]) - processed


def refresh_link_graph(workspace: KnowledgeWorkspace, pages: list[dict], now: str) -> int:
    page_by_path = {page["path"]: page for page in pages}
    page_paths = set(page_by_path)
    nodes = [
        {
            "path": page["path"],
            "title": page["title"],
            "type": page["type"],
            "maturity": page["maturity"],
        }
        for page in pages
    ]
    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()
    md_link_re = re.compile(r"\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)")
    wiki_link_re = re.compile(r"\[\[([^\]|#]+)")
    for page in pages:
        source = page["path"]
        workspace_source = source.removeprefix("knowledge/")
        text = workspace.read_text(workspace_source)
        for match in md_link_re.finditer(text):
            raw = match.group(1)
            target_workspace = resolve_markdown_link(workspace_source, raw)
            if target_workspace is None:
                continue
            target_rel = f"knowledge/{target_workspace}"
            if target_rel in page_paths and (source, target_rel) not in seen:
                edges.append({"source": source, "target": target_rel})
                seen.add((source, target_rel))
        for match in wiki_link_re.finditer(text):
            name = match.group(1).strip()
            for target_rel in [
                candidate
                for candidate in page_paths
                if posixpath.splitext(posixpath.basename(candidate))[0] == name or page_by_path[candidate]["title"] == name
            ]:
                if (source, target_rel) not in seen:
                    edges.append({"source": source, "target": target_rel})
                    seen.add((source, target_rel))
    workspace.write_text(
        "wiki/_state/link_graph.json",
        json.dumps(
            {
                "schema_version": 1,
                "generated_at": now,
                "nodes": nodes,
                "edges": edges,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
    )
    return len(edges)


def main() -> None:
    workspace = KnowledgeWorkspace()
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    pages, source_card_by_archive = collect_pages(workspace)
    workspace.write_text(
        "wiki/_state/page_registry.json",
        json.dumps({"schema_version": 1, "generated_at": now, "pages": pages}, ensure_ascii=False, indent=2)
        + "\n"
    )
    processed, unprocessed = refresh_manifest(workspace, source_card_by_archive, now)
    edges = refresh_link_graph(workspace, pages, now)
    print(f"registry_pages {len(pages)}")
    print(f"deep_pages {sum(1 for page in pages if page.get('maturity') == 'deep')}")
    print(f"active_pages {sum(1 for page in pages if page.get('status') == 'active')}")
    print(f"processed_sources {processed}")
    print(f"unprocessed_sources {unprocessed}")
    print(f"edges {edges}")


if __name__ == "__main__":
    main()
