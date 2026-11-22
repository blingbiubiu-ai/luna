import {randomUUID} from "node:crypto";
import type {NativeProgressEntry} from "@/channels/outbound";
import {toolDisplay} from "@luna/runner-protocol/tool-display";

export const RECENT_PROGRESS_STEPS = 200;
export const MAX_PENDING_PROGRESS = 600;

/** Send each observation immediately; persistence is supplied by the caller. */
export class LiveProgress<T> {
  private lastText = "";
  private activeTools = new Map<string, {name: string; title?: string; startedAt: number}>();
  private pending: {entry: T; native: NativeProgressEntry}[] = [];
  private sending: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: {
    persist: (text: string) => T;
    transient: (event: NativeProgressEntry) => T;
    send: (entries: readonly T[], nativeProgress: readonly NativeProgressEntry[]) => Promise<void>;
    entryId?: (entry: T) => string;
    onError: (error: unknown) => void;
  }) {}

  summary(text: string): void {
    if (this.closed) return;
    const value = text.trim().slice(0, 600);
    if (!value || value === this.lastText) return;
    this.lastText = value;
    try {
      const entry = this.options.persist(value);
      this.enqueue(entry, {id: this.options.entryId?.(entry) ?? randomUUID(), text: value});
    } catch (error) { this.options.onError(error); }
  }

  toolStart(id: string, name: string, title?: string): void {
    if (this.closed || this.activeTools.has(id)) return;
    const tool = {startedAt: Date.now(), name: name.slice(0,80), title: title?.slice(0,120) || toolDisplay(name).label.slice(0,120)};
    if (this.activeTools.size < 300) this.activeTools.set(id, tool);
    this.tool({id: `${id}:start`, text: tool.title ?? tool.name, toolCallId: id,
      startedAt: tool.startedAt, toolName: tool.name, ...(tool.title ? {toolTitle: tool.title} : {}), toolPhase: "start"});
  }

  toolResult(id: string, failed: boolean): void {
    if (this.closed) return;
    const tool = this.activeTools.get(id);
    this.activeTools.delete(id);
    this.tool({id: `${id}:result`, text: failed ? "工具执行失败" : "工具调用已结束", toolCallId: id,
      ...(tool ? {startedAt: tool.startedAt, toolName: tool.name, ...(tool.title ? {toolTitle: tool.title} : {})} : {}), toolPhase: "result"});
  }

  private tool(native: NativeProgressEntry): void {
    try { this.enqueue(this.options.transient(native), native); }
    catch (error) { this.options.onError(error); }
  }

  private enqueue(entry: T, native: NativeProgressEntry): void {
    this.pending.push({entry, native});
    if (this.pending.length > MAX_PENDING_PROGRESS) this.pending.shift();
    this.pump();
  }

  private pump(): void {
    if (this.sending) return;
    const item = this.pending.shift();
    if (!item) return;
    // One observation per send, without a timer or batching window. Network waits
    // do not block the producer; the queue preserves order and bounds backpressure.
    this.sending = Promise.resolve().then(() => this.options.send([item.entry], [item.native]))
      .catch(error => this.options.onError(error)).finally(() => {
        this.sending = undefined;
        this.pump();
      });
  }

  waitForCurrentSend(): Promise<void> { return this.sending ?? Promise.resolve(); }

  /** Stop observation and drain accepted updates before terminal delivery. */
  async close(): Promise<void> {
    this.closed = true;
    this.activeTools.clear();
    while (this.sending) await this.sending;
  }
}
