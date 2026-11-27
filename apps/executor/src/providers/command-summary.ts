/** Semantic Chinese summaries for shell commands that lack a structured description. */

const SKIP_PREFIX_BINS = new Set(["cd", "set", "export", "umask", "true", "mkdir"]);

export function redactText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]")
    .replace(/((?:[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)["']?\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s&;"']+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

export function sanitizeSubject(text: string, maxLen = 80): string {
  const subject = redactText(text);
  return subject.length > maxLen ? `${subject.slice(0, maxLen)}…` : subject;
}

export function shortPath(raw: string): string {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "").replace(/[\\/]+$/, "");
  if (!trimmed) return raw.trim();
  const base = trimmed.split(/[\\/]/).pop();
  return base || trimmed;
}

function cleanCommand(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-[a-z]*c\s+(['"])([\s\S]+)\1$/.exec(trimmed);
  return wrapped ? wrapped[2]!.trim() : trimmed;
}

function splitShellSegments(cmd: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && cmd[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === ";" || (ch === "&" && cmd[i + 1] === "&")) {
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
      if (ch === "&") i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segments.push(cur.trim());
  return segments;
}

function stripDisplayPipe(segment: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote && segment[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "|" && segment[i + 1] !== "|") {
      return segment.slice(0, i).trim();
    }
  }
  return segment.trim();
}

function tokenizeSimple(segment: string): string[] {
  const tokens: string[] = [];
  const cleaned = segment
    .replace(/\s+\d*>&\d+/g, "")
    .replace(/\s+\d*>>?\s*(?:'[^']*'|"[^"]*"|\S+)/g, "");
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

function stripLeadingWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (t === "env" || t === "command" || t === "time") { i++; continue; }
    if (t === "sudo") {
      i++;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        if (tokens[i] === "-u" || tokens[i] === "-g") i += 2;
        else i++;
      }
      continue;
    }
    if (t === "timeout") {
      i++;
      while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
      if (i < tokens.length) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

export function summarizeCommand(raw: string): string {
  const unwrapped = cleanCommand(redactText(raw));
  if (!unwrapped) return "执行命令";

  if (/^(?:for|while|until|if|case)\s/.test(unwrapped)) {
    if (/\bbytedcli\b/.test(unwrapped)) return "批量查询 bytedcli";
    if (/\blark-cli\b/.test(unwrapped)) return "批量操作飞书";
    if (/\badb\b/.test(unwrapped)) return "批量执行 adb 调试";
    if (/\bgit\b/.test(unwrapped)) return "批量执行 git 操作";
    return "运行脚本";
  }

  const segments = splitShellSegments(unwrapped);
  let tokens: string[] = [];
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = stripDisplayPipe(segments[idx]!);
    const candidate = stripLeadingWrappers(tokenizeSimple(seg));
    if (!candidate.length) continue;
    const bin = shortPath(candidate[0]!);
    if (idx < segments.length - 1 && (SKIP_PREFIX_BINS.has(bin) || bin === "echo")) continue;
    tokens = candidate;
    break;
  }
  if (!tokens.length) return "执行命令";

  const bin = shortPath(tokens[0]!).toLowerCase();
  const args = tokens.slice(1);
  const nonFlagArgs = args.filter(a => a && !a.startsWith("-"));
  const sub = (nonFlagArgs[0] ?? "").toLowerCase();
  const sub2 = (nonFlagArgs[1] ?? "").toLowerCase();
  const joinedLower = args.join(" ").toLowerCase();

  // File viewing
  if (["cat", "sed", "head", "tail", "nl", "less", "more", "wc", "bat"].includes(bin)) {
    const fileArg = [...nonFlagArgs].reverse().find(a => /[./\\]/.test(a) && !/^\d+(,\d+)?p?$/.test(a));
    return fileArg ? sanitizeSubject(`查看 ${shortPath(fileArg)}`, 36) : "查看文件";
  }
  // Search & directory listing
  if (["rg", "grep", "egrep", "fgrep", "ag"].includes(bin)) {
    const pattern = nonFlagArgs[0];
    return pattern && pattern.length <= 24 && !pattern.includes("/") ? sanitizeSubject(`搜索 ${pattern}`, 36) : "搜索代码";
  }
  if (["find", "fd"].includes(bin)) return "查找文件";
  if (["ls", "tree", "pwd"].includes(bin)) return "查看目录";

  // Git
  if (bin === "git") {
    const gitMap: Record<string, string> = {
      status: "查看 git 状态",
      diff: "查看代码变更",
      log: "查看提交记录",
      show: "查看提交详情",
      commit: "提交代码",
      push: "推送分支",
      pull: "拉取代码",
      fetch: "拉取远端更新",
      checkout: "切换分支",
      switch: "切换分支",
      branch: "查看分支",
      add: "暂存代码改动",
      merge: "合并代码",
      rebase: "变基代码",
      stash: "暂存工作区",
      clone: "克隆仓库",
      "rev-parse": "查看 git 信息",
      worktree: "管理 git worktree",
    };
    return gitMap[sub] ?? (sub ? sanitizeSubject(`执行 git ${sub}`, 36) : "执行 git 命令");
  }

  // Build & test
  if (["gradlew", "gradle", "cmake", "ninja", "make", "bazel", "buck"].includes(bin)) {
    return /\btest\b/.test(joinedLower) ? "运行测试" : "执行构建";
  }
  if (["bun", "npm", "pnpm", "yarn"].includes(bin)) {
    if (sub === "test" || (sub === "run" && sub2 === "test")) return "运行测试";
    if (sub === "build" || (sub === "run" && sub2 === "build")) return "执行构建";
    if (sub === "typecheck" || (sub === "run" && sub2 === "typecheck")) return "执行类型检查";
    if (sub === "install" || sub === "add" || sub === "ci") return "安装依赖";
    if (args.includes("-e") || args.includes("--eval")) return "运行脚本";
  }
  if (["pytest", "jest", "vitest"].includes(bin)) return "运行测试";
  if (bin === "tsc") return "执行类型检查";
  if (bin === "cargo" || bin === "go") {
    if (sub === "test") return "运行测试";
    if (sub === "build") return "执行构建";
  }

  // Luna CLI
  if (bin === "luna") {
    if (sub === "say") return "汇报任务进展";
    if (sub === "ask") return "向主会话提问";
    if (sub === "tasks" && sub2 === "pause") return "暂停等待任务";
    if (sub === "tasks" && sub2 === "report") return "提交任务报告";
    if (sub === "tasks") return "更新任务状态";
    return sub ? sanitizeSubject(`执行 luna ${sub}`, 36) : "执行 luna 命令";
  }

  // Internal & Feishu CLIs
  if (bin === "bytedcli") {
    if (sub === "codebase") {
      if (joinedLower.includes("reviewer")) return "查询 MR 评审";
      if (joinedLower.includes("check")) return "查询 MR 检查";
      if (sub2 === "mr" && joinedLower.includes("create")) return "创建 MR";
      if (sub2 === "mr") return "查询 MR 信息";
      return "查询代码库";
    }
    if (sub === "bits") {
      if (joinedLower.includes("pipeline")) return "查询 Bits 流水线";
      if (joinedLower.includes("component") || joinedLower.includes("build")) return "查询 Bits 构建";
      if (joinedLower.includes("job") || joinedLower.includes("workflow")) return "查询 Bits 任务";
      return "查询 Bits";
    }
    if (sub === "meego") return "查询 Meego 需求";
    if (sub === "auth") return "检查登录状态";
    return sub ? sanitizeSubject(`调用 bytedcli ${sub}`, 36) : "调用 bytedcli";
  }
  if (bin === "lark-cli") {
    if (sub === "im") return "读取飞书消息";
    if (["doc", "docx", "wiki", "drive"].includes(sub)) return "操作飞书文档";
    return "调用飞书 CLI";
  }
  if (bin === "adb") return "执行 adb 调试";
  if (bin === "ccli") return "查询组件平台";

  // Network
  if (bin === "curl" || bin === "wget") {
    const url = args.find(a => /^https?:\/\//i.test(a));
    if (url) {
      try { return sanitizeSubject(`请求接口 ${new URL(url).hostname}`, 36); } catch {}
    }
    return "发起网络请求";
  }

  // Scripts & processes
  if (["python", "python3", "node", "sh", "bash", "zsh"].includes(bin)) {
    const script = nonFlagArgs.find(a => /\.(py|js|ts|mjs|sh)$/i.test(a));
    return script ? sanitizeSubject(`运行 ${shortPath(script)}`, 36) : "运行脚本";
  }
  if (["ps", "lsof", "ss", "netstat", "pgrep"].includes(bin)) return "检查进程状态";
  if (["cp", "mv", "rm", "chmod", "chown", "ln", "tar", "unzip", "zip", "touch"].includes(bin)) return "处理文件";

  // Concise fallback
  const shortArgs: string[] = [];
  for (let i = 0; i < args.length && shortArgs.length < 2; i++) {
    const a = args[i]!;
    if (!a || a.startsWith("-")) {
      if (a.startsWith("--") && !a.includes("=") && args[i + 1] && !args[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (a === "[redacted]") continue;
    const item = a.includes("/") ? shortPath(a) : a;
    if (item && item.length <= 20) shortArgs.push(item);
  }
  const summary = shortArgs.length ? `执行 ${bin} ${shortArgs.join(" ")}` : `执行 ${bin}`;
  return sanitizeSubject(summary, 36);
}
