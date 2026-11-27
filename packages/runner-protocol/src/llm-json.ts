const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/**
 * Unwraps a single outer Markdown code fence (```json ... ``` or ~~~json ... ~~~).
 * Returns `undefined` when the input is not wrapped in a single code fence.
 */
export function unwrapSingleCodeFence(text: string): string | undefined {
  const trimmed = text.trim();
  const match =
    /^(`{3,}|~{3,})(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)\r?\n\1$/i.exec(trimmed) ??
    /^(`{3,}|~{3,})(?:json|jsonc)?[ \t]*(\{[\s\S]*\}|\[[\s\S]*\])[ \t]*\1$/i.exec(trimmed);
  return match?.[2]?.trim();
}

/**
 * Repairs common LLM-generated JSON syntax mistakes without altering valid JSON:
 * - strips UTF-8 BOM and surrounding whitespace
 * - unwraps a single outer Markdown code fence (```json ... ```)
 * - escapes raw control characters (\n, \r, \t, <0x20) inside string literals
 * - repairs invalid backslash escapes inside string literals (e.g. \' or \a)
 * - strips trailing commas immediately before `}` or `]`
 */
export function sanitizeLlmJson(text: string): string {
  const stripped = text.replace(/^\uFEFF/, "").trim();
  const source = unwrapSingleCodeFence(stripped) ?? stripped;

  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        if (SIMPLE_ESCAPES.has(ch)) {
          out += `\\${ch}`;
        } else if (ch === "u" && HEX4.test(source.slice(i + 1, i + 5))) {
          out += "\\u";
        } else if (ch === "'") {
          out += "'";
        } else if (ch === "\n") {
          out += "\\n";
        } else if (ch === "\r") {
          out += "\\r";
        } else {
          out += `\\\\${ch}`;
        }
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }

      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }

      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let next = i + 1;
      while (next < source.length && /\s/.test(source[next]!)) next++;
      if (source[next] === "}" || source[next] === "]") {
        continue;
      }
    }

    out += ch;
  }

  if (escaped) {
    out += "\\\\";
  }

  return out;
}

/**
 * Parses JSON produced by an LLM with a strict fast-path and targeted fallback repair.
 */
export function parseLlmJson(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    // Fall through to fence unwrapping and structural repair.
  }

  const unwrapped = unwrapSingleCodeFence(stripped);
  if (unwrapped) {
    try {
      return JSON.parse(unwrapped) as unknown;
    } catch {
      // Fall through to sanitizer.
    }
  }

  return JSON.parse(sanitizeLlmJson(stripped)) as unknown;
}

/**
 * Non-throwing variant of `parseLlmJson`.
 */
export function tryParseLlmJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return parseLlmJson(text);
  } catch {
    return undefined;
  }
}
