set -eu
mkdir -p "$HOME/.luna-bin" "$LUNA_RUNNER_HOME"
cat > "$HOME/.luna-bin/codex" <<'CLI'
#!/bin/sh
set -eu
test "$npm_config_prefix" = "$HOME/.npm-global"
test "$GRADLE_USER_HOME" = "$HOME/.gradle"
test "$KONAN_DATA_DIR" = "$HOME/.konan"
test "$ANDROID_USER_HOME" = "$HOME/.android"
test -x "$HOME/.remoteX/fswatch/linux-amd64/fswatch"
for zip in "$GRADLE_USER_HOME"/wrapper/dists/*/*/*.zip; do test -s "$zip"; done
test "$(git config --get safe.directory)" = '*'
mkdir -p "$HOME/pkg"
printf '{"name":"luna-init-test","version":"1.0.0","bin":{"luna-init-test":"cli.js"}}' > "$HOME/pkg/package.json"
printf '#!/usr/bin/env node\nconsole.log("npm-global-ok")\n' > "$HOME/pkg/cli.js"
chmod +x "$HOME/pkg/cli.js"
npm install -g --ignore-scripts --no-audit --no-fund "$HOME/pkg" 
test "$(luna-init-test)" = npm-global-ok
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"runner-initialization-ok"}}'
printf '%s\n' '{"type":"turn.completed"}'
CLI
chmod +x "$HOME/.luna-bin/codex"
cd "$LUNA_RUNNER_HOME"
printf '%s\n' '{"runnerType":"codex","prompt":"verify"}' | bun /app/agent-runner/dist/job-main.js


