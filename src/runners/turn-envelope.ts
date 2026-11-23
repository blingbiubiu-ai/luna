import { dataBlock, joinBlocks } from "@luna/host-runtime/prompt-blocks";
import type { ChannelMention, NormalizedInboundMessage } from "@/channels/types";
import { defaultSystemTimezone } from "@/platform/platform-settings-store";
import type { RunnerMessageEnvelope } from "./message-envelope";

/**
 * Per-turn Runner input: tagged blocks of compact JSON or plain text, carrying only what is new
 * this turn. Rules live in the instruction files; nothing here repeats them.
 */

export { dataBlock, joinBlocks };

/** How a sender relates to this Shadow; `trusted` is present only while root access is on. */
export interface PersonFacts {
  readonly role: "owner" | "member";
  readonly trusted?: boolean;
}
export type PeopleResolver = (userId: string) => PersonFacts | undefined;

/** The current time in the configured timezone, for the head of every turn. */
export function turnClock(now: Date = new Date(), timezone: string = defaultSystemTimezone()): {
  readonly now: string; readonly weekday: string; readonly timezone: string;
} {
  return { now: zonedIso(now, timezone), weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(now), timezone };
}

/** `2026-11-18T14:35:26+08:00` for an instant in a timezone. */
export function zonedIso(date: Date, timezone: string = defaultSystemTimezone()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName!.slice(3);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** Drops undefined, null and empty arrays so every field present carries information. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) =>
    item !== undefined && item !== null && !(Array.isArray(item) && item.length === 0))) as Partial<T>;
}

function mentionFacts(mentions: readonly ChannelMention[], addressing: NormalizedInboundMessage["addressing"] | undefined) {
  const selfByMention = addressing?.addressedToBot === true && addressing.reason === "mention";
  return mentions.map((mention) => compact({
    label: mention.label,
    name: mention.target.displayName,
    kind: mention.target.kind,
    externalId: mention.target.externalId,
    self: selfByMention && mention.target.kind === "bot" ? true : undefined,
  }));
}

/** One message as the Runner sees it: Luna ids, the sender with their relation to the Shadow, local time, text. */
export function messageItem(message: RunnerMessageEnvelope, people: PeopleResolver | undefined, raw?: NormalizedInboundMessage, timezone?: string) {
  const userId = message.senderUserId ?? undefined;
  return compact({
    id: message.messageId,
    ...(message.role === "assistant" ? { role: "assistant" } : {}),
    from: compact({
      id: userId,
      externalId: message.sender.externalId,
      name: message.sender.displayName,
      kind: message.sender.kind,
      ...(userId ? people?.(userId) : undefined),
    }),
    at: zonedIso(new Date(message.createdAt), timezone),
    ...nonDefault("contentKind", raw?.contentKind ?? message.contentKind, "text"),
    ...nonDefault("presentationKind", raw?.presentationKind ?? message.presentationKind, "plain"),
    text: message.text,
    mentions: raw ? mentionFacts(raw.mentions ?? [], raw.addressing) : undefined,
  });
}

function nonDefault(key: string, value: string | undefined, usual: string): Record<string, string> {
  return value && value !== usual ? { [key]: value } : {};
}

/** How the latest message addresses this Shadow; other targets matter only in an activation window. */
export function addressingFacts(latest: NormalizedInboundMessage) {
  const others = latest.addressing?.reason === "activation_followup" ? (latest.mentions ?? []).length > 0 : undefined;
  return compact({ addressed: latest.addressing.addressedToBot, reason: latest.addressing.reason, latestMentionsOthers: others });
}

export type TurnEventKind =
  | "message"
  | "pending_ask"
  | "task_result"
  | "schedule_fired"
  | "handoff"
  | "request_result"
  | "routine"
  | "clarification";

export interface TurnEventEnvelope {
  readonly id: string;
  readonly kind: TurnEventKind;
  readonly time: string;
  readonly source: string;
  readonly actor?: string | null | undefined;
  readonly correlationId?: string | undefined;
  readonly payload: Record<string, unknown>;
}

export function turnEvent(input: TurnEventEnvelope): Partial<TurnEventEnvelope> {
  return compact({
    id: input.id,
    kind: input.kind,
    time: input.time,
    source: input.source,
    actor: input.actor ?? undefined,
    correlationId: input.correlationId,
    payload: input.payload,
  });
}
