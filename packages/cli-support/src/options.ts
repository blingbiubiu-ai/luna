import { readFileSync } from "node:fs";

export function workspaceWriteBody(
  path: string,
  argv: readonly string[],
  commandLabel: string,
): Record<string, unknown> {
  if (readOption(argv, "--message") !== undefined) {
    throw new Error(`${commandLabel} write does not commit; use ${commandLabel} git-commit --message instead`);
  }
  return {
    path,
    content: readKnowledgeWriteBody(argv),
  };
}

export function readKnowledgeWriteBody(argv: readonly string[]): string {
  const inlineBody = readOption(argv, "--body");
  const bodyFile = readOption(argv, "--body-file");
  if (inlineBody !== undefined && bodyFile !== undefined) {
    throw new Error("use either --body or --body-file, not both");
  }
  if (inlineBody !== undefined) {
    return inlineBody;
  }
  if (bodyFile !== undefined) {
    return readFileSync(bodyFile, "utf8");
  }
  throw new Error("missing value for --body");
}

export function readRelativeTimeWindow(
  argv: readonly string[],
  options: { defaultDuration?: string } = {},
): { start_time?: string; end_time?: string } {
  let startTime = readOption(argv, "--start-time");
  let endTime = readOption(argv, "--end-time");
  const duration = readOption(argv, "--last") ?? readOption(argv, "--since") ?? options.defaultDuration;
  if (duration !== undefined && (startTime === undefined || endTime === undefined)) {
    const end = Math.floor(Date.now() / 1000);
    startTime = String(end - parseDurationSeconds(duration));
    endTime = String(end);
  }
  return bodyWithDefinedValues({
    start_time: startTime,
    end_time: endTime,
  }) as { start_time?: string; end_time?: string };
}

export function parseDurationSeconds(value: string): number {
  const match = value.trim().match(/^(\d+)([smhd])?$/);
  if (!match) {
    throw new Error(`invalid --last duration: ${value}`);
  }
  const amount = Number(match[1]);
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  };
  const unit = match[2] ?? "s";
  const multiplier = multipliers[unit];
  if (multiplier === undefined) {
    throw new Error(`invalid --last duration: ${value}`);
  }
  return amount * multiplier;
}

export function bodyWithDefinedValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readIdentityOption(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function readEnvList(value: string | undefined): readonly string[] {
  return readList(value ?? "");
}

export function readList(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function readPositional(argv: readonly string[], index: number, name: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

export function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

export function readRequiredOption(argv: readonly string[], name: string): string {
  const value = readOption(argv, name);
  if (value === undefined) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

export function readOptionIfPresent(
  argv: readonly string[],
  name: string,
): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}
