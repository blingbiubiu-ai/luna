export function textStartsWithLeadingAlias(
  text: string,
  aliases: readonly string[],
): boolean {
  const normalizedText = text.trimStart().toLocaleLowerCase();
  return aliases.some((alias) => {
    const normalizedAlias = alias.trim().toLocaleLowerCase();
    if (
      normalizedAlias.length === 0 ||
      !normalizedText.startsWith(normalizedAlias)
    ) {
      return false;
    }
    const next = normalizedText.charAt(normalizedAlias.length);
    return next === "" || /[\s,:：，。！!]/u.test(next);
  });
}
