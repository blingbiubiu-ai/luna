#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:-}"
PACKAGE_NAME="${LUNA_NPM_PACKAGE_NAME:-@luna-agent/client}"
STAGING="$ROOT/.release/npm/luna"
PACK_DIR="$ROOT/.release/npm"

if [[ -z "$VERSION" ]]; then
  VERSION="$(
    cd "$ROOT"
    bun --eval 'const pkg = await Bun.file("package.json").json(); console.log(pkg.version);'
  )"
fi

echo "Building Luna..."
cd "$ROOT"
bun build apps/cli/src/main.ts --outfile dist/luna-client.js --target bun --minify

echo "Preparing npm package $PACKAGE_NAME@$VERSION..."
rm -rf "$STAGING"
mkdir -p "$STAGING/dist"

cp "$ROOT/dist/luna-client.js" "$STAGING/dist/luna-client.js"
chmod +x "$STAGING/dist/luna-client.js"

cat > "$STAGING/README.md" <<EOF
# $PACKAGE_NAME

Thin client CLI for Luna Service.

This package installs the \`luna\` command for client workflows and local deployment dispatch. It
connects to an existing Luna Service and does not include the local service
runtime, dashboard assets, database schema, MCP stdio bridge, or plugin server
runtime. Local \`luna service\` and \`luna worker\` commands require their
standalone components, installed alongside the CLI or available on PATH.
The legacy \`luna-service\` and \`luna-worker\` commands remain supported.

## Install

\`\`\`bash
npm install -g $PACKAGE_NAME
\`\`\`

## Configure

\`\`\`bash
export LUNA_SERVICE_URL=http://127.0.0.1:9000
luna auth login
\`\`\`

## Commands

\`\`\`bash
luna auth <command>
luna knowledge <command>
luna workspace <workspace-id> <command>
luna task <command>
luna session <command>
luna artifacts materialize artifact:<id>
luna version
\`\`\`

Plugin commands are resolved by Luna Service at runtime.
EOF

cat > "$STAGING/package.json" <<JSON
{
  "name": "$PACKAGE_NAME",
  "version": "$VERSION",
  "description": "Luna Service client CLI",
  "type": "module",
  "bin": {
    "luna": "dist/luna-client.js"
  },
  "files": [
    "dist/luna-client.js",
    "README.md"
  ],
  "engines": {
    "bun": ">=1.3.0"
  }
}
JSON

echo "Packing npm tarball..."
mkdir -p "$PACK_DIR"
rm -f "$PACK_DIR"/*.tgz
(
  cd "$STAGING"
  npm pack --pack-destination "$PACK_DIR"
)

TARBALL="$(find "$PACK_DIR" -maxdepth 1 -name "*.tgz" -print | sort | tail -1)"
echo
echo "Created: $TARBALL"
echo
echo "Install locally or on a server with:"
echo "  npm install -g $TARBALL"
