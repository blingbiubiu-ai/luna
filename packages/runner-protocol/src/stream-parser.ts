export const OUTPUT_START_MARKER = "---LUNA_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---LUNA_OUTPUT_END---";

export interface ParsedOutput {
  readonly status: string;
  readonly data: Record<string, unknown>;
}

export class StreamEventParser {
  private _buffer = "";
  private _insideMarker = false;

  feedLine(line: string): ParsedOutput[] {
    const trimmed = line.trim();

    if (trimmed === OUTPUT_START_MARKER) {
      this._insideMarker = true;
      this._buffer = "";
      return [];
    }

    if (trimmed === OUTPUT_END_MARKER) {
      this._insideMarker = false;
      const raw = this._buffer.trim();
      this._buffer = "";
      if (raw.length === 0) return [];
      try {
        const parsed = JSON.parse(raw);
        const { status, ...data } = parsed;
        return [{ status: status ?? "unknown", data }];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return [{
          status: "error",
          data: {
            error: `Malformed container protocol JSON: ${message}`,
          },
        }];
      }
    }

    if (this._insideMarker) {
      this._buffer += line + "\n";
    }

    return [];
  }
}
