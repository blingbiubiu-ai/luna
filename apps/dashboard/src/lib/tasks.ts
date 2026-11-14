const activeTaskStatuses = new Set(["running"]);

export function isActiveTaskStatus(status: string): boolean {
  return activeTaskStatuses.has(status);
}
