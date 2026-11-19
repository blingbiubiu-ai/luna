import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

export const DEFAULT_PTY_COLS = 160;
export const DEFAULT_PTY_ROWS = 50;

export function wrapBracketedPaste(content: string): string {
  return `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`;
}

/** Split UTF-8 text into chunks <= `maxBytes` without splitting multi-byte code points. */
export function chunkTextByUtf8Bytes(text: string, maxBytes = 4096): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError("maxBytes must be an integer >= 4");
  }
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (chunk && chunkBytes + charBytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** Strip ANSI escape sequences while expanding cursor-forward `ESC[nC` into spaces. */
export function stripAnsiScreenText(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, (_m, n) => " ".repeat(Number(n) || 1))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x0e\x0f]/g, "");
}

/**
 * Headless virtual terminal backed by `@xterm/headless`.
 * Resolves cursor movements, line erases, and TUI footer redraws into authoritative screen rows.
 */
export class HeadlessViewport {
  private readonly terminal: InstanceType<typeof Terminal>;
  private pendingWrites = 0;
  private flushResolvers: (() => void)[] = [];

  constructor(readonly cols = DEFAULT_PTY_COLS, readonly rows = DEFAULT_PTY_ROWS) {
    this.terminal = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  }

  feed(data: string | Uint8Array): void {
    this.pendingWrites += 1;
    this.terminal.write(data, () => {
      this.pendingWrites -= 1;
      if (this.pendingWrites === 0 && this.flushResolvers.length > 0) {
        const resolvers = this.flushResolvers.splice(0);
        for (const resolve of resolvers) resolve();
      }
    });
  }

  async flush(): Promise<void> {
    if (this.pendingWrites === 0) return;
    await new Promise<void>((resolve) => {
      this.flushResolvers.push(resolve);
    });
  }

  readViewport(options: { bottomRows?: number } = {}): string {
    const buffer = this.terminal.buffer.active;
    const totalRows = this.terminal.rows;
    const count = options.bottomRows ? Math.min(options.bottomRows, totalRows) : totalRows;
    const startY = buffer.baseY + (totalRows - count);
    const endY = buffer.baseY + totalRows;
    const lines: string[] = [];
    for (let y = startY; y < endY; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      lines.push(line.translateToString(true, 0, this.terminal.cols));
    }
    while (lines.length > 0 && lines.at(-1)?.trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  readBottomProbeRegion(): string {
    const text = this.readViewport();
    const lines = text.split("\n");
    const regionCount = Math.max(12, Math.ceil(lines.length / 3));
    return lines.slice(-regionCount).join("\n");
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
