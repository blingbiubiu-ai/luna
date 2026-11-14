export type AuthorizationSubjectType = "user" | "group";
export type OperationGrantEffect = "allow" | "deny";

export interface AuthorizationSubject {
  readonly type: AuthorizationSubjectType;
  readonly id: string;
}

export function isAuthorizationSubjectType(
  value: string,
): value is AuthorizationSubjectType {
  return value === "user" || value === "group";
}
