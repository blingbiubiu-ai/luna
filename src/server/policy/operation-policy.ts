import { matchesOperation } from "@/operations/operation-pattern";
import type { OperationPolicy } from "@/operations/operation-registry";
import type { AuthorizationRuleRecord } from "./authorization-rule-store";
import type { PolicyDecision } from "./policy-decision";
export function ruleMatchesOperation(rule: Pick<AuthorizationRuleRecord, "target" | "matchType">, id: string): boolean {
    return rule.matchType === "prefix" ? matchesOperation(`${rule.target}.*`, id) : rule.target === id;
}
/** Authorization is deliberately independent of request parameters. */
export function evaluateOperationPolicy(input: {
    readonly grants: readonly AuthorizationRuleRecord[];
    readonly operation: OperationPolicy;
    readonly currentTimeMs?: number;
}): PolicyDecision & {
    readonly matchedRuleIds: readonly string[];
    readonly matchedRules: readonly AuthorizationRuleRecord[];
} {
    const rules = input.grants.filter(r => ruleMatchesOperation(r, input.operation.id)
        && input.operation.allowedSubjectTypes.includes(r.subjectType)
        && (r.expiresAt === undefined || r.expiresAt > (input.currentTimeMs ?? Date.now())));
    const denies = rules.filter(r => r.effect === "deny");
    if (denies.length)
        return { decision: "forbidden", reason: "explicit deny rule matched", matchedRule: "deny_rule_match", matchedRuleIds: denies.map(r => r.id), matchedRules: denies };
    const allows = rules.filter(r => r.effect === "allow");
    if (allows.length)
        return { decision: "allow", reason: "explicit allow rule matched", matchedRule: "allow_rule_match", matchedRuleIds: allows.map(r => r.id), matchedRules: allows };
    return { decision: input.operation.defaultDecision === "allow" ? "allow" : "forbidden", reason: "operation default policy", matchedRule: "operation_default", matchedRuleIds: [], matchedRules: [] };
}
