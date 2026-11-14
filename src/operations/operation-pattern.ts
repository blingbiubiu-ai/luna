/** A trailing .* includes the prefix itself and every dot-delimited descendant. */
export function isOperationPattern(value: string): boolean {
  return /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.\*$/.test(value);
}

export function matchesOperation(pattern: string, operationId: string): boolean {
  if (pattern === operationId) return true;
  if (!isOperationPattern(pattern)) return false;
  const prefix = pattern.slice(0, -2);
  return operationId === prefix || operationId.startsWith(`${prefix}.`);
}
