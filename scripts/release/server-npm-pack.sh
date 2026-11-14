#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:-}"
PACKAGE_NAME="${LUNA_SERVER_NPM_PACKAGE_NAME:-@luna-agent/server}"
STAGING="$ROOT/.release/npm/luna-server"
PACK_DIR="$ROOT/.release/npm"

if [[ -z "$VERSION" ]]; then
  VERSION="$(
    cd "$ROOT"
    bun --eval 'const pkg = await Bun.file("package.json").json(); console.log(pkg.version);'
  )"
fi

echo "Building Luna Service..."
cd "$ROOT"
bun build src/index.ts --outdir dist --target bun --minify
bun build src/cli/server-main.ts --outfile dist/luna-service.js --target bun --minify
bun run --cwd apps/dashboard build

echo "Preparing npm package $PACKAGE_NAME@$VERSION..."
rm -rf "$STAGING"
mkdir -p \
  "$STAGING/dist" \
  "$STAGING/apps/dashboard" \
  "$STAGING/src/data" \
  "$STAGING/src"

cp "$ROOT/dist/index.js" "$STAGING/dist/index.js"
cp "$ROOT/dist/luna-service.js" "$STAGING/dist/luna-service.js"
cp -R "$ROOT/apps/dashboard/dist" "$STAGING/apps/dashboard/dist"
cp -R "$ROOT/skills" "$STAGING/skills"
cp -R "$ROOT/src/data/drizzle" "$STAGING/src/data/drizzle"
cp -R "$ROOT/src/prompts" "$STAGING/src/prompts"
chmod +x "$STAGING/dist/luna-service.js"

cat > "$STAGING/README.md" <<EOF
# $PACKAGE_NAME

Luna Service runtime package.

This package installs the \`luna-service\` command for deploying and managing
Luna Service. It intentionally does not install the \`luna\` client command; use
\`@luna-agent/client\` for client-side workflows.

## Install

\`\`\`bash
npm install -g $PACKAGE_NAME @luna-agent/client
\`\`\`

## Commands

\`\`\`bash
luna service start --port 9000 --home ~/.luna
luna service status
luna service restart
luna service stop
\`\`\`
EOF

cat > "$STAGING/package.json" <<JSON
{
  "name": "$PACKAGE_NAME",
  "version": "$VERSION",
  "description": "Luna Service runtime",
  "type": "module",
  "bin": {
    "luna-service": "dist/luna-service.js"
  },
  "files": [
    "dist/index.js",
    "dist/luna-service.js",
    "apps/dashboard/dist/**",
    "skills/**",
    "src/data/drizzle/**",
    "src/prompts/**",
    "README.md"
  ],
  "engines": {
    "bun": ">=1.2.0"
  }
}
JSON

mkdir -p "$PACK_DIR"
echo "Packing npm tarball..."
PACKAGE_TARBALL="$(npm pack "$STAGING" --pack-destination "$PACK_DIR" | tail -n 1)"
echo
echo "Created: $PACK_DIR/$PACKAGE_TARBALL"
echo
echo "Install locally or on a server with:"
echo "  npm install -g $PACK_DIR/$PACKAGE_TARBALL"
