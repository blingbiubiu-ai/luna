export type PolicyDecisionKind =
  | "allow"
  | "forbidden"
  | "hidden";

export interface PolicyDecision {
  readonly decision: PolicyDecisionKind;
  readonly reason: string;
  readonly matchedRule?: string;
}
