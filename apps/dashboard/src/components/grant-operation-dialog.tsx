import { useTranslation } from "@/lib/i18n";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui/button";
import type { AuthorizationSubjectType, OperationGrant, OperationPolicy, DashboardGroup, DashboardUser } from "@/lib/api";

type Rule = {subjectType: AuthorizationSubjectType; subjectId: string; target: string; matchType: "exact" | "prefix"; effect: "allow" | "deny"; expiresAt?: number};
export function GrantOperationDialog({operations, subject, onGrantBatch, onGrant, error, isSubmitting=false, triggerLabel="Add authorization rule"}: {
  operations: readonly OperationPolicy[];
  subject?: {type:AuthorizationSubjectType;id:string;label:string};
  onGrantBatch?: ((input:{items:Rule[]})=>unknown|Promise<unknown>) | undefined;
  onGrant?: ((input:Rule)=>unknown|Promise<unknown>) | undefined;
  error?: unknown;
  isSubmitting?: boolean;
  triggerLabel?: string;
  existingGrants?: readonly OperationGrant[];
  groups: readonly DashboardGroup[];
  users: readonly DashboardUser[];
}) {
  const { t } = useTranslation();
  const namespaces=[...new Set(operations.filter(o=>!subject || o.allowedSubjectTypes.includes(subject.type)).map(o=>o.namespace))];
  const [scope,setScope]=useState("");
  const effectiveScope=scope || namespaces[0] || "";
  const [path,setPath]=useState("");
  const [matchType,setMatchType]=useState<"exact"|"prefix">("prefix");
  const [effect,setEffect]=useState<"allow"|"deny">("allow");
  const [expiry,setExpiry]=useState("");
  const target=path.trim() ? `${effectiveScope}.${path.trim()}` : effectiveScope;
  const expiryMs=expiry ? new Date(expiry).getTime() : undefined;
  const valid=!!subject && !!effectiveScope && /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(target)
    && (expiryMs === undefined || (Number.isFinite(expiryMs) && expiryMs > Date.now()));
  return <ActionDialog title={t("Add authorization rule")} submitLabel={t("Save rule")} error={error} isSubmitting={isSubmitting}
    trigger={<Button variant="outline">{triggerLabel}</Button>} submitDisabled={!valid}
    onSubmit={()=>{if (!valid || !subject) return; const item:Rule={subjectType:subject.type,subjectId:subject.id,target,matchType,effect,...(expiryMs===undefined?{}:{expiresAt:expiryMs})};return onGrantBatch ? onGrantBatch({items:[item]}) : onGrant?.(item);}}
    onSuccess={()=>{setPath("");setExpiry("");}}>
    <div className="text-sm">{t("Subject:")}{" "}{subject?.label ?? "Select a user or group"}</div>
    <label className="grid gap-1 text-sm">{t("Scope")}<select aria-label={t("Scope")} className="rounded-md border bg-background p-2" value={effectiveScope} onChange={e=>{setScope(e.target.value);setPath("");}}>{namespaces.map(n=><option key={n} value={n}>{n}</option>)}</select></label>
    <label className="grid gap-1 text-sm">{t("Operation path")}<input aria-label={t("Operation path")} className="rounded-md border bg-background p-2 font-mono" list="operation-suggestions" value={path} onChange={e=>setPath(e.target.value)} placeholder={t("Leave empty for the entire scope")}/><datalist id="operation-suggestions">{operations.filter(o=>o.namespace===effectiveScope && !o.id.endsWith(".*")).map(o=><option key={o.id} value={o.id.slice(effectiveScope.length+1)}>{o.title ?? o.id}</option>)}</datalist></label>
    <label className="grid gap-1 text-sm">{t("Match")}<select aria-label={t("Match")} className="rounded-md border bg-background p-2" value={matchType} onChange={e=>setMatchType(e.target.value as "exact"|"prefix")}><option value="prefix">{t("This operation and all suboperations")}</option><option value="exact">{t("Exact operation")}</option></select></label>
    <label className="grid gap-1 text-sm">{t("Effect")}<select aria-label={t("Effect")} className="rounded-md border bg-background p-2" value={effect} onChange={e=>setEffect(e.target.value as "allow"|"deny")}><option value="allow">{t("Allow")}</option><option value="deny">{t("Deny")}</option></select></label>
    <label className="grid gap-1 text-sm">{t("Expires (optional)")}<input type="datetime-local" aria-label={t("Expires")} className="rounded-md border bg-background p-2" value={expiry} onChange={e=>setExpiry(e.target.value)}/></label>
    <div className="rounded-md bg-muted p-3 text-sm" role="status">{effect} <code>{target}{matchType==="prefix"?".*":""}</code><p className="text-muted-foreground">{t("Deny overrides allow. Parameters do not affect authorization.")}</p></div>
  </ActionDialog>;
}
