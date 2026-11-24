import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TASK_POST_TOOL_HOOK_CMD =
  "/bin/sh -c 'command -v luna >/dev/null 2>&1 && luna internal task-hook post-tool || true'";

export const TASK_STOP_HOOK_CMD =
  "/bin/sh -c 'command -v luna >/dev/null 2>&1 && luna internal task-hook stop || true'";

function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Combined Claude PTY Stop hook: runs `luna internal task-hook stop` first;
 * if it emits a `{"decision":"block",...}` payload, outputs it to stdout so Claude
 * continues working without notifying the PTY idle detector of turn completion.
 */
export function buildClaudePtyStopHookCommand(hookEventsFile: string): string {
  return `/bin/sh -c 'OUT=$(command -v luna >/dev/null 2>&1 && luna internal task-hook stop || true); if [ -n "$OUT" ]; then printf "%s\\n" "$OUT"; else printf "{\\"event\\":\\"Stop\\"}\\n" >> "$1"; fi' sh ${shellEscapeSingle(hookEventsFile)}`;
}

export function writeClaudeSubprocessHookSettings(targetFile: string): string {
  const settings = {
    hooks: {
      PostToolUse: [
        {
          hooks: [{ type: "command", command: TASK_POST_TOOL_HOOK_CMD }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: TASK_STOP_HOOK_CMD }],
        },
      ],
    },
  };
  writeFileSync(targetFile, JSON.stringify(settings), { mode: 0o600 });
  return targetFile;
}

export function writeCodexHooksJson(codexConfigDir: string): string {
  mkdirSync(codexConfigDir, { recursive: true });
  const hooksFile = join(codexConfigDir, "hooks.json");
  const config = {
    hooks: {
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: TASK_POST_TOOL_HOOK_CMD,
              async: false,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: TASK_STOP_HOOK_CMD,
              async: false,
            },
          ],
        },
      ],
    },
  };
  writeFileSync(hooksFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  return hooksFile;
}
