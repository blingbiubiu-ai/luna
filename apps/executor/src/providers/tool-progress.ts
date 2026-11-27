import {toolDisplay} from "@luna/runner-protocol/tool-display";
import {sanitizeSubject, shortPath, summarizeCommand} from "./command-summary";

const DESCRIPTION_KEYS = ["description", "toolSummary", "toolAction", "subject"] as const;
const PATH_KEYS = ["file_path", "path", "TargetFile", "AbsolutePath"] as const;
const COMMAND_KEYS = ["command", "cmd", "CommandLine"] as const;
const SEARCH_KEYS = ["query", "pattern"] as const;
const URL_KEYS = ["url", "Url"] as const;
const FALLBACK_KEYS = [...DESCRIPTION_KEYS, "skill", ...SEARCH_KEYS, ...URL_KEYS, ...PATH_KEYS, ...COMMAND_KEYS, "prompt"] as const;

function pickField(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    const text = typeof value === "string" ? value : Array.isArray(value) && value.length > 0 ? String(value.at(-1) ?? "") : undefined;
    if (text?.trim()) return text;
  }
  return "";
}

/** Derive a bounded public subject from existing structured tool input. */
export function toolSubject(input: Record<string, unknown>): string {
  const raw = pickField(input, FALLBACK_KEYS);
  return raw ? sanitizeSubject(raw) : "";
}

export function toolTitle(name: string, input: Record<string, unknown> = {}): string {
  const {icon, label} = toolDisplay(name);
  const lower = name.toLowerCase();

  if (icon === "bash") {
    const desc = pickField(input, DESCRIPTION_KEYS);
    if (desc) return sanitizeSubject(desc);
    const cmd = pickField(input, COMMAND_KEYS);
    return cmd ? summarizeCommand(cmd) : label;
  }

  if (icon === "read") {
    const file = pickField(input, PATH_KEYS);
    if (file) return `读取 ${sanitizeSubject(shortPath(file))}`;
    const desc = pickField(input, DESCRIPTION_KEYS);
    return desc ? sanitizeSubject(desc) : label;
  }

  if (icon === "write") {
    const file = pickField(input, PATH_KEYS);
    if (file) {
      const verb = lower.includes("write") && !lower.includes("edit") && !lower.includes("patch") ? "写入" : "编辑";
      return `${verb} ${sanitizeSubject(shortPath(file))}`;
    }
    const desc = pickField(input, DESCRIPTION_KEYS);
    return desc ? sanitizeSubject(desc) : label;
  }

  if (icon === "search") {
    const desc = pickField(input, DESCRIPTION_KEYS);
    if (desc) return sanitizeSubject(desc);
    const query = pickField(input, SEARCH_KEYS);
    if (query) return `搜索 ${sanitizeSubject(query)}`;
    const url = pickField(input, URL_KEYS);
    if (url) return `访问 ${sanitizeSubject(url)}`;
    const file = pickField(input, PATH_KEYS);
    if (file) return `搜索 ${sanitizeSubject(shortPath(file))}`;
    return label;
  }

  if (icon === "task") {
    const desc = pickField(input, [...DESCRIPTION_KEYS, "prompt"]);
    return desc ? sanitizeSubject(desc) : label;
  }

  const desc = pickField(input, DESCRIPTION_KEYS);
  if (desc) return sanitizeSubject(desc);
  const skill = pickField(input, ["skill"]);
  if (skill) return `加载技能 ${sanitizeSubject(skill)}`;
  const subject = toolSubject(input);
  return subject ? `${label} ${subject}` : label;
}

export function toolResultText(failed: boolean): "工具执行失败" | "工具调用已结束" {
  return failed ? "工具执行失败" : "工具调用已结束";
}
