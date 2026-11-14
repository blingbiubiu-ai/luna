import { channelIdentities, userIdentityLinks, users } from "@/data/schema";

export type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type UserIdentityLinkRow = typeof userIdentityLinks.$inferSelect;

export interface AgentIdentity {
  readonly id: string;
  readonly channel: {
    readonly type: string;
    readonly id: string;
  };
  readonly externalId: string;
  readonly identityKind: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly providerIds: Record<string, string>;
}

export interface DashboardCanonicalUser {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly status: string;
  readonly profileSource: string;
  readonly displayNameSource?: string;
}

export interface DashboardMessageSender {
  readonly senderUserId: string;
  readonly senderUser: DashboardCanonicalUser;
}

export function toAgentIdentity(row: ChannelIdentityRow): AgentIdentity {
  return {
    id: row.id,
    channel: {
      type: row.channelType,
      id: row.channelId,
    },
    externalId: row.externalId,
    identityKind: row.identityKind,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    providerIds: parseProviderIds(row.providerIdsJson),
  };
}

export function toDashboardCanonicalUser(
  row: UserRow,
): DashboardCanonicalUser {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    status: row.status,
    profileSource: row.profileSource,
    ...("displayNameSource" in row ? { displayNameSource: String(row.displayNameSource) } : {}),
  };
}

export function resolveCanonicalUser(
  userId: string,
  userRows: readonly UserRow[],
): DashboardCanonicalUser {
  const senderUser = resolveCanonicalUserRow(userId, userRows);
  if (senderUser === undefined) {
    throw new Error(`Canonical user not found: ${userId}`);
  }
  return toDashboardCanonicalUser(senderUser);
}

export function resolveCanonicalUserRow(
  userId: string,
  userRows: readonly UserRow[],
): UserRow | undefined {
  const userById = new Map(userRows.map((user) => [user.id, user]));
  let current = userById.get(userId);
  const visited = new Set<string>();
  while (
    current !== undefined &&
    current.mergedIntoUserId !== null &&
    current.mergedIntoUserId.length > 0 &&
    !visited.has(current.id)
  ) {
    visited.add(current.id);
    current = userById.get(current.mergedIntoUserId);
  }
  return current;
}

export function resolveMessageSender(input: {
  readonly deleted?: boolean;
  readonly senderUserId: string;
  readonly userRows: readonly UserRow[];
}): DashboardMessageSender {
  if (input.deleted) return {
    senderUserId: "",
    senderUser: { id: "", kind: "deleted", displayName: "已删除消息", avatarUrl: null, status: "deleted", profileSource: "system" },
  };
  return {
    senderUserId: input.senderUserId,
    senderUser: resolveCanonicalUser(input.senderUserId, input.userRows),
  };
}

export function parseProviderIds(value: unknown): Record<string, string> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}
