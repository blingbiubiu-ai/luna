import { expect, test } from "bun:test";
import { feishuIdentityMetadata } from "../../src/identity/feishu-identity-scopes";

test("same tenant user links across apps while open_id remains application scoped", () => {
  const a = feishuIdentityMetadata({environment:"feishu", appId:"a", tenantKey:"t"}, {open_id:"ou_a", user_id:"person", union_id:"union"});
  const b = feishuIdentityMetadata({environment:"feishu", appId:"b", tenantKey:"t"}, {open_id:"ou_b", user_id:"person", union_id:"union"});
  expect(a.identityClaims.find(c => c.kind === "user_id")).toEqual(b.identityClaims.find(c => c.kind === "user_id"));
  expect(a.requesterIdentity?.identityScope).toBe("app:a");
  expect(b.requesterIdentity?.identityScope).toBe("app:b");
  expect(a.identityClaims.some(c => c.kind === "union_id")).toBe(false);
});

test("union evidence requires trusted developer scope and provider environments remain distinct", () => {
  const a = feishuIdentityMetadata({environment:"feishu", appId:"a", developerId:"dev"}, {union_id:"same"});
  const b = feishuIdentityMetadata({environment:"lark", appId:"a", developerId:"dev"}, {union_id:"same"});
  expect(a.identityClaims).toMatchObject([{namespace:"feishu", scope:"developer:dev", kind:"union_id"}]);
  expect(a.identityClaims).not.toEqual(b.identityClaims);
  expect(feishuIdentityMetadata({environment:"feishu", appId:"a"}, {user_id:"unscoped"}).identityClaims).toEqual([]);
  expect(() => feishuIdentityMetadata({environment:"feishu", appId:""}, {open_id:"ou"})).toThrow("identity_application_scope_required");
});
