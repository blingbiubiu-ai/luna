import { and, asc, eq, inArray } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  contextPackItems,
  contextPacks,
  runnerContextSeedRecords,
} from "@/data/schema";
import {
  groupContextPackItemsByPack,
  groupContextPacksByOwner,
  groupSeedRecordsByOwner,
  type DashboardContextBundleRows,
} from "@/dashboard-api/context-packs";

export function selectDashboardContextBundleRows(
  db: DrizzleDB,
  ownerType: "session" | "task",
  ownerIds: readonly string[],
): DashboardContextBundleRows {
  const uniqueOwnerIds = [...new Set(ownerIds)];
  if (uniqueOwnerIds.length === 0) {
    return {
      packsByOwnerKey: new Map(),
      itemsByPackId: new Map(),
      seedRecordsByOwnerKey: new Map(),
    };
  }

  const packRows = db
    .select()
    .from(contextPacks)
    .where(
      and(
        eq(contextPacks.ownerType, ownerType),
        inArray(contextPacks.ownerId, uniqueOwnerIds),
      ),
    )
    .orderBy(asc(contextPacks.createdAt), asc(contextPacks.id))
    .all();
  const packIds = packRows.map((pack) => pack.id);
  const itemRows = packIds.length === 0
    ? []
    : db
      .select()
      .from(contextPackItems)
      .where(inArray(contextPackItems.contextPackId, packIds))
      .orderBy(
        asc(contextPackItems.contextPackId),
        asc(contextPackItems.displayOrder),
        asc(contextPackItems.id),
      )
      .all();
  const seedRecordRows = db
    .select()
    .from(runnerContextSeedRecords)
    .where(
      and(
        eq(runnerContextSeedRecords.ownerType, ownerType),
        inArray(runnerContextSeedRecords.ownerId, uniqueOwnerIds),
      ),
    )
    .orderBy(
      asc(runnerContextSeedRecords.createdAt),
      asc(runnerContextSeedRecords.id),
    )
    .all();

  return {
    packsByOwnerKey: groupContextPacksByOwner(packRows),
    itemsByPackId: groupContextPackItemsByPack(itemRows),
    seedRecordsByOwnerKey: groupSeedRecordsByOwner(seedRecordRows),
  };
}
