import {
  type ContextPackItemRow,
  type ContextPackRow,
  type RunnerContextSeedRecordRow,
} from "@/context";

export interface DashboardContextBundleRows {
  readonly packsByOwnerKey: ReadonlyMap<string, readonly ContextPackRow[]>;
  readonly itemsByPackId: ReadonlyMap<string, readonly ContextPackItemRow[]>;
  readonly seedRecordsByOwnerKey: ReadonlyMap<
    string,
    readonly RunnerContextSeedRecordRow[]
  >;
}

export interface DashboardContextPackItem<TContextMessage = unknown> {
  readonly id: string;
  readonly context_pack_id: string;
  readonly contextPackId: string;
  readonly item_kind: string;
  readonly itemKind: string;
  readonly item_id: string;
  readonly itemId: string;
  readonly source_session_id: string | null;
  readonly sourceSessionId: string | null;
  readonly source_entry_id: string | null;
  readonly sourceEntryId: string | null;
  readonly source_message_id: string | null;
  readonly sourceMessageId: string | null;
  readonly source_identity_id: string | null;
  readonly sourceIdentityId: string | null;
  readonly role: string;
  readonly reason: string;
  readonly display_order: number;
  readonly displayOrder: number;
  readonly metadata_json: unknown;
  readonly metadataJson: unknown;
  readonly metadata: unknown;
  readonly messagePreview: string | null;
  readonly contextMessage: TContextMessage | null;
}

export interface DashboardContextPack<TContextMessage = unknown> {
  readonly id: string;
  readonly owner_type: string;
  readonly ownerType: string;
  readonly owner_id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly selection_strategy: string;
  readonly selectionStrategy: string;
  readonly trigger_entry_id: string | null;
  readonly triggerEntryId: string | null;
  readonly trigger_message_id: string | null;
  readonly triggerMessageId: string | null;
  readonly created_for_invocation_id: string | null;
  readonly createdForInvocationId: string | null;
  readonly created_at: number;
  readonly createdAt: number;
  readonly metadata_json: unknown;
  readonly metadataJson: unknown;
  readonly metadata: unknown;
  readonly itemCount: number;
  readonly items: readonly DashboardContextPackItem<TContextMessage>[];
}

export interface DashboardRunnerContextSeedRecord {
  readonly id: string;
  readonly runner_context_id: string;
  readonly runnerContextId: string;
  readonly owner_type: string;
  readonly ownerType: string;
  readonly owner_id: string;
  readonly ownerId: string;
  readonly seed_context_pack_id: string;
  readonly seedContextPackId: string;
  readonly seed_hash: string;
  readonly seedHash: string;
  readonly seed_entry_ids_json: unknown;
  readonly seedEntryIdsJson: unknown;
  readonly seedEntryIds: readonly string[];
  readonly seed_context_item_ids_json: unknown;
  readonly seedContextItemIdsJson: unknown;
  readonly seedContextItemIds: readonly string[];
  readonly created_at: number;
  readonly createdAt: number;
}

interface DashboardContextPackProjectionOptions<TContextMessage> {
  readonly metadataForPack?: (row: ContextPackRow) => unknown;
  readonly metadataForItem?: (row: ContextPackItemRow) => unknown;
  readonly previewContextMessage?: (message: TContextMessage) => string;
}

export function buildDashboardContextBundle<TContextMessage>(
  ownerType: string,
  ownerId: string,
  rows: DashboardContextBundleRows,
  toContextMessage: (item: ContextPackItemRow) => TContextMessage | null,
  options: DashboardContextPackProjectionOptions<TContextMessage> = {},
): {
  readonly contextPacks: readonly DashboardContextPack<TContextMessage>[];
  readonly seedRecords: readonly DashboardRunnerContextSeedRecord[];
} {
  const ownerBundleKey = ownerKey(ownerType, ownerId);
  const packs = rows.packsByOwnerKey.get(ownerBundleKey) ?? [];
  return {
    contextPacks: packs.map((pack) =>
      toDashboardContextPack(pack, {
        items: rows.itemsByPackId.get(pack.id) ?? [],
        toContextMessage,
        options,
      }),
    ),
    seedRecords:
      (rows.seedRecordsByOwnerKey.get(ownerBundleKey) ?? [])
        .map(toDashboardRunnerContextSeedRecord),
  };
}

export function ownerKey(ownerType: string, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

export function groupContextPacksByOwner(
  rows: readonly ContextPackRow[],
): ReadonlyMap<string, readonly ContextPackRow[]> {
  const result = new Map<string, ContextPackRow[]>();
  for (const row of rows) {
    const key = ownerKey(row.ownerType, row.ownerId);
    const group = result.get(key);
    if (group === undefined) {
      result.set(key, [row]);
    } else {
      group.push(row);
    }
  }
  return result;
}

export function groupContextPackItemsByPack(
  rows: readonly ContextPackItemRow[],
): ReadonlyMap<string, readonly ContextPackItemRow[]> {
  const result = new Map<string, ContextPackItemRow[]>();
  for (const row of rows) {
    const group = result.get(row.contextPackId);
    if (group === undefined) {
      result.set(row.contextPackId, [row]);
    } else {
      group.push(row);
    }
  }
  return result;
}

export function groupSeedRecordsByOwner(
  rows: readonly RunnerContextSeedRecordRow[],
): ReadonlyMap<string, readonly RunnerContextSeedRecordRow[]> {
  const result = new Map<string, RunnerContextSeedRecordRow[]>();
  for (const row of rows) {
    const key = ownerKey(row.ownerType, row.ownerId);
    const group = result.get(key);
    if (group === undefined) {
      result.set(key, [row]);
    } else {
      group.push(row);
    }
  }
  return result;
}

export function toDashboardContextPack<TContextMessage>(
  row: ContextPackRow,
  input: {
    readonly items: readonly ContextPackItemRow[];
    readonly toContextMessage: (
      item: ContextPackItemRow,
    ) => TContextMessage | null;
    readonly options?: DashboardContextPackProjectionOptions<TContextMessage> | undefined;
  },
): DashboardContextPack<TContextMessage> {
  const metadataJson = input.options?.metadataForPack?.(row) ??
    row.metadataJson ??
    null;
  const items = input.items.map((item) =>
    toDashboardContextPackItem(item, {
      toContextMessage: input.toContextMessage,
      options: input.options,
    }),
  );
  return {
    id: row.id,
    owner_type: row.ownerType,
    ownerType: row.ownerType,
    owner_id: row.ownerId,
    ownerId: row.ownerId,
    kind: row.kind,
    selection_strategy: row.selectionStrategy,
    selectionStrategy: row.selectionStrategy,
    trigger_entry_id: row.triggerEntryId,
    triggerEntryId: row.triggerEntryId,
    trigger_message_id: row.triggerMessageId,
    triggerMessageId: row.triggerMessageId,
    created_for_invocation_id: row.createdForInvocationId,
    createdForInvocationId: row.createdForInvocationId,
    created_at: row.createdAt,
    createdAt: row.createdAt,
    metadata_json: metadataJson,
    metadataJson,
    metadata: metadataJson,
    itemCount: items.length,
    items,
  };
}

export function toDashboardContextPackItem<TContextMessage>(
  row: ContextPackItemRow,
  input: {
    readonly toContextMessage: (
      item: ContextPackItemRow,
    ) => TContextMessage | null;
    readonly options?: DashboardContextPackProjectionOptions<TContextMessage> | undefined;
  },
): DashboardContextPackItem<TContextMessage> {
  const contextMessage = input.toContextMessage(row);
  const metadataJson = input.options?.metadataForItem?.(row) ??
    row.metadataJson ??
    null;
  return {
    id: row.id,
    context_pack_id: row.contextPackId,
    contextPackId: row.contextPackId,
    item_kind: row.itemKind,
    itemKind: row.itemKind,
    item_id: row.itemId,
    itemId: row.itemId,
    source_session_id: row.sourceSessionId,
    sourceSessionId: row.sourceSessionId,
    source_entry_id: row.sourceEntryId,
    sourceEntryId: row.sourceEntryId,
    source_message_id: row.sourceMessageId,
    sourceMessageId: row.sourceMessageId,
    source_identity_id: row.sourceIdentityId,
    sourceIdentityId: row.sourceIdentityId,
    role: row.role,
    reason: row.reason,
    display_order: row.displayOrder,
    displayOrder: row.displayOrder,
    metadata_json: metadataJson,
    metadataJson,
    metadata: metadataJson,
    messagePreview: contextMessage === null
      ? null
      : input.options?.previewContextMessage?.(contextMessage) ?? null,
    contextMessage,
  };
}

export function toDashboardRunnerContextSeedRecord(
  row: RunnerContextSeedRecordRow,
): DashboardRunnerContextSeedRecord {
  const seedEntryIds = stringArray(row.seedEntryIdsJson);
  const seedContextItemIds = stringArray(row.seedContextItemIdsJson);
  return {
    id: row.id,
    runner_context_id: row.runnerContextId,
    runnerContextId: row.runnerContextId,
    owner_type: row.ownerType,
    ownerType: row.ownerType,
    owner_id: row.ownerId,
    ownerId: row.ownerId,
    seed_context_pack_id: row.seedContextPackId,
    seedContextPackId: row.seedContextPackId,
    seed_hash: row.seedHash,
    seedHash: row.seedHash,
    seed_entry_ids_json: row.seedEntryIdsJson,
    seedEntryIdsJson: row.seedEntryIdsJson,
    seedEntryIds,
    seed_context_item_ids_json: row.seedContextItemIdsJson,
    seedContextItemIdsJson: row.seedContextItemIdsJson,
    seedContextItemIds,
    created_at: row.createdAt,
    createdAt: row.createdAt,
  };
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}
