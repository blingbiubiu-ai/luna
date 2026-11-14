#!/bin/bash
# Exercise Chrome under the same filesystem/user/capability limits as a runner.
set -euo pipefail
IMAGE="${1:-luna-runner:latest}"
docker run --rm --network none --read-only \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --memory 2g --cpus 1 --pids-limit 256 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  -e HOME=/tmp/luna-chrome-test --entrypoint /bin/sh "$IMAGE" -c '
    set -eu
    mkdir -p "$HOME"
    codex --version
    claude --version
    bun --version
    "$CHROME_BIN" --version
    fc-list :lang=zh family | grep -q "Noto"
    printf "<html><meta charset=utf-8><body><h1>中文浏览器验证</h1><script>document.body.dataset.result=\"luna-chrome-ok\"</script></body></html>" > "$HOME/test.html"
    timeout 45 "$CHROME_BIN" --headless --no-sandbox --disable-dev-shm-usage \
      --disable-gpu --no-first-run --no-default-browser-check \
      --user-data-dir="$HOME/profile" --dump-dom "file://$HOME/test.html" > "$HOME/result.html" 2> "$HOME/chrome.log" || { cat "$HOME/chrome.log"; exit 1; }
    grep -q "data-result=\"luna-chrome-ok\"" "$HOME/result.html"
    timeout 45 "$CHROME_BIN" --headless --no-sandbox --disable-dev-shm-usage \
      --disable-gpu --no-first-run --no-default-browser-check \
      --user-data-dir="$HOME/profile" --screenshot="$HOME/test.png" "file://$HOME/test.html" 2>> "$HOME/chrome.log" || { cat "$HOME/chrome.log"; exit 1; }
    test -s "$HOME/test.png"
    echo "Chrome JavaScript, CJK fonts and screenshot smoke checks passed"
  '
