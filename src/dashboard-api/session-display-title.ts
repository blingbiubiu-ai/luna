import { resolvePersistedSurfaceKind } from "@/channels/directory-store";
import {
  channelIdentities,
  channelSurfaces,
  directRecipients,
  sessions,
  userIdentityLinks,
} from "@/data/schema";

type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
type ChannelSurfaceRow = typeof channelSurfaces.$inferSelect;
export type DirectRecipientRow = typeof directRecipients.$inferSelect;
export type UserIdentityLinkRow = typeof userIdentityLinks.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

export interface SessionDisplayTitleUser {
  readonly id: string;
  readonly displayName: string | null;
  readonly avatarUrl?: string | null | undefined;
}

export interface SessionDisplayTitleMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly senderExternalId: string | null;
  readonly createdAt: number;
}

export interface SessionDisplayTitleInput {
  readonly row: SessionRow;
  readonly surfaceRows: readonly ChannelSurfaceRow[];
  readonly messageRows: readonly SessionDisplayTitleMessage[];
  readonly identityRows: readonly ChannelIdentityRow[];
  readonly directRecipientRows?: readonly DirectRecipientRow[] | undefined;
  readonly userIdentityLinkRows?: readonly UserIdentityLinkRow[] | undefined;
  readonly userRows?: readonly SessionDisplayTitleUser[] | undefined;
}

/**
 * Resolves the dashboard title from the live channel directory instead of
 * freezing a copied session title.
 */
export function resolveSessionDisplayTitle(
  input: SessionDisplayTitleInput,
): string {
  const surface = channelSurfaceForSession(input.row, input.surfaceRows);
  const surfaceTitle = surface === null ? null : directorySurfaceName(surface);
  const surfaceKind = surface === null ? null : resolveChannelSurfaceKind(surface);
  const directRecipient = directRecipientForSession(
    input.row,
    input.directRecipientRows,
  );

  if (surfaceKind === "group") {
    return surfaceTitle ?? input.row.title ?? input.row.id;
  }

  if (surfaceKind === "p2p" || (surface === null && directRecipient !== null)) {
    const p2pUser = p2pUserForSession({
      row: input.row,
      messageRows: input.messageRows,
      identityRows: input.identityRows,
      directRecipientRows: input.directRecipientRows,
    });
    const canonicalUser = p2pCanonicalUserForSession({
      row: input.row,
      directRecipientRows: input.directRecipientRows,
      userIdentityLinkRows: input.userIdentityLinkRows,
      userRows: input.userRows,
    });
    return (
      (p2pUser === null ? null : directoryIdentityName(p2pUser)) ??
      firstNonEmpty(canonicalUser?.displayName) ??
      surfaceTitle ??
      input.row.title ??
      input.row.id
    );
  }

  return surfaceTitle ?? input.row.title ?? input.row.id;
}

export function resolveChannelSurfaceKind(row: ChannelSurfaceRow): string {
  return resolvePersistedSurfaceKind(row);
}

function channelSurfaceForSession(
  row: SessionRow,
  surfaceRows: readonly ChannelSurfaceRow[],
): ChannelSurfaceRow | null {
  if (row.group_id === null) {
    return null;
  }
  return (
    surfaceRows.find(
      (surface) =>
        surface.channelType === row.channel_type &&
        surface.channelId === row.channel_id &&
        surface.externalId === row.group_id,
    ) ?? null
  );
}

export function directRecipientForSession(
  row: SessionRow,
  directRecipientRows: readonly DirectRecipientRow[] | undefined,
): DirectRecipientRow | null {
  if (!directRecipientRows || directRecipientRows.length === 0) {
    return null;
  }
  return (
    directRecipientRows.find((candidate) => candidate.sessionId === row.id) ??
    (row.group_id === null
      ? null
      : directRecipientRows.find(
          (candidate) =>
            candidate.channelId === row.channel_id &&
            candidate.surfaceId === row.group_id,
        ) ?? null)
  );
}

export function p2pCanonicalUserForSession<T extends SessionDisplayTitleUser>(input: {
  readonly row: SessionRow;
  readonly directRecipientRows?: readonly DirectRecipientRow[] | undefined;
  readonly userIdentityLinkRows?: readonly UserIdentityLinkRow[] | undefined;
  readonly userRows?: readonly T[] | undefined;
}): T | null {
  const direct = directRecipientForSession(input.row, input.directRecipientRows);
  if (!direct?.claimId || !input.userIdentityLinkRows || !input.userRows) {
    return null;
  }
  const link = input.userIdentityLinkRows.find(
    (candidate) => candidate.id === direct.claimId,
  );
  if (!link) {
    return null;
  }
  return input.userRows.find((user) => user.id === link.userId) ?? null;
}

export function p2pUserForSession(input: {
  readonly row: SessionRow;
  readonly messageRows: readonly SessionDisplayTitleMessage[];
  readonly identityRows: readonly ChannelIdentityRow[];
  readonly directRecipientRows?: readonly DirectRecipientRow[] | undefined;
}): ChannelIdentityRow | null {
  const senderIds = input.messageRows
    .filter(
      (message) =>
        message.sessionId === input.row.id &&
        message.role === "user" &&
        message.senderExternalId !== null,
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((message) => message.senderExternalId)
    .filter((senderId): senderId is string => senderId !== null);
  const seenSenderIds = new Set<string>();
  for (const senderId of senderIds) {
    if (seenSenderIds.has(senderId)) {
      continue;
    }
    seenSenderIds.add(senderId);
    // Task result rows can be stored as user messages from luna-system; keep
    // walking backward until a real channel directory identity can name the P2P.
    const user = input.identityRows.find(
      (candidate) =>
        candidate.channelType === input.row.channel_type &&
        candidate.channelId === input.row.channel_id &&
        candidate.externalId === senderId,
    );
    if (user !== undefined) {
      return user;
    }
  }
  const direct = directRecipientForSession(input.row, input.directRecipientRows);
  if (direct !== null) {
    const byRecipient = input.identityRows.find(
      (candidate) =>
        candidate.channelType === input.row.channel_type &&
        candidate.channelId === input.row.channel_id &&
        (candidate.externalId === direct.recipientId ||
          identityMatchesProviderId(
            candidate.providerIdsJson,
            direct.idType,
            direct.recipientId,
          )),
    );
    if (byRecipient !== undefined) {
      return byRecipient;
    }
  }
  return null;
}

function identityMatchesProviderId(
  providerIdsJson: string | null,
  idType: string,
  recipientId: string,
): boolean {
  if (providerIdsJson === null) {
    return false;
  }
  const record = asRecord(parseJsonOrNull(providerIdsJson));
  return record !== null && record[idType] === recipientId;
}

function directorySurfaceName(row: ChannelSurfaceRow): string | null {
  return firstNonEmpty(
    row.displayName,
    profileDisplayName(row.rawProfileJson),
  );
}

function directoryIdentityName(row: ChannelIdentityRow): string | null {
  return firstNonEmpty(
    row.displayName,
    profileDisplayName(row.rawProfileJson),
  );
}

function profileDisplayName(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const parsed = parseJsonOrNull(value);
  const record = asRecord(parsed);
  if (record === null) {
    return null;
  }
  const i18nNames = asRecord(record.i18n_names) ?? asRecord(record.i18nNames);
  const localizedNames =
    asRecord(record.localized_names) ?? asRecord(record.localizedNames);
  const avatar = asRecord(record.avatar);
  return firstNonEmpty(
    record.display_name,
    record.displayName,
    record.name,
    record.en_name,
    record.enName,
    record.nickname,
    record.nickName,
    record.description,
    i18nNames?.zh_cn,
    i18nNames?.zh_hans,
    i18nNames?.en_us,
    i18nNames?.ja_jp,
    localizedNames?.zh_cn,
    localizedNames?.en_us,
    avatar?.name,
  );
}

function profileSurfaceKind(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const parsed = parseJsonOrNull(value);
  const record = asRecord(parsed);
  if (record === null) {
    return null;
  }
  const kind = firstNonEmpty(
    record.chat_type,
    record.chatType,
    record.chat_mode,
    record.chatMode,
  );
  return kind === "p2p" || kind === "group" ? kind : null;
}

function parseJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstNonEmpty(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}
