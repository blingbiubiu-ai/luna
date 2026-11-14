import {toolDisplay} from "@luna/runner-protocol/tool-display";

/** Derive a bounded public subject from existing structured tool input. */
export function toolSubject(input: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "CommandLine", "file_path", "path", "TargetFile", "AbsolutePath", "pattern", "query", "url", "Url", "skill", "subject", "toolAction", "toolSummary", "description", "prompt"]) {
    const value = input[key];
    const text = typeof value === "string" ? value : Array.isArray(value) && value.length > 0 ? String(value.at(-1) ?? "") : undefined;
    if (!text?.trim()) continue;
    // Only a known subject field is exported, never the whole input or result.
    let subject = text.replace(/\s+/g, " ").trim();
    subject = subject
      .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]")
      .replace(/((?:[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)["']?\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s&;"']+)/gi, "$1[redacted]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
    return subject.length > 80 ? `${subject.slice(0, 80)}…` : subject;
  }
  return "";
}

export function toolTitle(name: string, input: Record<string, unknown> = {}): string {
  const {label} = toolDisplay(name);
  const subject = toolSubject(input);
  return subject ? `${label} · ${subject}` : label;
}
export function toolResultText(failed: boolean): string {
  return failed ? "工具执行失败" : "工具调用已结束";
}
