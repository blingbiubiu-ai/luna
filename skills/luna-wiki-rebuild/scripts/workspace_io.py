#!/usr/bin/env python3
"""Knowledge workspace I/O for Luna wiki maintenance scripts."""

from __future__ import annotations

import json
import os
import posixpath
import subprocess
import tempfile
from pathlib import Path
from typing import Any


class KnowledgeWorkspace:
    def __init__(self) -> None:
        load_default_env()
        self.service_mode = True
        self._service_file_cache: set[str] | None = None
        self._glob_cache: dict[str, list[str]] = {}
        self._read_cache: dict[str, str] = {}

    def glob(self, pattern: str) -> list[str]:
        if pattern in self._glob_cache:
            return self._glob_cache[pattern]
        payload = self._luna_json(["glob", pattern])
        entries = payload.get("entries", [])
        paths = sorted(str(entry["path"]) for entry in entries if "path" in entry)
        self._glob_cache[pattern] = paths
        return paths

    def read_text(self, path: str) -> str:
        normalized = normalize_workspace_path(path)
        if normalized in self._read_cache:
            return self._read_cache[normalized]
        payload = self._luna_json(["read", normalized])
        content = payload.get("content")
        if not isinstance(content, str):
            raise RuntimeError(f"workspace read returned no content for {normalized}")
        self._read_cache[normalized] = content
        return content

    def write_text(self, path: str, content: str) -> None:
        normalized = normalize_workspace_path(path)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        try:
            self._luna_json(["write", normalized, "--body-file", tmp_path])
            self._service_file_cache = None
        finally:
            Path(tmp_path).unlink(missing_ok=True)
        self._invalidate(normalized)

    def exists(self, path: str) -> bool:
        normalized = normalize_workspace_path(path)
        return normalized in self._service_files()

    def dir_exists(self, path: str) -> bool:
        normalized = normalize_workspace_path(path)
        prefix = f"{normalized.rstrip('/')}/"
        return any(candidate.startswith(prefix) for candidate in self._service_files())

    def workspace_rel(self, path: str) -> str:
        return f"knowledge/{normalize_workspace_path(path)}"

    def _service_files(self) -> set[str]:
        if self._service_file_cache is None:
            self._service_file_cache = set(self.glob("**/*"))
        return self._service_file_cache

    def _invalidate(self, path: str) -> None:
        self._read_cache.pop(path, None)
        self._glob_cache.clear()
        self._service_file_cache = None

    def _luna_json(self, args: list[str]) -> dict[str, Any]:
        command = ["luna", "workspace", "knowledge", *args]
        with tempfile.NamedTemporaryFile("w+b", delete=False) as stdout_file:
            stdout_path = stdout_file.name
            result = subprocess.run(command, text=True, stdout=stdout_file, stderr=subprocess.PIPE, check=False)
        try:
            stdout = Path(stdout_path).read_text(encoding="utf-8")
        finally:
            Path(stdout_path).unlink(missing_ok=True)
        if result.returncode != 0:
            message = result.stderr.strip() or stdout.strip() or "unknown service error"
            raise RuntimeError(f"{' '.join(command)} failed: {message}")
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{' '.join(command)} returned non-JSON output") from exc
        if isinstance(payload, dict):
            return payload
        raise RuntimeError(f"{' '.join(command)} returned non-object JSON")


def load_default_env() -> None:
    env_path = Path(os.environ.get("LUNA_HOME", Path.home() / ".luna")) / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export ") :].strip()
        if not key or key in os.environ:
            continue
        if not key.startswith("LUNA_"):
            continue
        os.environ[key] = parse_env_value(value.strip())


def parse_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def normalize_workspace_path(path: str) -> str:
    normalized = path.strip().replace("\\", "/")
    if normalized.startswith("knowledge/"):
        normalized = normalized[len("knowledge/") :]
    normalized = posixpath.normpath(normalized)
    if normalized in {"", "."} or normalized.startswith("../") or normalized == ".." or normalized.startswith("/"):
        raise RuntimeError(f"invalid workspace path: {path}")
    return normalized


def resolve_markdown_link(source_path: str, target: str) -> str | None:
    target = target.split("#", 1)[0].strip()
    if not target or target.startswith("`"):
        return None
    if "://" in target or target.startswith("#") or target.startswith("mailto:"):
        return None
    if target.startswith("/"):
        return None
    base = posixpath.dirname(normalize_workspace_path(source_path))
    normalized = posixpath.normpath(posixpath.join(base, target))
    if normalized == "." or normalized.startswith("../"):
        return None
    return normalized
