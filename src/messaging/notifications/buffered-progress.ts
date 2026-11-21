import {randomUUID} from "node:crypto";
import type {NativeProgressEntry} from "@/channels/outbound";

/** Public progress is lossy and bounded; business completion remains independent. */
export const PROGRESS_INTERVAL_MS = 5_000;
// Internal projection ceiling matches the existing configurable display maximum.
export const RECENT_PROGRESS_STEPS = 200;
const MAX_NATIVE_EVENTS = 600;

export class BufferedProgress<T> {
  private timer: ReturnType<typeof setInterval>;
  private text = "";
  private lastText = "";
  private tools = new Map<string, number>();
  private activeTools = new Map<string, {name: string; title?: string}>();
  private nativeEvents: NativeProgressEntry[] = [];
  private results = 0;
  private failures = 0;
  private pending: {entry: T; native: NativeProgressEntry[]}[] = [];
  private sending: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: {
    persist: (summary: string, publicText: string) => T;
    send: (entries: readonly T[], nativeProgress: readonly NativeProgressEntry[]) => Promise<void>;
    entryId?: (entry: T) => string;
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

  toolStart(id: string, name: string, title?: string): void {
    if (this.closed) return;
    if (this.activeTools.has(id)) return;
    const label = name.slice(0, 80);
    const group = this.tools.has(label) || this.tools.size < 63 ? label : "其他";
    this.tools.set(group, (this.tools.get(group) ?? 0) + 1);
    const tool = {name: label, ...(title ? {title: title.slice(0, 120)} : {})};
    if (this.activeTools.size < 300) this.activeTools.set(id, tool);
    this.nativeEvents.push({id: `${id}:start`, text: tool.title ?? label, toolCallId: id,
      toolName: label, ...(tool.title ? {toolTitle: tool.title} : {}), toolPhase: "start"});
    if (this.nativeEvents.length > MAX_NATIVE_EVENTS) this.nativeEvents.shift();
  }

  toolResult(id: string, failed: boolean): void {
    if (this.closed) return;
    const tool = this.activeTools.get(id);
    this.activeTools.delete(id);
    this.nativeEvents.push({id: `${id}:result`, text: failed ? "工具执行失败" : "工具调用已结束", toolCallId: id,
      ...(tool ? {toolName: tool.name, ...(tool.title ? {toolTitle: tool.title} : {})} : {}), toolPhase: "result"});
    if (this.nativeEvents.length > MAX_NATIVE_EVENTS) this.nativeEvents.shift();
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
    const publicText = this.text;
    const native = this.nativeEvents;
    this.nativeEvents = [];
    this.text = ""; this.tools.clear(); this.results = 0; this.failures = 0;
    const summary = parts.filter(Boolean).join("\n").slice(0, 800);
    if (!summary) return;
    try {
      const entry = this.options.persist(summary, publicText);
      if (publicText) native.push({id: this.options.entryId?.(entry) ?? randomUUID(), text: publicText});
      if (deliver) {
        this.pending.push({entry, native});
        if (this.pending.length > RECENT_PROGRESS_STEPS) this.pending.shift();
        // Bound the raw presentation independently of the persisted summary projection.
        let excess = this.pending.reduce((n, item) => n + item.native.length, 0) - MAX_NATIVE_EVENTS;
        for (const item of this.pending) {
          if (excess <= 0) break;
          const remove = Math.min(excess, item.native.length); item.native.splice(0, remove); excess -= remove;
        }
        this.pump();
      }
    }
    catch (error) { this.options.onError(error); }
  }

  private pump(): void {
    if (this.sending || !this.pending.length) return;
    const entries = this.pending; this.pending = [];
    // A single sender preserves order; under backpressure retain only the recent projection.
    this.sending = Promise.resolve().then(() => this.options.send(entries.map(item => item.entry), entries.flatMap(item => item.native)))
      .catch(error => this.options.onError(error)).finally(() => {
        this.sending = undefined;
        this.pump();
      });
  }

  /** Initial message creation may establish the provider receipt before execution. */
  waitForCurrentSend(): Promise<void> { return this.sending ?? Promise.resolve(); }

  /** Drain the final tool/result batch before the caller publishes terminal state. */
  async close(): Promise<void> {
    if (!this.closed) {
      this.flush(); this.closed = true; clearInterval(this.timer);
      this.activeTools.clear();
    }
    while (this.sending) await this.sending;
  }
}
