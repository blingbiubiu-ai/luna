import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type WorkerImageVariant = "general" | "developer";

export interface WorkerImageRelease {
  variant: WorkerImageVariant;
  label: string;
  image: string;
  digest: string | null;
}

export interface WorkerReleaseManifest {
  worker: {
    available: boolean;
    version: string | null;
    sha256: string | null;
    size: number;
    downloadPath: string;
  };
  images: Record<WorkerImageVariant, WorkerImageRelease>;
}

const DEFAULT_GENERAL_IMAGE = "hub.byted.org/wukong_devbox/luna-runner:latest";
const DEFAULT_DEVELOPER_IMAGE = "hub.byted.org/wukong_devbox/luna-runner-developer:latest";

let cachedBundle: { path: string; mtimeMs: number; size: number; sha256: string; content: Buffer } | undefined;

export function resolveWorkerBundlePath(env: Record<string, string | undefined> = process.env): string | undefined {
  const candidates: string[] = [];
  if (env.LUNA_WORKER_BUNDLE_PATH) candidates.push(resolve(env.LUNA_WORKER_BUNDLE_PATH));
  if (process.argv[1]) candidates.push(join(dirname(resolve(process.argv[1])), "luna-worker.js"));
  candidates.push(join(process.cwd(), "dist", "luna-worker.js"));
  candidates.push(join(process.cwd(), "apps", "worker", "dist", "luna-worker.js"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore unreadable path
      }
    }
  }
  return undefined;
}

export function readWorkerBundle(
  env: Record<string, string | undefined> = process.env,
): { content: Buffer; sha256: string; version: string; size: number } | undefined {
  const path = resolveWorkerBundlePath(env);
  if (!path) return undefined;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (cachedBundle && cachedBundle.path === path && cachedBundle.mtimeMs === stat.mtimeMs && cachedBundle.size === stat.size) {
    return {
      content: cachedBundle.content,
      sha256: cachedBundle.sha256,
      version: cachedBundle.sha256.slice(0, 12),
      size: cachedBundle.size,
    };
  }
  const content = readFileSync(path);
  const sha256 = createHash("sha256").update(content).digest("hex");
  cachedBundle = { path, mtimeMs: stat.mtimeMs, size: content.byteLength, sha256, content };
  return { content, sha256, version: sha256.slice(0, 12), size: content.byteLength };
}

function normalizeDigest(raw?: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const atIndex = trimmed.lastIndexOf("@");
  const candidate = atIndex >= 0 ? trimmed.slice(atIndex + 1) : trimmed;
  return /^sha256:[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null;
}

export function getWorkerReleaseManifest(
  env: Record<string, string | undefined> = process.env,
): WorkerReleaseManifest {
  const bundle = readWorkerBundle(env);
  const generalImage = env.LUNA_WORKER_IMAGE_GENERAL?.trim() || DEFAULT_GENERAL_IMAGE;
  const developerImage = env.LUNA_WORKER_IMAGE_DEVELOPER?.trim() || DEFAULT_DEVELOPER_IMAGE;
  const generalDigest = normalizeDigest(env.LUNA_WORKER_IMAGE_GENERAL_DIGEST);
  const developerDigest = normalizeDigest(env.LUNA_WORKER_IMAGE_DEVELOPER_DIGEST);
  return {
    worker: {
      available: Boolean(bundle),
      version: bundle?.version ?? null,
      sha256: bundle?.sha256 ?? null,
      size: bundle?.size ?? 0,
      downloadPath: "/api/worker/release/luna-worker.js",
    },
    images: {
      general: {
        variant: "general",
        label: "通用版 (General)",
        image: generalImage,
        digest: generalDigest,
      },
      developer: {
        variant: "developer",
        label: "开发版 (Developer)",
        image: developerImage,
        digest: developerDigest,
      },
    },
  };
}

export function renderWorkerInstallScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

SERVICE=""
CODE=""
VARIANT="general"
IMAGE=""
WORKER_HOME="\${LUNA_WORKER_HOME:-\$HOME/.luna-worker}"
PORT="8092"
INSTALL_SERVICE="1"

usage() {
  cat <<'EOF'
Luna Worker 一键部署脚本

用法:
  install.sh --service <URL> [--code <BIND_CODE>] [--variant general|developer] [--image <IMAGE>] [--home <DIR>] [--port <PORT>] [--no-service]
EOF
}

log() {
  printf '[luna-worker] %s\\n' "$*"
}

fail() {
  printf '[luna-worker] ERROR: %s\\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="\${2:-}"; shift 2 ;;
    --code) CODE="\${2:-}"; shift 2 ;;
    --variant) VARIANT="\${2:-}"; shift 2 ;;
    --image) IMAGE="\${2:-}"; shift 2 ;;
    --home) WORKER_HOME="\${2:-}"; shift 2 ;;
    --port) PORT="\${2:-}"; shift 2 ;;
    --no-service) INSTALL_SERVICE="0"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数: $1" ;;
  esac
done

[[ -n "$SERVICE" ]] || fail "必须指定 --service <URL>"
SERVICE="\${SERVICE%/}"
if [[ "$VARIANT" != "general" && "$VARIANT" != "developer" ]]; then
  fail "--variant 仅支持 general 或 developer，当前为: $VARIANT"
fi

log "检查运行环境 (Docker / Bun)..."
command -v curl >/dev/null 2>&1 || fail "未找到 curl，请先安装 curl"
command -v docker >/dev/null 2>&1 || fail "未找到 docker，请先安装 Docker 并确保当前用户有权访问 Docker"
docker info >/dev/null 2>&1 || fail "无法连接 Docker daemon，请确认 Docker 已启动且当前用户有权限执行 docker 命令"

BUN_BIN=""
if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
elif [[ -x "\$HOME/.bun/bin/bun" ]]; then
  BUN_BIN="\$HOME/.bun/bin/bun"
else
  log "未检测到 Bun，正在自动安装 Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="\$HOME/.bun/bin:\$PATH"
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  elif [[ -x "\$HOME/.bun/bin/bun" ]]; then
    BUN_BIN="\$HOME/.bun/bin/bun"
  else
    fail "Bun 安装后未在 PATH 中找到，请手动安装 Bun >= 1.3.11 后重试"
  fi
fi
log "使用 Bun: $BUN_BIN ($("$BUN_BIN" --version))"

log "从 $SERVICE 获取 Worker 发布清单..."
MANIFEST_JSON="$(curl -fsSL "$SERVICE/api/worker/release/manifest.json")" || fail "无法访问 $SERVICE/api/worker/release/manifest.json"

WORKER_META="$(MANIFEST="$MANIFEST_JSON" VARIANT="$VARIANT" "$BUN_BIN" -e '
const m = JSON.parse(process.env.MANIFEST || "{}");
const v = process.env.VARIANT || "general";
if (!m.worker?.available || !m.worker?.sha256 || !m.worker?.version) {
  console.error("Service 未提供可用的 luna-worker.js 发布产物");
  process.exit(1);
}
const img = m.images?.[v]?.image || "";
console.log([m.worker.version, m.worker.sha256, m.worker.downloadPath || "/api/worker/release/luna-worker.js", img].join("\\t"));
')" || fail "解析发布清单失败"

IFS=$'\\t' read -r WORKER_VERSION WORKER_SHA256 WORKER_DOWNLOAD_PATH MANIFEST_IMAGE <<< "$WORKER_META"
if [[ -z "$IMAGE" ]]; then
  IMAGE="$MANIFEST_IMAGE"
fi
[[ -n "$IMAGE" ]] || fail "未解析到目标镜像地址，请通过 --image 指定"

log "拉取容器镜像: $IMAGE ..."
if ! docker pull "$IMAGE"; then
  fail "拉取镜像失败: $IMAGE。如果是私有镜像仓库，请先执行 docker login 后重新运行本脚本。"
fi

BIN_DIR="$WORKER_HOME/bin"
RELEASES_DIR="$BIN_DIR/releases"
LOGS_DIR="$WORKER_HOME/logs"
mkdir -p "$RELEASES_DIR" "$LOGS_DIR"

TARGET_DIR="$RELEASES_DIR/$WORKER_VERSION"
TARGET_JS="$TARGET_DIR/luna-worker.js"
if [[ ! -f "$TARGET_JS" ]]; then
  STAGING="$BIN_DIR/.staging-$$.js"
  trap 'rm -f "$STAGING"' EXIT
  log "下载 Worker 程序 ($WORKER_VERSION)..."
  curl -fsSL "$SERVICE$WORKER_DOWNLOAD_PATH" -o "$STAGING" || fail "下载 $SERVICE$WORKER_DOWNLOAD_PATH 失败"
  ACTUAL_SHA="$(STAGING="$STAGING" "$BUN_BIN" -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
console.log(createHash("sha256").update(readFileSync(process.env.STAGING)).digest("hex"));
')"
  [[ "$ACTUAL_SHA" == "$WORKER_SHA256" ]] || fail "SHA-256 校验失败: 期望 $WORKER_SHA256 实际 $ACTUAL_SHA"
  mkdir -p "$TARGET_DIR"
  mv "$STAGING" "$TARGET_JS"
  chmod 0755 "$TARGET_JS"
  trap - EXIT
fi

if [[ -L "$BIN_DIR/current" ]]; then
  PREV_TARGET="$(readlink "$BIN_DIR/current")"
  if [[ "$PREV_TARGET" != "releases/$WORKER_VERSION" ]]; then
    ln -sfn "$PREV_TARGET" "$BIN_DIR/previous"
  fi
fi
ln -sfn "releases/$WORKER_VERSION" "$BIN_DIR/current"

cat > "$BIN_DIR/luna-worker" <<EOF
#!/usr/bin/env bash
exec "$BUN_BIN" "$BIN_DIR/current/luna-worker.js" "\\$@"
EOF
chmod 0755 "$BIN_DIR/luna-worker"

cat > "$BIN_DIR/luna-worker-run.sh" <<EOF
#!/usr/bin/env bash
set -u
export LUNA_WORKER_HOME="$WORKER_HOME"
export LUNA_WORKER_MANAGED="1"
export PATH="$(dirname "$BUN_BIN"):/usr/local/bin:/usr/bin:/bin:\\$PATH"
FAIL_FILE="$BIN_DIR/.quick-fail-count"
START_TS="\\$(date +%s)"
"$BUN_BIN" "$BIN_DIR/current/luna-worker.js" start --home "$WORKER_HOME"
EXIT_CODE="\\$?"
END_TS="\\$(date +%s)"
ELAPSED="\\$((END_TS - START_TS))"
if [[ "\\$EXIT_CODE" -ne 0 && "\\$ELAPSED" -lt 15 && -L "$BIN_DIR/previous" ]]; then
  COUNT=0
  [[ -f "\\$FAIL_FILE" ]] && COUNT="\\$(cat "\\$FAIL_FILE" 2>/dev/null || echo 0)"
  COUNT="\\$((COUNT + 1))"
  echo "\\$COUNT" > "\\$FAIL_FILE"
  if [[ "\\$COUNT" -ge 2 ]]; then
    PREV="\\$(readlink "$BIN_DIR/previous")"
    echo "[luna-worker] 新版本启动连续失败，自动回滚到 \\$PREV" >&2
    ln -sfn "\\$PREV" "$BIN_DIR/current"
    rm -f "\\$FAIL_FILE"
  fi
else
  rm -f "\\$FAIL_FILE"
fi
exit "\\$EXIT_CODE"
EOF
chmod 0755 "$BIN_DIR/luna-worker-run.sh"

if [[ ! -f "$WORKER_HOME/worker.json" ]]; then
  log "初始化 Worker 配置..."
  INIT_ARGS=(init --home "$WORKER_HOME" --image "$IMAGE" --port "$PORT")
  if [[ "$IMAGE" == "$MANIFEST_IMAGE" ]]; then
    INIT_ARGS+=(--variant "$VARIANT")
  fi
  "$BIN_DIR/luna-worker" "\${INIT_ARGS[@]}"
else
  log "检测到已有 $WORKER_HOME/worker.json，保留本地配置。"
fi

if [[ -n "$CODE" ]]; then
  log "绑定 Worker 到 $SERVICE ..."
  LUNA_WORKER_BIND_CODE="$CODE" "$BIN_DIR/luna-worker" bind --home "$WORKER_HOME" --service "$SERVICE"
elif [[ ! -f "$WORKER_HOME/binding.json" ]]; then
  fail "未提供 --code 且不存在 $WORKER_HOME/binding.json，请在 Luna 控制台生成绑定码后重试"
fi

if [[ "$INSTALL_SERVICE" == "1" ]]; then
  OS="$(uname -s)"
  if [[ "$OS" == "Darwin" ]]; then
    PLIST_DIR="\$HOME/Library/LaunchAgents"
    mkdir -p "$PLIST_DIR"
    LABEL="com.luna.worker"
    PLIST_PATH="$PLIST_DIR/\$LABEL.plist"
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>\$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_DIR/luna-worker-run.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOGS_DIR/worker.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGS_DIR/worker.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LUNA_WORKER_HOME</key>
    <string>$WORKER_HOME</string>
    <key>LUNA_WORKER_MANAGED</key>
    <string>1</string>
  </dict>
</dict>
</plist>
EOF
    log "注册并启动 macOS LaunchAgent (\$LABEL)..."
    launchctl bootout "gui/$(id -u)/\$LABEL" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1; then
      launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
      launchctl load -w "$PLIST_PATH"
    fi
  elif [[ "$OS" == "Linux" ]]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
      UNIT_DIR="\$HOME/.config/systemd/user"
      mkdir -p "$UNIT_DIR"
      cat > "$UNIT_DIR/luna-worker.service" <<EOF
[Unit]
Description=Luna Docker Worker
After=network-online.target docker.service

[Service]
Type=simple
Environment=LUNA_WORKER_HOME=$WORKER_HOME
Environment=LUNA_WORKER_MANAGED=1
ExecStart=$BIN_DIR/luna-worker-run.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
      log "注册并启动 systemd 用户服务 (luna-worker.service)..."
      systemctl --user daemon-reload
      systemctl --user enable --now luna-worker.service
      systemctl --user restart luna-worker.service
    elif command -v systemctl >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
      cat > "/etc/systemd/system/luna-worker.service" <<EOF
[Unit]
Description=Luna Docker Worker
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Environment=LUNA_WORKER_HOME=$WORKER_HOME
Environment=LUNA_WORKER_MANAGED=1
ExecStart=$BIN_DIR/luna-worker-run.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
      log "注册并启动 systemd 系统服务 (luna-worker.service)..."
      systemctl daemon-reload
      systemctl enable --now luna-worker.service
      systemctl restart luna-worker.service
    else
      log "未检测到可用的 systemd，改为后台进程启动..."
      nohup "$BIN_DIR/luna-worker-run.sh" >> "$LOGS_DIR/worker.log" 2>&1 &
    fi
  else
    log "后台启动 Worker..."
    nohup "$BIN_DIR/luna-worker-run.sh" >> "$LOGS_DIR/worker.log" 2>&1 &
  fi

  log "等待 Worker 就绪..."
  READY="0"
  for _ in $(seq 1 20); do
    if "$BIN_DIR/luna-worker" status --home "$WORKER_HOME" >/dev/null 2>&1; then
      READY="1"
      break
    fi
    sleep 1
  done
  if [[ "$READY" == "1" ]]; then
    log "部署完成！Worker 已启动并就绪。"
    log "  版本: $WORKER_VERSION"
    log "  镜像: $IMAGE"
    log "  目录: $WORKER_HOME"
    log "  日志: $LOGS_DIR/worker.log"
  else
    log "Worker 已启动，但暂未通过本地健康检查。请查看日志: $LOGS_DIR/worker.log"
  fi
else
  log "初始化与绑定完成（已跳过服务注册）。启动命令: $BIN_DIR/luna-worker-run.sh"
fi
`;
}
