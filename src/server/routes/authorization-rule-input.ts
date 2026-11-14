import { HTTPException } from "hono/http-exception";
import type { AuthorizationRuleInput } from "../policy/authorization-rule-store";
export function grantInputFromBody(body: Record<string, unknown>, prefix = ""): AuthorizationRuleInput {
    if ("constraints" in body || "constraintsJson" in body)
        throw new HTTPException(400, { message: "Authorization rules do not accept parameter constraints" });
    if (body.matchType !== undefined && body.matchType !== "exact" && body.matchType !== "prefix")
        throw new HTTPException(400, { message: "matchType must be exact or prefix" });
    if (body.matchType === "exact" && typeof body.target === "string" && body.target.endsWith(".*"))
        throw new HTTPException(400, { message: "Use prefix matching for wildcard targets" });
    if (body.expiresAt !== undefined && (typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt)))
        throw new HTTPException(400, { message: "expiresAt must be a finite timestamp" });
    const field = (name: string) => prefix.length === 0 ? name : `${prefix}.${name}`;
    return {
        subjectType: parseSubjectType(body.subjectType),
        subjectId: requiredString(body.subjectId, field("subjectId")),
        target: requiredString(body.target, field("target")),
        effect: parseGrantEffect(body.effect),
        ...(body.matchType === "prefix" || body.matchType === "exact" ? { matchType: body.matchType } : {}),
        ...(typeof body.expiresAt === "number"
            ? { expiresAt: body.expiresAt }
            : {}),
    };
}
function requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim())
        throw new HTTPException(400, { message: name + " is required" });
    return value.trim();
}
function parseSubjectType(value: unknown): "user" | "group" {
    if (value === "user" || value === "group")
        return value;
    throw new HTTPException(400, { message: "subjectType must be user or group" });
}
function parseGrantEffect(value: unknown): "allow" | "deny" {
    if (value === "allow" || value === "deny")
        return value;
    throw new HTTPException(400, { message: "effect must be allow or deny" });
}
