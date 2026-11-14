export const OUTPUT_START_MARKER = "---LUNA_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---LUNA_OUTPUT_END---";

export function writeOutput(data: Record<string, unknown>): void {
  process.stdout.write(`${OUTPUT_START_MARKER}\n`);
  process.stdout.write(`${JSON.stringify(data)}\n`);
  process.stdout.write(`${OUTPUT_END_MARKER}\n`);
}
