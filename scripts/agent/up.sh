#!/usr/bin/env bash
set -euo pipefail

LUNA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-server-only}"

case "$MODE" in
  server-only) ;;
  both|web-only)
    echo "Web mode is not available until the dashboard migration task."
    echo "Usage: up.sh [server-only]"
    exit 1
    ;;
  *)
    echo "Invalid mode: $MODE"
    echo "Usage: up.sh [server-only]"
    exit 1
    ;;
esac

echo "Starting Luna Service through the canonical service CLI daemon..."
cd "$LUNA_ROOT"
bun "$LUNA_ROOT/src/cli/server-main.ts" start
