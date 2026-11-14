import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { channelMessageMarkers } from "@/data/schema";
import { uuid } from "@/shared";

export type ChannelMessageMarkerRow =
  typeof channelMessageMarkers.$inferSelect;

export interface FindChannelMessageMarkerInput {
  readonly channelType: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly markerType: string;
}

export interface UpsertChannelMessageMarkerInput
  extends FindChannelMessageMarkerInput {
  readonly providerMarkerId: string;
  readonly providerPayloadJson?: unknown;
}

export class ChannelMessageMarkerStore {
  constructor(private readonly _db: DrizzleDB) {}

  upsert(input: UpsertChannelMessageMarkerInput): void {
    const now = Date.now();
    this._db
      .insert(channelMessageMarkers)
      .values({
        id: uuid(),
        channelType: input.channelType,
        channelId: input.channelId,
        messageId: input.messageId,
        markerType: input.markerType,
        providerMarkerId: input.providerMarkerId,
        providerPayloadJson: input.providerPayloadJson ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          channelMessageMarkers.channelType,
          channelMessageMarkers.channelId,
          channelMessageMarkers.messageId,
          channelMessageMarkers.markerType,
        ],
        set: {
          providerMarkerId: input.providerMarkerId,
          providerPayloadJson: input.providerPayloadJson ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  find(
    input: FindChannelMessageMarkerInput,
  ): ChannelMessageMarkerRow | undefined {
    return this._db
      .select()
      .from(channelMessageMarkers)
      .where(markerPredicate(input))
      .get();
  }

  delete(input: FindChannelMessageMarkerInput): void {
    this._db
      .delete(channelMessageMarkers)
      .where(markerPredicate(input))
      .run();
  }
}

function markerPredicate(input: FindChannelMessageMarkerInput) {
  return and(
    eq(channelMessageMarkers.channelType, input.channelType),
    eq(channelMessageMarkers.channelId, input.channelId),
    eq(channelMessageMarkers.messageId, input.messageId),
    eq(channelMessageMarkers.markerType, input.markerType),
  );
}
