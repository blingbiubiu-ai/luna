import { describe, expect, test } from "bun:test";

import {
  toDashboardSession,
  type ChannelIdentityRow,
  type ChannelSurfaceRow,
  type SessionRow,
  type UserRow,
} from "../../src/dashboard-api/sessions";
import type {
  DirectRecipientRow,
  UserIdentityLinkRow,
} from "../../src/dashboard-api/session-display-title";

describe("Dashboard outbound P2P session title & avatar", () => {
  test("resolves recipient name and avatar from direct_recipients when recipient has not replied yet", () => {
    const row = sessionRow({
      id: "21979215-3e2f-4e6c-93fb-4bdd59c20a80",
      channel_type: "feishu",
      channel_id: "feishu-default",
      group_id: "oc_5520299b7f8876be8a19a7f46c962f4e",
    });
    const surface: ChannelSurfaceRow = {
      id: "surface-p2p-1",
      channelType: "feishu",
      channelId: "feishu-default",
      externalId: "oc_5520299b7f8876be8a19a7f46c962f4e",
      surfaceKind: "p2p",
      displayName: null,
      avatarUrl: null,
      providerIdsJson: null,
      rawProfileJson: null,
      firstSeenAt: "1",
      lastSeenAt: "1",
      profileUpdatedAt: null,
      createdAt: "1",
      updatedAt: "1",
    };
    const identity: ChannelIdentityRow = {
      id: "identity-ysd",
      channelType: "feishu",
      channelId: "feishu-default",
      externalId: "ou_e7730572a7e887eb3043997507c83c83",
      identityKind: "user",
      displayName: "袁少东",
      avatarUrl: "https://example.com/avatar-ysd.png",
      providerIdsJson: JSON.stringify({
        open_id: "ou_e7730572a7e887eb3043997507c83c83",
      }),
      rawProfileJson: null,
      firstSeenAt: "1",
      lastSeenAt: "1",
      profileUpdatedAt: "1",
      createdAt: "1",
      updatedAt: "1",
    };
    const direct: DirectRecipientRow = {
      id: "direct-1",
      channelId: "feishu-default",
      idType: "open_id",
      recipientId: "ou_e7730572a7e887eb3043997507c83c83",
      sessionId: row.id,
      claimId: "claim-ysd",
      surfaceId: "oc_5520299b7f8876be8a19a7f46c962f4e",
    };

    const dto = toDashboardSession(row, {
      bindingStatus: "active",
      sessionRows: [row],
      timelineRows: [],
      surfaceRows: [surface],
      identityRows: [identity],
      userRows: [],
      channelUserBindingRows: [],
      directRecipientRows: [direct],
      userIdentityLinkRows: [],
      taskRows: [],
      sourceContextItems: [],
      subscriptionRows: [],
      contextBundleRows: {
        packsByOwnerKey: new Map(),
        itemsByPackId: new Map(),
        seedRecordsByOwnerKey: new Map(),
      },
      artifactSigner: {
        previewUrl: () => undefined,
        contentUrl: () => undefined,
      },
    });

    expect(dto.displayTitle).toBe("袁少东");
    expect(dto.avatarUrl).toBe("https://example.com/avatar-ysd.png");
    expect(dto.surface?.kind).toBe("p2p");
  });

  test("falls back to canonical user via claimId before provider surface is materialized", () => {
    const row = sessionRow({
      id: "session-pre-delivery",
      channel_type: "feishu",
      channel_id: "feishu-default",
      group_id: null,
    });
    const direct: DirectRecipientRow = {
      id: "direct-2",
      channelId: "feishu-default",
      idType: "user_id",
      recipientId: "697a56bd",
      sessionId: row.id,
      claimId: "claim-ysd",
      surfaceId: null,
    };
    const link: UserIdentityLinkRow = {
      id: "claim-ysd",
      agentId: "agent-1",
      userId: "user-ysd",
      identityNamespace: "feishu",
      identityKind: "user_id",
      identityValue: "697a56bd",
      identityScope: "tenant:1",
      confidence: "verified",
      isPrimary: true,
      createdAt: "1",
      updatedAt: "1",
    };
    const user: UserRow = {
      id: "user-ysd",
      agentId: "agent-1",
      accountId: null,
      kind: "human",
      displayName: "袁少东",
      avatarUrl: "https://example.com/canonical-ysd.png",
      status: "active",
      mergedIntoUserId: null,
      profileSource: "channel",
      createdAt: "1",
      updatedAt: "1",
    };

    const dto = toDashboardSession(row, {
      bindingStatus: "active",
      sessionRows: [row],
      timelineRows: [],
      surfaceRows: [],
      identityRows: [],
      userRows: [user],
      channelUserBindingRows: [],
      directRecipientRows: [direct],
      userIdentityLinkRows: [link],
      taskRows: [],
      sourceContextItems: [],
      subscriptionRows: [],
      contextBundleRows: {
        packsByOwnerKey: new Map(),
        itemsByPackId: new Map(),
        seedRecordsByOwnerKey: new Map(),
      },
      artifactSigner: {
        previewUrl: () => undefined,
        contentUrl: () => undefined,
      },
    });

    expect(dto.displayTitle).toBe("袁少东");
    expect(dto.avatarUrl).toBe("https://example.com/canonical-ysd.png");
    expect(dto.surface?.kind).toBe("p2p");
  });
});

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    surface_key: "surface-1",
    channel_type: "feishu",
    channel_id: "feishu-default",
    group_id: null,
    root_message_key: null,
    thread_key: null,
    parent_session_id: null,
    title: null,
    status: "active",
    created_by_user_id: null,
    created_at: 1,
    updated_at: 1,
    last_activity_at: 1,
    kind: "main",
    bot_user_id: "bot-1",
    agent_id: "agent-1",
    shadow_id: "shadow-1",
    binding_id: "binding-1",
    ...overrides,
  };
}
