import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const contextPacks = sqliteTable(
  "context_packs",
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    kind: text("kind").notNull(),
    selectionStrategy: text("selection_strategy").notNull(),
    triggerEntryId: text("trigger_entry_id"),
    triggerMessageId: text("trigger_message_id"),
    createdForInvocationId: text("created_for_invocation_id"),
    createdAt: integer("created_at").notNull(),
    metadataJson: text("metadata_json", { mode: "json" }),
  },
  (table) => [
    index("context_packs_owner_idx").on(
      table.ownerType,
      table.ownerId,
      table.kind,
      table.createdAt,
    ),
    index("context_packs_trigger_entry_idx").on(table.triggerEntryId),
  ],
);

export const contextPackItems = sqliteTable(
  "context_pack_items",
  {
    id: text("id").primaryKey(),
    contextPackId: text("context_pack_id").notNull(),
    itemKind: text("item_kind").notNull(),
    itemId: text("item_id").notNull(),
    sourceSessionId: text("source_session_id"),
    sourceEntryId: text("source_entry_id"),
    sourceMessageId: text("source_message_id"),
    sourceIdentityId: text("source_identity_id"),
    role: text("role").notNull(),
    reason: text("reason").notNull(),
    displayOrder: integer("display_order").notNull(),
    metadataJson: text("metadata_json", { mode: "json" }),
  },
  (table) => [
    uniqueIndex("context_pack_items_pack_item_role_unique").on(
      table.contextPackId,
      table.itemKind,
      table.itemId,
      table.role,
    ),
    index("context_pack_items_pack_role_idx").on(
      table.contextPackId,
      table.role,
      table.displayOrder,
    ),
    index("context_pack_items_source_message_idx").on(
      table.sourceMessageId,
      table.role,
    ),
    index("context_pack_items_source_entry_idx").on(
      table.sourceSessionId,
      table.sourceEntryId,
    ),
  ],
);

export const runnerContextSeedRecords = sqliteTable(
  "runner_context_seed_records",
  {
    id: text("id").primaryKey(),
    runnerContextId: text("runner_context_id").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    seedContextPackId: text("seed_context_pack_id").notNull(),
    seedHash: text("seed_hash").notNull(),
    seedEntryIdsJson: text("seed_entry_ids_json", { mode: "json" }).notNull(),
    seedContextItemIdsJson: text("seed_context_item_ids_json", {
      mode: "json",
    }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("runner_context_seed_records_context_pack_unique").on(
      table.runnerContextId,
      table.seedContextPackId,
    ),
    index("runner_context_seed_records_owner_idx").on(
      table.ownerType,
      table.ownerId,
      table.createdAt,
    ),
  ],
);
