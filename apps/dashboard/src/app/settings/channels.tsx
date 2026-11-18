import { randomId } from "@/lib/random-id";
import { WorkerRoutingFields } from "@/components/worker-routing-fields";
import { ModelSelectionField, type ShadowModelChoice } from "@/components/model-selection-field";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { PlusIcon, Loader2Icon, MoreHorizontalIcon, PanelLeftCloseIcon } from "lucide-react";
import { AgentLifecycleActions, type LifecycleRequest } from "@/app/agents/agent-lifecycle-actions";
import { useAgentShadows } from "@/components/shadow-picker";
import { ShadowRootSwitch } from "@/components/shadow-root-access";
import { ShadowCard, type ShadowEnvironment } from "@/components/shadow-card";
import { useContainerConsoles, Workspace } from "@/components/container-console";
import { imageCurrent, isBlocked, kindBlockedHint, primaryContainer, rootReasons, type ConsoleKind, type ContainerRow } from "@/lib/containers";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useRouteAgent } from "@/lib/agent-route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useDashboardAuthSession } from "@/lib/api";
import { apiFetch } from "@/lib/api/client";
import type { DashboardAgentChoice } from "@/lib/api/hooks";

export const Route = createFileRoute("/$agentId/settings/channels/")({
  component: ShadowsPage,
});

interface ChannelShadow {
  id: string;
  name: string;
  status: string;
  workerRouting?: { mode: "automatic" | "bound"; workerId: string | null };
  modelSelection?: {mode:"inherit"|"fixed";revisionId:string|null;name:string|null;model:string|null;agentType:string|null;available?:boolean};
}

interface Channel {
  id: string;
  name: string;
  appId: string;
  chatId: string;
  enabled: boolean;
  hasSecret: boolean;
  bindingId: string | null;
  shadow: ChannelShadow | null;
  botIdentity: { displayName?: string } | null;
}

const blank = { id: "", name: "", appId: "", appSecret: "", chatId: "", enabled: true };

function ShadowsPage() {
  const auth = useDashboardAuthSession();
  const agent = useRouteAgent();
  return (
    auth.error ? <main className="mx-auto w-full max-w-5xl p-6"><p role="alert" className="text-destructive">无法加载登录用户。</p></main>
      : auth.isLoading ? <main className="mx-auto w-full max-w-5xl p-6"><p>正在加载…</p></main>
      : auth.data?.account?.id === agent.ownerAccountId ? <AgentShadows key={agent.id} agent={agent} /> : null
  );
}

function AgentShadows({ agent }: { agent: DashboardAgentChoice }) {
  const client = useQueryClient();
  const agentPath = encodeURIComponent(agent.id);
  const queryKey = ["luna", "channel-config", agent.id] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => apiFetch<{ channels: Channel[] }>(`/channel-config?agentId=${agentPath}`, { signal }),
  });
  const shadows = useAgentShadows(agent.id);
  const modelProfilesPath=`/agent-config/profiles?agentId=${agentPath}`;
  const modelProfiles=useQuery({
    queryKey:[modelProfilesPath],
    queryFn:({signal})=>apiFetch<{profiles:{name:string;agentType:string;latestRevision:{id:string;model:string;validationState:string}}[]}>(modelProfilesPath,{signal}),
  });
  const modelStatusPath=`/agent-config/status?agentId=${agentPath}`;
  const modelStatus=useQuery({
    queryKey:[modelStatusPath],
    queryFn:({signal})=>apiFetch<{active:{name:string;model:string;revisionId:string;agentType:string}|null}>(modelStatusPath,{signal}),
    refetchInterval:5000,
  });
  const [modelChoice,setModelChoice]=useState("inherit");
  const [initialModelChoice,setInitialModelChoice]=useState("inherit");
  const [savedModelChoice,setSavedModelChoice]=useState<ShadowModelChoice|null>(null);
  const modelChoices:ShadowModelChoice[]=modelProfiles.data?.profiles.map(profile=>({
    revisionId:profile.latestRevision.id,label:`${profile.name} · ${profile.agentType} · ${profile.latestRevision.model}`,
    validated:profile.latestRevision.validationState==="validated",
  }))??[];
  const activeModel=modelStatus.data?.active;
  if(activeModel && !modelChoices.some(choice=>choice.revisionId===activeModel.revisionId))modelChoices.push({
    revisionId:activeModel.revisionId,label:`${activeModel.name} · ${activeModel.agentType} · ${activeModel.model} · 当前激活`,validated:true,
  });
  if(savedModelChoice && !modelChoices.some(choice=>choice.revisionId===savedModelChoice.revisionId))modelChoices.push(savedModelChoice);
  const modelChanged=modelChoice!==initialModelChoice;
  const workersPath = `/agents/${agentPath}/workers`;
  const workers = useQuery({
    queryKey: [workersPath],
    queryFn: ({ signal }) => apiFetch<{
      assignments: {workerId: string; status: string; paused: boolean}[];
      workers: {workerId: string; local: boolean; connected: boolean; revoked: boolean; draining: boolean}[];
    }>(workersPath, {signal}),
    refetchInterval: 5000,
  });
  const routingOptions = workers.data?.assignments.filter(row => row.status === "active").map(row => {
    const worker = workers.data!.workers.find(item => item.workerId === row.workerId);
    return {workerId: row.workerId, label: `${worker?.local ? "同机 Worker · " : ""}${row.workerId} · ${row.paused || worker?.draining ? "暂停接单" : !worker?.connected || worker.revoked ? "离线" : "在线"}`};
  }) ?? [];
  const [routingMode, setRoutingMode] = useState<"automatic" | "bound">("automatic");
  const [boundWorkerId, setBoundWorkerId] = useState("");
  const [initialRouting, setInitialRouting] = useState({mode: "automatic" as "automatic" | "bound", workerId: ""});

  const [editing, setEditing] = useState<Channel | null>(null);
  const [creation, setCreation] = useState<{ key: string; name: string; shadow?: ChannelShadow } | null>(null);
  const [configureBot, setConfigureBot] = useState(false);
  const [target, setTarget] = useState<ChannelShadow | null>(null);
  const [shadowName, setShadowName] = useState("");
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unbinding, setUnbinding] = useState<Channel | null>(null);
  const [unbindError, setUnbindError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<{ shadowId: string; request: LifecycleRequest } | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const consoles = useContainerConsoles(agent.id);
  const channels = query.data?.channels ?? [];
  const channelsByShadow = new Map(channels.flatMap(row => row.shadow ? [[row.shadow.id, row] as const] : []));
  const shadowsById = new Map(shadows.data?.shadows.map(shadow => [shadow.id, shadow]));
  const availableBots = channels.filter(row => !row.shadow ||
    (shadowsById.get(row.shadow.id)?.status ?? row.shadow.status) === "deleted");
  const body = shadows.data?.shadows.find(shadow => shadow.id === agent.defaultShadowId);
  const digitalShadows = shadows.data?.shadows.filter(shadow => shadow.id !== agent.defaultShadowId && shadow.status !== "deleted") ?? [];
  const cards = [...(body ? [body] : []), ...digitalShadows];
  const agentActive = agent.status === "active";
  const savedBot = channels.find(row => row.id === form.id);
  const targetStatus = target && (shadowsById.get(target.id)?.status ?? target.status);
  const canConfigureBot = agentActive && (!target || targetStatus === "active");
  const name = (creation?.name ?? shadowName).trim();
  const nameChanged = Boolean(target && name !== target.name);
  // A Shadow with a Feishu bot may leave its name empty to follow the bot's name.
  const followsBot = Boolean(target && editing?.bindingId);
  const nameReady = Boolean(name) || followsBot;
  const routingChanged = routingMode !== initialRouting.mode || (routingMode === "bound" && boundWorkerId !== initialRouting.workerId);
  const validRouting = routingMode === "automatic" || routingOptions.some(worker => worker.workerId === boundWorkerId);
  const botChanged = canConfigureBot && configureBot &&
    (!editing || form.appSecret.trim() !== "" || form.chatId.trim() !== editing.chatId || form.enabled !== editing.enabled);

  function selectBot(row?: Channel, enabled = true) {
    setForm(row ? {
      id: row.id, name: row.name, appId: row.appId, chatId: row.chatId,
      enabled, appSecret: "",
    } : { ...blank, id: `feishu-${randomId()}` });
    setError(null);
  }

  function openEditor(shadow?: ChannelShadow, row?: Channel) {
    const selection=shadow?.modelSelection;
    const selected=selection?.mode==="fixed" ? selection.revisionId! : "inherit";
    setModelChoice(selected);setInitialModelChoice(selected);
    setSavedModelChoice(selection?.mode==="fixed" ? {revisionId:selection.revisionId!,label:`${selection.name} · ${selection.agentType} · ${selection.model}`,validated:selection.available!==false} : null);
    const routing = shadow?.workerRouting ?? {mode: "automatic", workerId: null};
    setRoutingMode(routing.mode);
    setBoundWorkerId(routing.workerId ?? "");
    setInitialRouting({mode: routing.mode, workerId: routing.workerId ?? ""});
    setTarget(shadow ?? null);
    setShadowName(shadow?.name ?? "");
    setCreation(shadow ? null : { key: randomId(), name: "" });
    setEditing(row ?? null);
    setConfigureBot(Boolean(row));
    selectBot(row, row?.enabled);
    setNotice(null);
  }

  function closeEditor() {
    setTarget(null);
    setCreation(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !agentActive || !nameReady || !validRouting || (!creation && !nameChanged && !botChanged && !routingChanged && !modelChanged)) return;
    setBusy(true);
    setError(null);
    let shadow = target ?? creation?.shadow;
    let renamed = false;
    try {
      if (!shadow && creation) {
        const result = await apiFetch<{ shadow: ChannelShadow }>(`/agents/${agentPath}/shadows`, {
          method: "POST", headers: { "Idempotency-Key": creation.key }, body: JSON.stringify({ name }),
        });
        shadow = result.shadow;
        setCreation({ ...creation, shadow });
      }
      if (!shadow) return;
      if(modelChanged || (creation && modelChoice!=="inherit")) {
        await apiFetch(`/agents/${agentPath}/shadows/${encodeURIComponent(shadow.id)}/model-selection`,{
          method:"PUT",body:JSON.stringify(modelChoice==="inherit" ? {mode:"inherit"} : {mode:"fixed",revisionId:modelChoice}),
        });
      }
      if (routingChanged || (creation && routingMode === "bound")) {
        await apiFetch(`/agents/${agentPath}/shadows/${encodeURIComponent(shadow.id)}/worker-routing`, {
          method: "PUT", body: JSON.stringify(routingMode === "automatic" ? {mode: "automatic"} : {mode: "bound", workerId: boundWorkerId}),
        });
      }
      if (target && nameChanged) {
        const result = await apiFetch<{ shadow: ChannelShadow }>(`/agents/${agentPath}/shadows/${encodeURIComponent(target.id)}`, {
          method: "PATCH", body: JSON.stringify({ name }),
        });
        shadow = result.shadow;
        setTarget(shadow);
        renamed = true;
      }
      if (botChanged) {
        await apiFetch("/channel-config", {
          method: "POST", body: JSON.stringify({ ...form, name: form.name || shadow.name, agentId: agent.id, shadowId: shadow.id }),
        });
      }
      setNotice(creation ? (botChanged ? "分身已创建，飞书机器人已绑定。" : "分身已创建。") : "分身设置已保存。");
      closeEditor();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "保存失败。";
      setError(creation && shadow ? `分身已创建。其余设置未能应用：${message}`
        : renamed ? `分身名称已保存。其余设置未能应用：${message}` : message);
    } finally {
      await Promise.all([client.invalidateQueries({ queryKey }), shadows.refetch()]);
      setBusy(false);
    }
  }

  async function unbind(row: Channel) {
    if (!row.bindingId || busy) return;
    setBusy(true);
    setUnbindError(null);
    try {
      await apiFetch(`/channel-config/${encodeURIComponent(row.id)}/bindings/${encodeURIComponent(row.bindingId)}?agentId=${agentPath}`, {
        method: "DELETE",
      });
      setUnbinding(null);
      setEditing(null);
      setConfigureBot(false);
      selectBot();
      setNotice("已移除飞书机器人。");
    } catch (failure) {
      setUnbindError(failure instanceof Error ? failure.message : "移除飞书机器人失败。");
    } finally {
      await client.invalidateQueries({ queryKey });
      setBusy(false);
    }
  }

  const containers = consoles.query.data?.containers ?? [];
  const containerWorkers = consoles.query.data?.workers ?? [];
  const running = cards.filter(shadow => primaryContainer(containers, shadow.id)?.running).length;
  const consoleOpen = consoles.consoles.length > 0;
  const selectedShadow = consoles.consoles.find(item => item.key === consoles.active)?.row.shadowId;
  const unreachable = containerWorkers.filter(worker => worker.error);

  function environmentOf(shadow: ChannelShadow): { env: ShadowEnvironment; row?: ContainerRow } {
    const row = primaryContainer(containers, shadow.id);
    if (!row) return { env: { state: "cold" } };
    return { row, env: {
      state: row.running ? "running" : "stopped", workerId: row.workerId, cpus: row.resources.cpus, memory: row.resources.memory,
      imageCurrent: imageCurrent(row, containerWorkers), activeJobs: row.activeJobs, activeStreams: row.activeStreams,
      elsewhere: containers.filter(other => other.shadowId === shadow.id && other !== row).map(other => ({ workerId: other.workerId, running: other.running })),
    } };
  }

  function card(shadow: ChannelShadow, compact: boolean, index: number) {
    const isBody = shadow.id === agent.defaultShadowId;
    const bot = channelsByShadow.get(shadow.id);
    const { env, row } = environmentOf(shadow);
    const active = agentActive && shadow.status === "active";
    const subtitle = [
      bot ? `飞书 · ${bot.botIdentity?.displayName ?? bot.name}${bot.enabled ? "" : "（已停用）"}` : isBody ? "Dashboard 对话 · 未绑定飞书机器人" : "未绑定飞书机器人",
      shadow.workerRouting?.mode === "bound" ? `绑定 Worker ${shadow.workerRouting.workerId}` : undefined,
      shadow.modelSelection?.mode === "fixed" ? `模型 ${shadow.modelSelection.name} · ${shadow.modelSelection.model}` : undefined,
    ].filter(Boolean).join(" · ");
    const openBlocked = (kind: ConsoleKind) => {
      if (consoles.provision.isPending) return "正在启动容器…";
      if (row?.running) return kindBlockedHint(row, kind);
      if (!active) return "分身已停用，恢复后才能启动容器";
      if (row && isBlocked(row)) return kindBlockedHint(row, kind);
      return consoles.coldHint;
    };
    const lifecycleRequest = lifecycle?.shadowId === shadow.id ? lifecycle.request : null;
    const menu = <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`${shadow.name} 的更多操作`} disabled={busy}><MoreHorizontalIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem disabled={!agentActive} onSelect={() => openEditor(shadow, bot)}>编辑设置</DropdownMenuItem>
        {row && <DropdownMenuItem disabled={isBlocked(row) || consoles.reset.isPending}
          onSelect={() => consoles.confirmReset(row, shadow.name)}>重置系统盘…</DropdownMenuItem>}
        {agentActive && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setLifecycle({ shadowId: shadow.id, request: "status" })}>
            {shadow.status === "active" ? "停用" : "恢复"}{isBody ? "本体" : "分身"}
          </DropdownMenuItem>
          {!isBody && <DropdownMenuItem variant="destructive" onSelect={() => setLifecycle({ shadowId: shadow.id, request: "delete" })}>删除分身…</DropdownMenuItem>}
        </>}
      </DropdownMenuContent>
    </DropdownMenu>;
    return <ShadowCard key={shadow.id} id={shadow.id} paletteIndex={index} name={shadow.name} isBody={isBody} subtitle={subtitle}
      statusTag={!agentActive ? "Agent 已停用" : shadow.status !== "active" ? "已停用" : undefined}
      environment={env} coldHint={consoles.coldHint} compact={compact} selected={compact && selectedShadow === shadow.id}
      root={<ShadowRootSwitch agentId={agent.id} shadowId={shadow.id} disabled={!active}
        hostRefusal={row?.root?.hostAllowed === false ? rootReasons[row.root.reason ?? ""] ?? "当前 Worker 主机不允许使用容器 Root" : undefined} />}
      menu={menu}
      footer={agentActive && <AgentLifecycleActions agentId={agent.id} shadowId={shadow.id} name={shadow.name} status={shadow.status}
        entityLabel={isBody ? "本体" : "分身"} canDelete={!isBody} request={lifecycleRequest}
        onRequestChange={request => setLifecycle(request ? { shadowId: shadow.id, request } : null)} />}
      onOpen={kind => consoles.openShadow(shadow.id, kind)} openBlocked={openBlocked} />;
  }

  const alerts = <>
    {notice && <p role="status" className="text-sm text-emerald-600">{notice}</p>}
    {(query.error || shadows.error) && <p role="alert" className="text-destructive">加载失败，请刷新重试。</p>}
    {consoles.query.error && <p role="alert" className="text-sm text-destructive">无法加载运行环境。{consoles.query.error.message}</p>}
    {unreachable.length > 0 && <p role="alert" className="text-sm text-destructive">以下 Worker 暂时无法访问：{unreachable.map(worker => worker.workerId).join("、")}</p>}
    {consoles.reset.error && <p role="alert" className="text-sm text-destructive">无法重置系统盘。{consoles.reset.error.message}</p>}
    {consoles.provision.error && <p role="alert" className="text-sm text-destructive">无法启动容器。{consoles.provision.error.message}</p>}
    {consoles.stopDesktop.error && <p role="alert" className="text-sm text-destructive">无法关闭桌面后台。{consoles.stopDesktop.error.message}</p>}
  </>;

  return (
    <>
      {consoleOpen ? <main className="flex min-h-0 w-full min-w-0 flex-1 gap-3 p-3">
        {listOpen && <aside aria-label="分身" className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto">
          <div className="flex items-center justify-between px-1">
            <span className="text-sm font-medium">数字分身</span>
            <Button size="icon-xs" variant="ghost" aria-label="收起分身列表" title="收起分身列表" onClick={() => setListOpen(false)}>
              <PanelLeftCloseIcon />
            </Button>
          </div>
          {alerts}
          {cards.map((shadow, index) => card(shadow, true, index))}
        </aside>}
        <Workspace agentId={agent.id} consoles={consoles.consoles} active={consoles.active} onActivate={consoles.setActive} onClose={consoles.close}
          listOpen={listOpen} onOpenList={() => setListOpen(true)}
          onStopDesktop={async item => { await consoles.stopDesktop.mutateAsync(item.row); consoles.close(item.key); }}
          stoppingDesktop={consoles.stopDesktop.isPending} />
      </main> : <main className="mx-auto w-full max-w-5xl space-y-5 p-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">数字分身</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {cards.length} 个分身 · {running} 个运行中。每个分身有自己的运行环境，可打开终端或桌面；可绑定一个飞书机器人。
            </p>
          </div>
          <Button disabled={!agentActive || busy || !query.data} onClick={() => openEditor()}>
            <PlusIcon className="size-4" />添加分身
          </Button>
        </header>
        {alerts}
        {query.isLoading || shadows.isLoading ? <p>正在加载…</p> : query.data && shadows.data && <div className="space-y-3">
          {cards.map((shadow, index) => card(shadow, false, index))}
          {digitalShadows.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">尚未添加分身。</p>}
        </div>}
      </main>}
      <AlertDialog open={Boolean(unbinding)} onOpenChange={value => { if (!value && !busy) setUnbinding(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除飞书机器人？</AlertDialogTitle>
            <AlertDialogDescription>「{unbinding?.name}」将停止收发飞书消息。分身、已有会话和机器人配置都会保留。</AlertDialogDescription>
          </AlertDialogHeader>
          {unbindError && <p role="alert" className="text-sm text-destructive">{unbindError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <Button variant="destructive" disabled={busy || !unbinding} onClick={() => unbinding && void unbind(unbinding)}>{busy ? "移除中…" : "确认移除"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet open={Boolean(creation || (target && targetStatus !== "deleted"))} onOpenChange={value => { if (!value && !busy) closeEditor(); }}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{target ? `编辑分身 · ${target.name}` : "添加分身"}</SheetTitle>
            <SheetDescription>飞书机器人可选。飞书应用需启用长连接事件订阅。</SheetDescription>
          </SheetHeader>
          <form className="space-y-5 p-6" onSubmit={save}>
            <label className="block space-y-2 text-sm">分身名称
              <Input required={!followsBot} maxLength={100} disabled={busy || !agentActive || Boolean(creation?.shadow)} value={creation?.name ?? shadowName}
                placeholder={followsBot ? "留空则跟随飞书机器人名称" : undefined}
                onChange={event => {
                  if (creation) setCreation({ key: randomId(), name: event.target.value });
                  else setShadowName(event.target.value);
                }} />
            </label>
            <WorkerRoutingFields mode={routingMode} workerId={boundWorkerId} workers={routingOptions}
              disabled={busy || !agentActive || workers.isLoading || workers.isError}
              onModeChange={setRoutingMode} onWorkerChange={setBoundWorkerId} />
            <ModelSelectionField value={modelChoice} choices={modelChoices}
              activeLabel={modelStatus.data?.active ? `${modelStatus.data.active.name} · ${modelStatus.data.active.model}` : null}
              disabled={busy || !agentActive || modelProfiles.isLoading || modelProfiles.isError} onChange={setModelChoice} />
            {modelProfiles.isError && <p role="alert" className="text-sm text-destructive">无法加载模型配置，请刷新后重试。</p>}
            {workers.isError && <p role="alert" className="text-sm text-destructive">无法加载 Worker，请刷新后重试。</p>}
            {canConfigureBot && target?.id !== agent.defaultShadowId && !editing && <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={configureBot} disabled={busy} onChange={event => setConfigureBot(event.target.checked)} />
              绑定飞书机器人
            </label>}
            {canConfigureBot && configureBot && <fieldset disabled={busy} className="space-y-5">
              {!editing && availableBots.length > 0 && <label className="block space-y-2 text-sm">
                <span>机器人配置</span>
                <select className="block h-9 w-full rounded-md border bg-background px-3" value={savedBot?.id ?? ""}
                  onChange={event => selectBot(availableBots.find(bot => bot.id === event.target.value))}>
                  <option value="">使用新的飞书应用</option>
                  {availableBots.map(bot => <option key={bot.id} value={bot.id}>{bot.botIdentity?.displayName ?? bot.name} · {bot.appId}</option>)}
                </select>
              </label>}
              <label className="block space-y-2 text-sm">App ID
                <Input required disabled={Boolean(savedBot)} value={form.appId} onChange={event => setForm({ ...form, appId: event.target.value })} placeholder="cli_…" />
              </label>
              <label className="block space-y-2 text-sm">App Secret
                <Input type="password" autoComplete="new-password" required={!savedBot?.hasSecret} value={form.appSecret}
                  onChange={event => setForm({ ...form, appSecret: event.target.value })}
                  placeholder={savedBot?.hasSecret ? "留空保留已保存的密钥" : "输入飞书应用密钥"} />
              </label>
              <label className="block space-y-2 text-sm">默认群聊 ID（可选）
                <Input value={form.chatId} onChange={event => setForm({ ...form, chatId: event.target.value })} placeholder="oc_…" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} />启用此机器人
              </label>
            </fieldset>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button disabled={busy || !agentActive || !nameReady || !validRouting || (!creation && !nameChanged && !botChanged && !routingChanged && !modelChanged)} type="submit" className="w-full">
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              {busy ? "正在保存…" : creation && !creation.shadow ? "创建分身" : "保存并应用"}
            </Button>
          </form>
          {target && editing?.bindingId && <div className="flex flex-wrap gap-2 border-t px-6 py-4">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => {
              setNotice(null);
              setUnbindError(null);
              setUnbinding(editing);
            }}>移除飞书机器人</Button>
          </div>}
        </SheetContent>
      </Sheet>
    </>
  );
}
