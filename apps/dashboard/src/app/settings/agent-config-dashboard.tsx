import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { BotIcon, CheckCircle2Icon, FlaskConicalIcon, Trash2Icon, PlusIcon, PencilIcon, SearchIcon, Loader2Icon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import {WorkerModels} from "../plugins/worker-models";
import type {DashboardModelProviderReference} from "@/lib/api/hooks";
import type {
  CreateAgentProfileInput,
  DashboardAgentConfigStatus,
  DashboardAgentProfile,
  DashboardAgentType,
  DashboardAgentTypeDescriptor,
  DashboardExecutionDriver,
} from "@/lib/api";

export function AgentConfigDashboardView({
  agentId,
  status,
  types,
  profiles,
  loading = false,
  error,
  onCreate,
  onCreateRevision,
  onTest,
  onActivate,
  onDelete,
}: {
  readonly agentId?:string;
  readonly status: DashboardAgentConfigStatus;
  readonly types: readonly DashboardAgentTypeDescriptor[];
  readonly profiles: readonly DashboardAgentProfile[];
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly onCreate: (input: CreateAgentProfileInput) => Promise<unknown>;
  readonly onCreateRevision?: (
    profileId: string,
    input: Omit<CreateAgentProfileInput, "name" | "agentType">,
  ) => Promise<unknown>;
  readonly onTest: (revisionId: string) => Promise<unknown>;
  readonly onActivate: (revisionId: string) => Promise<unknown>;
  readonly onDelete: (profileId: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<DashboardAgentProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [fromProvider,setFromProvider]=useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<DashboardAgentType | "all">("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const testingRef = useRef(false);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  async function testConnection(profile: DashboardAgentProfile) {
    if (testingRef.current) return;
    testingRef.current = true;
    const revisionId = profile.latestRevision.id;
    setBusy(`test-${profile.id}`);
    setTestResults((previous) => { const next = { ...previous }; delete next[revisionId]; return next; });
    try {
      await onTest(revisionId);
      setTestResults((previous) => ({ ...previous, [revisionId]: { success: true, message: "Connection succeeded" } }));
    } catch (cause) {
      setTestResults((previous) => ({ ...previous, [revisionId]: { success: false, message: cause instanceof Error ? cause.message : String(cause) } }));
    } finally { testingRef.current = false; setBusy(null); }
  }
  const active = status.status === "ready" ? status.active : null;
  const visible = profiles.filter((profile) =>
    (selected === "all" || profile.agentType === selected) &&
    [profile.name, profile.latestRevision.model, ...Object.values(profile.latestRevision.env)].join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try { await action(); } catch (cause) { setActionError(String(cause)); }
    finally { setBusy(null); }
  }
  function edit(profile: DashboardAgentProfile | null,provider=false) { setEditing(profile);setFromProvider(provider);setOpen(true); }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-5 py-7 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Model Configuration")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={loading || types.length === 0} onClick={() => edit(null)}><PlusIcon />{t("New Profile")}</Button>
          {agentId?<Button variant="outline" disabled={loading} onClick={()=>edit(null,true)}>从 Provider 添加</Button>:null}
        </div>
      </header>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span className="rounded-md border bg-muted/30 px-3 py-2">{profiles.length}{t("profiles")}</span>
        <span className="rounded-md border bg-muted/30 px-3 py-2">{types.length}{t("agent types")}</span>
        {active ? <span className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2"><span className="size-1.5 rounded-full bg-emerald-500" />{t("Current Agent:")}<span className="font-medium text-foreground">{active.name}</span> · {active.model}{active.executionDriver === "pty" ? " · PTY" : ""}</span> : null}
      </div>
      {!loading && status.status === "setup_required" ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm"><h2 className="font-medium">{t("Agent setup required")}</h2><p className="mt-1 text-muted-foreground">{t("Create a profile, test its connection, then activate it to start running work.")}</p></div> : null}
      {error || actionError ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{String(actionError ?? error)}</p> : null}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label={t("Agent types")} className="min-w-0 rounded-xl border bg-card p-3">
          <p className="px-3 py-2 text-[11px] font-medium tracking-wider text-muted-foreground">{t("AGENT TYPES")}</p>
          <div className="flex gap-1 overflow-x-auto lg:flex-col">
            {[{ type: "all" as const, label: "All agents" }, ...types].map((type) => {
              const count = profiles.filter((p) => type.type === "all" || p.agentType === type.type).length;
              return <button key={type.type} aria-pressed={selected === type.type} onClick={() => setSelected(type.type)} className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors hover:bg-muted/60 ${selected === type.type ? "bg-muted font-medium" : "text-muted-foreground"}`}><BotIcon className={`size-5 ${type.type === "claude" ? "text-orange-500" : type.type === "codex" ? "text-indigo-500" : ""}`} /><span className="flex-1"><UiText>{type.label}</UiText></span><span className="rounded-md border bg-background px-1.5 text-xs">{count}</span></button>;
            })}
          </div>
        </nav>
        <section className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><BotIcon className="size-5" />{selected === "all" ? t("All agents") : types.find((t) => t.type === selected)?.label}</h2>
            <div className="relative w-full sm:w-64"><SearchIcon className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label={t("Search profiles")} className="pl-9" placeholder={t("Search profiles, models, URLs…")} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          </div>
          {loading ? <p className="py-12 text-center text-sm text-muted-foreground">{t("Loading profiles…")}</p> : visible.length === 0 ? <div className="rounded-lg border border-dashed px-4 py-12 text-center"><BotIcon className="mx-auto mb-3 size-7 text-muted-foreground/50" /><p className="text-sm font-medium">{query ? t("No matching profiles") : t("No profiles yet")}</p><p className="mt-1 text-xs text-muted-foreground">{query ? t("Try a different name or model.") : t("Add a profile to configure this agent.")}</p></div> : <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr><th className="p-3 font-medium">{t("Profile")}</th><th className="p-3 font-medium">{t("Model / Connection")}</th><th className="p-3 font-medium">{t("Status")}</th><th className="p-3 text-right font-medium">{t("Actions")}</th></tr></thead><tbody className="divide-y">
            {visible.map((profile) => {
              const revision = profile.latestRevision;
              const isActive = active?.profileId === profile.id;
              const currentRevision = active?.revisionId === revision.id;
              const validated = revision.validationState === "validated";
              const testing = busy === `test-${profile.id}`;
              const savedMessage = revision.validationResult && typeof revision.validationResult === "object" && "message" in revision.validationResult && typeof revision.validationResult.message === "string" ? revision.validationResult.message : "";
              const testResult = testResults[revision.id] ?? (revision.validatedAt !== null ? { success: validated, message: savedMessage } : undefined);
              return <tr key={profile.id} className="align-top">
                <td className="min-w-36 p-3"><p className="font-medium">{profile.name}</p><p className="mt-1 text-xs capitalize text-muted-foreground">{profile.agentType}{t("· Revision")}{revision.revisionNumber}</p></td>
                <td className="min-w-44 max-w-64 p-3"><p className="font-mono text-xs">{revision.model}{(revision.executionDriver ?? "stdio") === "pty" ? <span className="ml-2 rounded border px-1.5 py-0.5 font-sans text-[10px] uppercase text-muted-foreground">PTY</span> : null}</p><details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{t("Connection details")}</summary><dl className="mt-3 space-y-2"><div><dt>{t("Execution driver")}</dt><dd>{(revision.executionDriver ?? "stdio") === "pty" ? t("Interactive PTY (pty)") : t("Standard pipe (stdio)")}</dd></div>{Object.entries(revision.env).map(([key, value]) => <div key={key}><dt className="break-all font-mono">{key}</dt><dd className="break-all">{value}</dd></div>)}{Object.keys(revision.secrets).map((key) => <div key={key}><dt className="break-all font-mono">{key}</dt><dd>{t("Configured (write-only)")}</dd></div>)}<div><dt>{t("Resume on model change")}</dt><dd>{revision.resumeOnModelChange ? t("Enabled") : t("Disabled")}</dd></div></dl></details></td>
                <td className="min-w-28 p-3"><span className={`inline-flex rounded-md border px-2 py-0.5 text-xs ${currentRevision ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600" : "bg-muted/40 text-muted-foreground"}`}>{currentRevision ? t("Active") : t(revision.validationState)}</span>{isActive && !currentRevision ? <p className="mt-2 text-xs text-muted-foreground">{t("Earlier revision active")}</p> : null}<div aria-live="polite" aria-atomic="true" className="mt-2 max-w-64 text-xs">{testing ? <p role="status" className="text-muted-foreground">{t("Testing connection… This may take up to 60 seconds.")}</p> : testResult ? <div role={testResult.success ? "status" : "alert"} className={testResult.success ? "text-emerald-600" : "text-destructive"}><p className="font-medium">{testResult.success ? t("Connection succeeded") : t("Connection failed")}</p>{!testResult.success ? <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{t(testResult.message || "The test did not return the expected reply.")}</p> : null}</div> : null}</div></td>
                <td className="p-3"><div className="flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap"><Button disabled={!!busy || !onCreateRevision} onClick={() => edit(profile)} size="sm" variant="outline"><PencilIcon />{t("Edit")}</Button><Button aria-label={`${t("Test connection")}: ${profile.name}`} title={t("Test connection")} disabled={!!busy} onClick={() => void testConnection(profile)} size="sm" variant="outline">{testing ? <Loader2Icon className="animate-spin" /> : <FlaskConicalIcon />}{testing ? t("Testing…") : t("Test")}</Button><Button title={currentRevision ? t("Already active") : validated ? t("Activate this revision") : t("Test the connection before activation")} disabled={currentRevision || !validated || !!busy} onClick={() => void run(`activate-${profile.id}`, () => onActivate(revision.id))} size="sm" variant="outline"><CheckCircle2Icon />{t("Activate")}</Button><Button aria-label={`${t("Delete")} ${profile.name}`} title={isActive ? t("Active profiles cannot be deleted") : t("Delete profile")} disabled={isActive || !!busy} onClick={() => void run(`delete-${profile.id}`, () => onDelete(profile.id))} size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive"><Trash2Icon /></Button></div></td>
              </tr>;
            })}
          </tbody></table></div>}
        </section>
      </div>
      <Sheet open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl" showCloseButton={!saving}>
          <SheetHeader className="border-b px-6 py-5"><SheetTitle>{editing ? `${t("Edit")} ${editing.name}` : t("New Profile")}</SheetTitle><SheetDescription>{editing ? t("Save your changes as a new revision, then test and activate it.") : t("Configure an agent and test its connection before activation.")}</SheetDescription></SheetHeader>
          {open ? <ProfileEditor key={`${editing?.id ?? "new"}/${fromProvider}`} fromProvider={fromProvider} {...(agentId ? {agentId} : {})} editing={editing} types={types} onCreate={onCreate} onCreateRevision={onCreateRevision} onCancel={() => setOpen(false)} onSavingChange={setSaving} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ProfileEditor({
  fromProvider,
  agentId,
  editing,
  types,
  onCreate,
  onCreateRevision,
  onCancel,
  onSavingChange,
}: {
  readonly fromProvider:boolean;
  readonly agentId?:string;
  readonly editing: DashboardAgentProfile | null;
  readonly types: readonly DashboardAgentTypeDescriptor[];
  readonly onCreate: (input: CreateAgentProfileInput) => Promise<unknown>;
  readonly onCreateRevision?: (
    profileId: string,
    input: Omit<CreateAgentProfileInput, "name" | "agentType">,
  ) => Promise<unknown>;
  readonly onCancel: () => void;
  readonly onSavingChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const defaultType = editing?.agentType ?? (fromProvider?"codex":types[0]?.type ?? "claude");
  const [agentType, setAgentType] = useState<DashboardAgentType>(defaultType);
  const [name, setName] = useState(editing?.name ?? "");
  const [model, setModel] = useState(editing?.latestRevision.model ?? "");
  const [executionDriver, setExecutionDriver] = useState<DashboardExecutionDriver>(editing?.latestRevision.executionDriver ?? "stdio");
  const [resume, setResume] = useState(editing?.latestRevision.resumeOnModelChange ?? true);
  const { CODEX_PROVIDER_MODE: initialConnection, ...initialEnv } = editing?.latestRevision.env ?? {};
  const [gateway, setGateway] = useState(initialConnection === "gateway");
  const [workerMode,setWorkerMode]=useState(fromProvider||!!editing?.latestRevision.modelProvider);
  const [source,setSource]=useState<DashboardModelProviderReference|null>(editing?.latestRevision.modelProvider??null);
  const [envText, setEnvText] = useState(formatPairs(initialEnv));
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const [newSecrets, setNewSecrets] = useState<Array<{ id: number; key: string; value: string }>>([]);
  const nextSecretId = useRef(0);
  const configuredKeys = Object.keys(editing?.latestRevision.secrets ?? {});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const descriptor = useMemo(
    () => types.find((item) => item.type === agentType),
    [agentType, types],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    onSavingChange(true);
    setSaveError(null);
    try {
      const env = parsePairs(envText);
      if(workerMode && (agentType!=="codex" || !source || !model))throw new Error("请选择 Worker 账号和插件模型。");
      if (agentType === "codex") {
        if (gateway && !workerMode) env.CODEX_PROVIDER_MODE = "gateway";
        else delete env.CODEX_PROVIDER_MODE;
      }
      if(workerMode)delete env.OPENAI_BASE_URL;
      const secretValues: Record<string, string> = { ...replacements };
      for (const secret of newSecrets) {
        const key = secret.key.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Each new secret needs a valid environment variable name.");
        if (configuredKeys.includes(key) || Object.hasOwn(secretValues, key)) throw new Error(`Secret ${key} already exists. Use Replace to update it.`);
        secretValues[key] = secret.value;
      }
      if (Object.values(secretValues).some((value) => value.trim().length === 0)) throw new Error("Enter a value for each new or replacement secret, or cancel that change.");
      const common = {
        modelProvider:workerMode?source:null,
        model,
        executionDriver,
        resumeOnModelChange: resume,
        env,
        secrets: Object.fromEntries(
          [...Object.entries(secretValues).filter(([key])=>!workerMode||key!=="OPENAI_API_KEY").map(([key, value]) => [key, { set: value }]),...(workerMode&&configuredKeys.includes("OPENAI_API_KEY")?[["OPENAI_API_KEY",{clear:true as const}]]:[])],
        ),
        customSensitiveKeys: Object.keys(secretValues).filter(
          (key) => !descriptor?.envFields.some((field) => field.key === key),
        ),
        customNonSensitiveKeys: Object.keys(env).filter(
          (key) => !descriptor?.envFields.some((field) => field.key === key),
        ),
      };
      if (editing !== null && onCreateRevision !== undefined) {
        await onCreateRevision(editing.id, common);
        onCancel();
      } else {
        await onCreate({ name, agentType, ...common });
        setName("");
        setModel("");
        setEnvText("");
        setReplacements({});
        setNewSecrets([]);
        setGateway(false);
        onCancel();
      }
    } catch (cause) {
      setSaveError(String(cause));
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  }

  return (
    <form className="space-y-5 px-6 pb-6" onSubmit={submit}>
      {saveError ? <p role="alert" className="text-sm text-destructive">{saveError}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span className="block">{t("Agent type")}</span>
          <SelectField
            aria-label={t("Agent type")}
            disabled={editing !== null}
            fullWidth
            value={agentType}
            onValueChange={(next) => setAgentType(next as DashboardAgentType)}
            options={types.map((type) => ({ value: type.type, label: t(type.label) }))}
          />
        </label>
        <label className="space-y-1 text-sm"><span className="block">{t("Profile name")}</span><Input disabled={editing !== null} onChange={(e) => setName(e.target.value)} required value={name} />
        </label>
        <label className="space-y-1 text-sm"><span className="block">{t("Model")}</span><Input readOnly={workerMode} onChange={(e) => setModel(e.target.value)} required value={model} />
        </label>
        <label className="space-y-1 text-sm"><span className="block">{t("Execution driver")}</span>
          <SelectField
            aria-label={t("Execution driver")}
            fullWidth
            value={executionDriver}
            onValueChange={(next) => setExecutionDriver(next as DashboardExecutionDriver)}
            options={[
              { value: "stdio", label: t("Standard pipe (stdio)") },
              { value: "pty", label: t("Interactive PTY (pty)") },
            ]}
          />
        </label>
      </div>
      {agentType === "codex" ? (
        <label className="block space-y-1 text-sm"><span className="block">{t("Connection")}</span>
          <SelectField
            aria-label={t("Connection")}
            fullWidth
            value={workerMode ? "worker" : gateway ? "gateway" : "default"}
            onValueChange={(next) => {setGateway(next === "gateway");setWorkerMode(next==="worker");}}
            options={[
              { value: "default", label: t("Default OpenAI") },
              { value: "gateway", label: t("Custom gateway") },
              ...(agentId?[{value:"worker",label:"已登录 Provider"}]:[]),
            ]}
          />
          {gateway ? <span className="block text-xs text-muted-foreground">{t("Set OPENAI_BASE_URL in Environment variables and OPENAI_API_KEY in Secrets.")}</span> : null}
        </label>
      ) : null}
      {workerMode && agentType==="codex" && agentId ? <WorkerModels key={agentId} agentId={agentId} {...(source?{selected:source}:{})} model={model} onSelect={(reference,nextModel)=>{setSource(reference);setModel(nextModel);if(!name&&reference&&nextModel)setName(`${reference.providerId} / ${nextModel}`);}}/>:null}
      <label className="flex items-center gap-2 text-sm">
        <input checked={resume} onChange={(e) => setResume(e.target.checked)} type="checkbox" />{t("Resume after model-only changes")}</label>
      {!workerMode?<><div className="grid gap-4 sm:grid-cols-1">
        <label className="space-y-1 text-sm">{t("Environment variables")}<textarea className="block min-h-24 w-full rounded-md border bg-background p-3 font-mono text-xs" onChange={(e) => setEnvText(e.target.value)} placeholder={agentType === "claude" ? "ANTHROPIC_BASE_URL=https://…" : "OPENAI_BASE_URL=https://…"} value={envText} />
        </label>
        <details open className="group rounded-xl border">
          <summary className="cursor-pointer border-b px-4 py-3 text-sm font-medium">{t("Secrets")}<span className="ml-2 text-xs font-normal text-muted-foreground">{configuredKeys.length + newSecrets.length}</span></summary>
          <section aria-label={t("Secrets")} className="space-y-3 p-4">
            <p className="text-xs text-muted-foreground">{t("Configured values are hidden. Unchanged secrets are kept.")}</p>
            {configuredKeys.map((key) => {
              const replacing = Object.hasOwn(replacements, key);
              return <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <Input aria-label={`${t("Secret key")} ${key}`} className="col-span-2 font-mono text-xs sm:col-span-1" readOnly value={key} title={key} />
                <Input aria-label={replacing ? `${t("New value for")} ${key}` : `${t("Configured value for")} ${key}`} type="password" autoComplete="new-password" spellCheck={false} disabled={saving} readOnly={!replacing} required={replacing} placeholder={t("New value")} value={replacing ? replacements[key] : "••••••••"} onChange={(e) => setReplacements((previous) => ({ ...previous, [key]: e.target.value }))} />
                <Button type="button" size="sm" variant="ghost" disabled={saving} aria-label={`${replacing ? t("Cancel replacement for") : t("Replace")} ${key}`} onClick={() => setReplacements((previous) => {
                  const next = { ...previous };
                  if (replacing) delete next[key]; else next[key] = "";
                  return next;
                })}>{replacing ? t("Cancel") : t("Replace")}</Button>
              </div>;
            })}
            {newSecrets.map((secret) => <div key={secret.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Input aria-label={t("New secret key")} autoComplete="off" spellCheck={false} className="col-span-2 font-mono text-xs sm:col-span-1" disabled={saving} required placeholder={agentType === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} value={secret.key} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === secret.id ? { ...row, key: e.target.value } : row))} />
              <Input aria-label={t("New secret value")} type="password" autoComplete="new-password" spellCheck={false} disabled={saving} required placeholder={t("Value")} value={secret.value} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === secret.id ? { ...row, value: e.target.value } : row))} />
              <Button type="button" size="icon" variant="ghost" className="text-destructive/60 hover:text-destructive" disabled={saving} aria-label={t("Remove new secret")} onClick={() => setNewSecrets((rows) => rows.filter((row) => row.id !== secret.id))}><XIcon /></Button>
            </div>)}
            <Button type="button" size="sm" variant="outline" className="border-dashed" disabled={saving} onClick={() => setNewSecrets((rows) => [...rows, { id: nextSecretId.current++, key: "", value: "" }])}><PlusIcon />{t("Add secret")}</Button>
          </section>
        </details>
      </div>
      <p className="text-xs text-muted-foreground">{t("Allowed custom prefixes:")}{" "}{descriptor?.allowedCustomPrefixes.join(", ") || "none"}{t(". Existing secrets remain unchanged when omitted.")}</p></>:<p className="text-xs text-muted-foreground">API 地址、凭据和 Worker 绑定从 Provider 自动继承。</p>}
      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background py-4">
        <Button disabled={saving} type="submit">{saving ? t("Saving…") : editing ? t("Save changes") : t("Create Profile")}</Button>
        <Button disabled={saving} onClick={onCancel} type="button" variant="outline">{t("Cancel")}</Button>
      </div>
    </form>
  );
}

function parsePairs(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Enter one KEY=value pair per line.");
    return [line.slice(0, separator).trim(), line.slice(separator + 1)];
  }));
}

function formatPairs(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
}
