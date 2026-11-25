import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUN_LUNA_TASK_HOOK =
  'if [ -f /opt/luna-runtime/current/luna-client.js ]; then bun /opt/luna-runtime/current/luna-client.js internal task-hook "$1"; elif command -v luna >/dev/null 2>&1; then luna internal task-hook "$1"; fi';

export const TASK_POST_TOOL_HOOK_CMD =
  `/bin/sh -c 'if OUT=$(${RUN_LUNA_TASK_HOOK} 2>/dev/null) && [ -n "$OUT" ]; then printf "%s\\n" "$OUT"; fi; true' sh post-tool`;

export const TASK_STOP_HOOK_CMD =
  `/bin/sh -c 'if OUT=$(${RUN_LUNA_TASK_HOOK} 2>/dev/null) && [ -n "$OUT" ]; then printf "%s\\n" "$OUT"; fi; true' sh stop`;

function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Combined Claude PTY Stop hook: runs `luna internal task-hook stop` first;
 * if it emits a `{"decision":"block",...}` payload, outputs it to stdout so Claude
 * continues working without notifying the PTY idle detector of turn completion.
 */
export function buildClaudePtyStopHookCommand(hookEventsFile: string): string {
  return `/bin/sh -c 'if OUT=$(${RUN_LUNA_TASK_HOOK} 2>/dev/null) && [ -n "$OUT" ]; then printf "%s\\n" "$OUT"; else printf "{\\"event\\":\\"Stop\\"}\\n" >> "$2"; fi' sh stop ${shellEscapeSingle(hookEventsFile)}`;
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
