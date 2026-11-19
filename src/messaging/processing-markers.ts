import type { NormalizedInboundMessage } from "@/channels";
import type { ReplyChannel } from "@/channels/outbound";

const completions = new WeakMap<ReplyChannel, Map<string, Promise<void>>>();
const completedLimit = 1024;

/** Reply delivery and turn finalization share cleanup, including in-flight work.
 * Failed cleanup remains retryable; adapters must tolerate replay after restart.
 */
export function completeProcessingOnce(channel: ReplyChannel, inbound: NormalizedInboundMessage): Promise<void> {
  if (!channel.completeProcessing) return Promise.resolve();
  let entries = completions.get(channel);
  if (!entries) { entries = new Map(); completions.set(channel, entries); }
  const key = JSON.stringify([inbound.channel.type, inbound.channel.id, inbound.surface.externalId, inbound.id]);
  const existing = entries.get(key);
  if (existing) return existing;
  const cache = entries;
  const completed = history(channel);
  const pending = Promise.resolve().then(() => channel.completeProcessing!(inbound));
  cache.set(key, pending);
  void pending.then(() => {
    // Keep only a bounded recent history, without evicting in-flight operations.
    cache.delete(key);
    cache.set(key, Promise.resolve());
    completed.push(key);
    if (completed.length > completedLimit) cache.delete(completed.shift()!);
  }, () => { if (cache.get(key) === pending) cache.delete(key); });
  return pending;
}

// Completion order is per adapter so releasing an adapter releases its history.
const histories = new WeakMap<ReplyChannel, string[]>();
function history(channel: ReplyChannel): string[] {
  let entries = histories.get(channel);
  if (!entries) { entries = []; histories.set(channel, entries); }
  return entries;
}
