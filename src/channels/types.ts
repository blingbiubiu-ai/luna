import type {
  InboundAddressing,
  MessageContentBlock,
  MessageContentKind,
  MessagePresentationKind,
} from "../sessions/types";
import type { ReplyChannel } from "./outbound";
import type { DrizzleDB } from "@/data";

// Channel identities are provider-neutral actors visible to Luna runtime.
export type ChannelIdentityKind = "user" | "bot" | "system" | "unknown";

export interface ChannelIdentity {
  readonly externalId: string;
  readonly kind: ChannelIdentityKind;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly providerIds?: Record<string, string>;
  readonly identityClaims?: readonly ChannelIdentityClaim[];
  readonly requesterIdentity?: ChannelRequesterIdentity;
  readonly requiresExplicitRequesterIdentity?: boolean;
  readonly rawProfile?: unknown;
}

export interface ChannelIdentityClaim {
  readonly namespace: string;
  readonly kind: string;
  readonly value: string;
  readonly scope?: string;
  readonly confidence?: "verified" | "inferred";
}

export interface ChannelRequesterIdentity {
  readonly provider: string;
  readonly externalUserId: string;
  readonly tenantKey?: string;
  readonly canonicalUserId?: string;
  readonly identityNamespace?: string;
  readonly identityKind?: string;
  readonly identityScope?: string;
}

export type ChannelSurfaceKind =
  | "p2p"
  | "group"
  | "channel"
  | "thread"
  | "webhook"
  | "ticket"
  | "unknown";

// Channel surfaces are provider-neutral places where messages happen.
export interface ChannelSurface {
  readonly externalId: string;
  readonly kind: ChannelSurfaceKind;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly providerIds?: Record<string, string>;
  readonly rawProfile?: unknown;
}

export interface ChannelMention {
  readonly key: string;
  readonly label: string;
  readonly target: ChannelIdentity;
  readonly rawMention?: unknown;
}

export interface ChannelRef {
  readonly type: string;
  readonly id: string;
}

// Normalized inbound messages keep provider payload details outside runner input.
export interface NormalizedInboundMessage {
  /** Trusted ingress may address an existing session without binding a delivery surface. */
  readonly targetSessionId?: string;
  readonly id: string;
  readonly channel: ChannelRef;
  readonly surface: ChannelSurface;
  readonly thread?: {
    readonly externalId: string;
    readonly rootMessageExternalId?: string;
    readonly parentMessageExternalId?: string;
  };
  readonly sender: ChannelIdentity;
  readonly relatedIdentities?: readonly ChannelIdentity[];
  readonly text: string;
  readonly contentBlocks?: readonly MessageContentBlock[];
  readonly mentions: readonly ChannelMention[];
  readonly addressing: InboundAddressing;
  readonly contentKind?: MessageContentKind;
  readonly presentationKind?: MessagePresentationKind;
  readonly providerMessageType?: string;
  readonly presentation?: ChannelMessagePresentation;
  readonly rawPayload?: unknown;
}

export type ChannelMessagePresentation = {
  readonly kind: "rich_markdown_card";
};

export interface ChannelConfig {
  readonly type: string;
  readonly id: string;
  readonly options?: Record<string, unknown>;
}

export interface ChannelLogger {
  info(details: Record<string, unknown>, message?: string): void;
  info(message: string): void;
  warn(details: Record<string, unknown>, message?: string): void;
  warn(message: string): void;
  error(details: Record<string, unknown>, message?: string): void;
  error(message: string): void;
}

export interface ChannelRuntimeDeps {
  readonly logger?: ChannelLogger;
  readonly db?: DrizzleDB;
}

// Provider-neutral inbound connection snapshot for runtime observability.
export interface ChannelInboundRuntimeStatus {
  readonly state: string;
  readonly lastConnectAt?: number;
  readonly nextConnectAt?: number;
  readonly reconnectAttempts?: number;
  readonly lastErrorAt?: number;
  readonly lastError?: string;
}

export interface ChannelAdapterRuntimeStatus {
  readonly inbound?: ChannelInboundRuntimeStatus;
}

export interface RegisteredChannelRuntimeStatus
  extends ChannelAdapterRuntimeStatus {
  readonly id: string;
  readonly type: string;
}

export interface ChannelCardAction {
  readonly channel: ChannelRef;
  readonly providerMessageId?: string | undefined;
  readonly chatId?: string | undefined;
  readonly actionValue: Record<string, unknown>;
  readonly operatorIdentity: ChannelIdentity;
}

export interface ChannelCardActionResult {
  readonly toast?: {
    readonly type: "info" | "success" | "warning" | "error";
    readonly content: string;
  } | undefined;
  readonly updatedMarkdown?: string | undefined;
  readonly updatedTitle?: string | undefined;
}

// Adapters isolate provider SDK lifecycle from Luna's provider-neutral runtime.
export interface ChannelAdapter extends ReplyChannel {
  readonly id: string;
  readonly type: string;
  start(): Promise<void>;
  stop?(): Promise<void>;
  getStatus?(): ChannelAdapterRuntimeStatus;
  subscribeInbound(handler: (message: NormalizedInboundMessage) => Promise<void>): Promise<void>;
  subscribeCardActions?(
    handler: (action: ChannelCardAction) => Promise<ChannelCardActionResult | undefined>,
  ): Promise<void>;
}

export interface ChannelAdapterFactory {
  readonly type: string;
  create(config: ChannelConfig, deps: ChannelRuntimeDeps): ChannelAdapter;
}
