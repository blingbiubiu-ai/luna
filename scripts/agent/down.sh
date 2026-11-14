#!/usr/bin/env bash
set -euo pipefail

LUNA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-both}"

case "$MODE" in
  both|server-only) ;;
  web-only)
    echo "Web mode is not available until the dashboard migration task."
    echo "Usage: down.sh [both|server-only]"
    exit 0
    ;;
  *)
    echo "Invalid mode: $MODE"
    echo "Usage: down.sh [both|server-only]"
    exit 1
    ;;
esac

echo "Stopping Luna Service through the canonical service CLI daemon..."
cd "$LUNA_ROOT"
bun "$LUNA_ROOT/src/cli/server-main.ts" stop
