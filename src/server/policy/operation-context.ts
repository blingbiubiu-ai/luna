export type ActorKind =
  | "dashboard_user"
  | "channel_user"
  | "runner"
  | "service";

export type RunnerKind = "main" | "task";
export type IdentityProvider = string;

export interface RequestActor {
  readonly actorKind: ActorKind;
  readonly actorId: string;
  readonly displayName?: string;
  readonly provider?: IdentityProvider;
}

export interface RequestSubject {
  readonly provider: IdentityProvider;
  readonly externalUserId: string;
  readonly displayName?: string;
  readonly tenantKey?: string;
  readonly identityNamespace?: string;
  readonly identityKind?: string;
  readonly identityScope?: string;
}

export interface OperationContext {
  readonly requestId: string;
  readonly actor: RequestActor;
  readonly requestedBy?: RequestSubject;
  readonly runner?: {
    readonly runnerKind: RunnerKind;
    readonly runnerContextId?: string;
    readonly taskRunId?: string;
  };
  readonly sessionId?: string;
  readonly taskId?: string;
}

export function createOperationContext(
  input: Omit<OperationContext, "requestId"> & { readonly requestId?: string },
): OperationContext {
  return {
    ...input,
    requestId: input.requestId ?? `req_${Date.now().toString(36)}`,
  };
}
