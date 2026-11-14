export function usableDisplayName(value: string | null | undefined, ids: ReadonlySet<string>): string | undefined {
  const name = value?.trim().replace(/^@\s*/, "").trim();
  if (!name || ids.has(name) || /^(?:ou_|on_|oc_|cli_|unknown(?:\b|_)|user[_:-])/i.test(name)) return undefined;
  return name;
}

