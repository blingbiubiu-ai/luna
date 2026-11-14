#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

mkdir -p "${TMP_DIR}/repo/knowledge/archive" "${TMP_DIR}/repo/knowledge/wiki" "${TMP_DIR}/bin"

cat >"${TMP_DIR}/bin/luna" <<'FAKE_LUNA'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${LUNA_FAKE_LOG}"

if [[ "$1 $2" != "workspace knowledge" ]]; then
  echo "unexpected command" >&2
  exit 2
fi

shift 2
case "$1" in
  glob)
    printf '{"entries":[{"path":"wiki/index.md"}]}\n'
    ;;
  read)
    printf '{"content":"# Service Index"}\n'
    ;;
  write)
    printf '{"ok":true}\n'
    ;;
  *)
    printf '{"ok":true}\n'
    ;;
esac
FAKE_LUNA
chmod +x "${TMP_DIR}/bin/luna"

cd "${TMP_DIR}/repo"

LUNA_FAKE_LOG="${TMP_DIR}/luna.log" \
PATH="${TMP_DIR}/bin:${PATH}" \
PYTHONPATH="${SCRIPT_DIR}" \
python3 - <<'PY'
from workspace_io import KnowledgeWorkspace

workspace = KnowledgeWorkspace()
assert workspace.service_mode is True
assert workspace.glob("wiki/**/*.md") == ["wiki/index.md"]
assert workspace.read_text("wiki/index.md") == "# Service Index"
workspace.write_text("wiki/new.md", "body")
PY

grep -q 'workspace knowledge glob wiki/\*\*/\*.md' "${TMP_DIR}/luna.log"
grep -q 'workspace knowledge read wiki/index.md' "${TMP_DIR}/luna.log"
grep -q 'workspace knowledge write wiki/new.md --body-file' "${TMP_DIR}/luna.log"
