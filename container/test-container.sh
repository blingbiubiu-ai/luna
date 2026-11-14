#!/bin/bash
set -euo pipefail

IMAGE="${1:?Usage: test-container.sh IMAGE}"
VARIANT="${2:-general}"
case "$VARIANT" in general|android) ;; *) echo "Invalid variant" >&2; exit 1 ;; esac
if [ "$VARIANT" = android ]; then
  PRIVATE_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local/android/test-container.sh"
  [ -f "$PRIVATE_TEST" ] || { echo "Android verification requires local configuration (see container/README.md)" >&2; exit 1; }
  exec bash "$PRIVATE_TEST" "$IMAGE" android
fi
PASS=0
FAIL=0

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected to find '$needle'"
    FAIL=$((FAIL + 1))
  fi
}

assert_matches() {
  local label="$1" haystack="$2" pattern="$3"
  if echo "$haystack" | grep -qE "$pattern"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected to match /$pattern/"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Runner subprocess protocol ==="
run_job() {
  timeout 15 docker run --rm -i -e LUNA_RUNNER_HOME=/tmp -e HOME=/tmp     --entrypoint bun "$IMAGE" /app/agent-runner/dist/job-main.js
}
OUTPUT=$(echo '{"prompt":"hello test","runnerType":"claude"}' | run_job 2>&1) || true
assert_contains "LUNA_OUTPUT_START marker" "$OUTPUT" "---LUNA_OUTPUT_START---"
assert_contains "LUNA_OUTPUT_END marker" "$OUTPUT" "---LUNA_OUTPUT_END---"
assert_matches "JSON status field" "$OUTPUT" '"status"'

OUTPUT2=$(echo "bad-input" | run_job 2>&1) || true
assert_contains "Markers on bad input" "$OUTPUT2" "---LUNA_OUTPUT_START---"

OUTPUT3=$(timeout 10 docker run --rm --entrypoint id "$IMAGE" -u 2>&1) || true
assert_contains "Runs as UID 1000" "$OUTPUT3" "1000"

OUTPUT_GENERAL=$(timeout 30 docker run --rm --entrypoint /bin/bash "$IMAGE" -lc '
  set -e
  bun --version
  node --version
  git --version
  claude --version
  codex --version
  google-chrome --version
  test ! -d /opt/android-sdk
  test -z "${ANDROID_HOME:-}"
  printf "general-tools-ok\n"
' 2>&1) || true
assert_contains "General tools available without Android SDK" "$OUTPUT_GENERAL" "general-tools-ok"

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
