/** Trims whitespace and invisible format characters (zero-width spaces and joiners, BOM) providers leave around names. */
export function cleanDisplayName(value: string | null | undefined): string | undefined {
  const name = value?.replace(/^[\s\u200B-\u200F\u2060\uFEFF]+|[\s\u200B-\u200F\u2060\uFEFF]+$/gu, "");
  return name ? name : undefined;
}

export function usableDisplayName(value: string | null | undefined, ids: ReadonlySet<string>): string | undefined {
  const name = value?.trim().replace(/^@\s*/, "").trim();
  if (!name || ids.has(name) || /^(?:ou_|on_|oc_|cli_|unknown(?:\b|_)|user[_:-])/i.test(name)) return undefined;
  return name;
}

