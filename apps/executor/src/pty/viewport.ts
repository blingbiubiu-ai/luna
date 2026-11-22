import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;
type XtermTerminal = InstanceType<typeof Terminal>;
type XtermBuffer = XtermTerminal["buffer"]["active"];
type XtermLine = NonNullable<ReturnType<XtermBuffer["getLine"]>>;
type XtermCell = ReturnType<XtermBuffer["getNullCell"]>;

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 36;
export const DEFAULT_PTY_SCROLLBACK = 1500;

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

function cellSgrSequence(cell: XtermCell): string {
  if (cell.isAttributeDefault()) return "";
  const codes: (number | string)[] = [0];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);

  if (cell.isFgPalette()) {
    const c = cell.getFgColor();
    if (c < 8) codes.push(30 + c);
    else if (c < 16) codes.push(90 + (c - 8));
    else codes.push(`38;5;${c}`);
  } else if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    codes.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  }

  if (cell.isBgPalette()) {
    const c = cell.getBgColor();
    if (c < 8) codes.push(40 + c);
    else if (c < 16) codes.push(100 + (c - 8));
    else codes.push(`48;5;${c}`);
  } else if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    codes.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  }

  return `\x1b[${codes.join(";")}m`;
}

function lineTrimmedLength(line: XtermLine, cols: number, scratch: XtermCell): number {
  const max = Math.min(cols, line.length);
  for (let x = max - 1; x >= 0; x -= 1) {
    const cell = line.getCell(x, scratch);
    if (!cell) continue;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    if ((chars !== "" && chars !== " ") || !cell.isBgDefault() || cell.isInverse() || cell.isUnderline()) {
      return x + cell.getWidth();
    }
  }
  return 0;
}

function serializeLineAnsi(line: XtermLine, cols: number, scratch: XtermCell): string {
  const endCol = lineTrimmedLength(line, cols, scratch);
  if (endCol === 0) return "";
  let out = "";
  let currentSgr = "";
  for (let x = 0; x < endCol; x += 1) {
    const cell = line.getCell(x, scratch);
    if (!cell) continue;
    if (cell.getWidth() === 0) continue;
    const nextSgr = cellSgrSequence(cell);
    if (nextSgr !== currentSgr) {
      out += nextSgr === "" ? "\x1b[0m" : nextSgr;
      currentSgr = nextSgr;
    }
    const chars = cell.getChars();
    out += chars === "" ? " " : chars;
  }
  if (currentSgr !== "") {
    out += "\x1b[0m";
  }
  return out;
}

function serializeBufferAnsi(buf: XtermBuffer, cols: number, rows: number): string {
  const scratch = buf.getNullCell();
  const baseY = buf.baseY;
  let totalLines: number;
  if (baseY > 0) {
    totalLines = baseY + rows;
  } else {
    let lastNonEmpty = buf.cursorY;
    for (let vRow = rows - 1; vRow > lastNonEmpty; vRow -= 1) {
      const line = buf.getLine(vRow);
      if (line && lineTrimmedLength(line, cols, scratch) > 0) {
        lastNonEmpty = vRow;
        break;
      }
    }
    totalLines = Math.min(rows, lastNonEmpty + 1);
  }

  const serializedLines: string[] = [];
  for (let y = 0; y < totalLines; y += 1) {
    const line = buf.getLine(y);
    serializedLines.push(line ? serializeLineAnsi(line, cols, scratch) : "");
  }

  const cursorRow = Math.max(1, Math.min(rows, buf.cursorY + 1));
  const cursorCol = Math.max(1, Math.min(cols, buf.cursorX + 1));
  return `\x1b[0m${serializedLines.join("\r\n")}\x1b[0m\x1b[${cursorRow};${cursorCol}H`;
}

/**
 * Headless virtual terminal backed by `@xterm/headless`.
 * Resolves cursor movements, line erases, and TUI footer redraws into authoritative screen rows,
 * and serializes scrollback + active screen state for newly attached Dashboard viewers so differential
 * TUI spinner frames never evict historical output.
 */
export class HeadlessViewport {
  private readonly terminal: XtermTerminal;
  private currentCols: number;
  private currentRows: number;
  private pendingWrites = 0;
  private flushResolvers: (() => void)[] = [];

  constructor(cols = DEFAULT_PTY_COLS, rows = DEFAULT_PTY_ROWS, scrollback = DEFAULT_PTY_SCROLLBACK) {
    this.currentCols = cols;
    this.currentRows = rows;
    this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  }

  get cols(): number {
    return this.currentCols;
  }

  get rows(): number {
    return this.currentRows;
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

  /**
   * Reconstructs the terminal's scrollback + active 2D screen (with SGR colors/styles and cursor)
   * as an ANSI byte buffer suitable for writing into a fresh viewer xterm instance.
   */
  serializeAnsi(): Buffer {
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const active = this.terminal.buffer.active;
    if (active.type === "alternate") {
      const normalPart = serializeBufferAnsi(this.terminal.buffer.normal, cols, rows);
      const altPart = serializeBufferAnsi(this.terminal.buffer.alternate, cols, rows);
      return Buffer.from(`${normalPart}\x1b[?1049h\x1b[2J\x1b[H${altPart}`, "utf8");
    }
    return Buffer.from(serializeBufferAnsi(active, cols, rows), "utf8");
  }

  resize(cols: number, rows: number): void {
    if (cols === this.currentCols && rows === this.currentRows) return;
    this.currentCols = cols;
    this.currentRows = rows;
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
