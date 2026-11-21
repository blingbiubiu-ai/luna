/** Public progress is lossy and bounded; business completion remains independent. */
export const PROGRESS_INTERVAL_MS = 5_000;
// Internal projection ceiling matches the existing configurable display maximum.
export const RECENT_PROGRESS_STEPS = 200;

export class BufferedProgress<T> {
  private timer: ReturnType<typeof setInterval>;
  private text = "";
  private lastText = "";
  private tools = new Map<string, number>();
  private activeTools = new Map<string, string>();
  private results = 0;
  private failures = 0;
  private pending: T[] = [];
  private sending: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: {
    persist: (summary: string) => T;
    send: (entries: readonly T[]) => Promise<void>;
    onError: (error: unknown) => void;
    intervalMs?: number;
  }) {
    this.timer = setInterval(() => this.flush(), options.intervalMs ?? PROGRESS_INTERVAL_MS);
    this.timer.unref?.();
  }

  summary(text: string): void {
    if (this.closed) return;
    const value = text.trim().slice(0, 600);
    if (value && value !== this.lastText) { this.text = value; this.lastText = value; this.flush(); }
  }

  toolStart(id: string, name: string): void {
    if (this.closed) return;
    if (this.activeTools.has(id)) return;
    const label = name.slice(0, 80);
    const group = this.tools.has(label) || this.tools.size < 63 ? label : "其他";
    this.tools.set(group, (this.tools.get(group) ?? 0) + 1);
    if (this.activeTools.size < 128) this.activeTools.set(id, label);
  }

  toolResult(id: string, failed: boolean): void {
    if (this.closed) return;
    this.activeTools.delete(id);
    this.results++;
    if (failed) this.failures++;
  }

  flush(deliver = true): void {
    if (this.closed) return;
    const calls = [...this.tools.values()].reduce((sum, count) => sum + count, 0);
    const parts: string[] = [];
    if (calls || this.results) {
      const labels = [...this.tools].slice(0, 5).map(([name, count]) => `${name} × ${count}`).join("、");
      parts.push(`工具进度：调用 ${calls} 次${labels ? `（${labels}）` : ""}，收到 ${this.results} 次结果${this.failures ? `，${this.failures} 次明确失败` : ""}。`);
    }
    parts.push(this.text);
    this.text = ""; this.tools.clear(); this.results = 0; this.failures = 0;
    const summary = parts.filter(Boolean).join("\n").slice(0, 800);
    if (!summary) return;
    try {
      const entry = this.options.persist(summary);
      if (deliver) { this.pending.push(entry); if (this.pending.length > RECENT_PROGRESS_STEPS) this.pending.shift(); this.pump(); }
    }
    catch (error) { this.options.onError(error); }
  }

  private pump(): void {
    if (this.closed || this.sending || !this.pending.length) return;
    const entries = this.pending; this.pending = [];
    // A single sender preserves order; under backpressure retain only the recent projection.
    this.sending = Promise.resolve().then(() => this.options.send(entries))
      .catch(error => this.options.onError(error)).finally(() => {
        this.sending = undefined;
        this.pump();
      });
  }

  /** Initial message creation may establish the provider receipt before execution. */
  waitForCurrentSend(): Promise<void> { return this.sending ?? Promise.resolve(); }

  /** Persist the final window, discard queued display updates, and stop collecting. */
  close(): Promise<void> {
    if (!this.closed) {
      // Terminal delivery reads the recent persisted projection instead of racing a new send.
      this.flush(false); this.closed = true; clearInterval(this.timer);
      this.pending = []; this.activeTools.clear();
      return this.sending ?? Promise.resolve();
    }
    return this.sending ?? Promise.resolve();
  }
}
