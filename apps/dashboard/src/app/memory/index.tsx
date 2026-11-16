import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAgentShadows } from "@/components/shadow-picker";
import { useAgentBasePath, useRouteAgent } from "@/lib/agent-route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useAgentMemories, useAgentMemoryHistory } from "@/lib/api";
import type { DashboardMemoryChangeKind, DashboardMemoryFields, DashboardMemoryFilter, DashboardMemoryStatus, DashboardMemoryType } from "@/lib/api";

export const Route = createFileRoute("/$agentId/memory/")({ component: MemoryPage });

function MemoryPage() {
  const agent = useRouteAgent();
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <h1 className="text-xl font-semibold">记忆与人格</h1>
      </header>
      <MemoryEditor key={agent.id} agentId={agent.id} />
    </main>
  );
}

const TYPE_LABEL: Record<DashboardMemoryType, string> = { persona: "人格", person: "人物", feedback: "做法", project: "项目", procedure: "经验", reference: "资料" };
const ORIGIN_LABEL: Record<DashboardMemoryChangeKind, string> = { inline: "对话中写入", reflection: "事后反思", consolidation: "定期整理", owner: "所有者", migration: "旧文档迁移", forgetting: "自动遗忘" };
const STATUS_LABEL: Record<DashboardMemoryStatus, string> = { active: "有效", superseded: "已被取代", deleted: "已删除", archived: "已遗忘" };
const EMPTY: DashboardMemoryFields = { type: "project", title: "", description: "", body: "", subjectUserId: null, core: false, expiresAt: null };
const PAGE_SIZE = 50;
const day = (time: number) => new Date(time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const dateInput = (time: number | null) => time === null ? "" : new Date(time).toISOString().slice(0, 10);
const fieldsOf = ({ type, title, description, body, subjectUserId, core, expiresAt }: DashboardMemoryFields): DashboardMemoryFields => ({ type, title, description, body, subjectUserId, core, expiresAt });
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

/** Owner audit of Agent memory: who wrote what and when, with correction, deletion, restore and the core tier. */
function MemoryEditor({ agentId }: { agentId: string }) {
  const [filter, setFilter] = useState<DashboardMemoryFilter>({ query: "", type: "", originKind: "", originShadowId: "", status: "active", core: "", sort: "updatedAt", limit: PAGE_SIZE, offset: 0 });
  const { list, save, remove, restore, unarchive } = useAgentMemories(agentId, filter);
  const shadows = useAgentShadows(agentId).data?.shadows ?? [];
  const base = useAgentBasePath();
  const [selectedId, setSelectedId] = useState<string | "new">();
  const [draft, setDraft] = useState<DashboardMemoryFields>();
  /** The Shadow a new persona entry is written for. */
  const [personaShadow, setPersonaShadow] = useState("");
  const memories = list.data?.memories ?? [];
  const total = list.data?.total ?? 0;
  const selected = selectedId === "new" ? undefined : memories.find(memory => memory.id === selectedId);
  const history = useAgentMemoryHistory(agentId, selected?.id, selected?.revision);
  const form = draft ?? (selected ? fieldsOf(selected) : EMPTY);
  const pending = save.isPending || remove.isPending || restore.isPending || unarchive.isPending;
  const error = list.error ?? save.error ?? remove.error ?? restore.error ?? unarchive.error;
  const reset = () => { setDraft(undefined); save.reset(); remove.reset(); restore.reset(); unarchive.reset(); };
  const select = (id: string | "new") => { setSelectedId(id); reset(); };
  const edit = (change: Partial<DashboardMemoryFields>) => setDraft({ ...form, ...change });
  /** A changed filter starts again from the first page. */
  const narrow = (change: Partial<DashboardMemoryFilter>) => setFilter({ ...filter, ...change, offset: 0 });
  const editable = selectedId === "new" || selected?.status === "active";
  const persona = form.type === "persona";

  return (
    <section className="grid min-h-0 flex-1 gap-4 p-5 lg:grid-cols-[minmax(20rem,26rem)_1fr]">
      <aside className="flex min-h-0 flex-col gap-3 rounded-md border p-3">
        <div className="flex flex-wrap gap-2">
          <Input aria-label="搜索记忆" placeholder="搜索标题、描述、正文" className="min-w-40 flex-1" value={filter.query}
            onChange={event => narrow({ query: event.target.value })} />
          <Button type="button" variant="outline" onClick={() => select("new")}>新建记忆</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="类型" className={selectClass} value={filter.type} onChange={event => narrow({ type: event.target.value })}>
            <option value="">全部类型</option>
            {Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="写入方式" className={selectClass} value={filter.originKind} onChange={event => narrow({ originKind: event.target.value })}>
            <option value="">全部写入方式</option>
            {Object.entries(ORIGIN_LABEL).filter(([value]) => value !== "forgetting").map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="来源分身" className={selectClass} value={filter.originShadowId} onChange={event => narrow({ originShadowId: event.target.value })}>
            <option value="">全部分身</option>
            {shadows.map(shadow => <option key={shadow.id} value={shadow.id}>{shadow.name}</option>)}
          </select>
          <select aria-label="状态" className={selectClass} value={filter.status} onChange={event => narrow({ status: event.target.value })}>
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="层级" className={selectClass} value={filter.core} onChange={event => narrow({ core: event.target.value })}>
            <option value="">全部层级</option>
            <option value="true">核心</option>
            <option value="false">普通</option>
          </select>
          <select aria-label="排序" className={selectClass} value={filter.sort} onChange={event => narrow({ sort: event.target.value === "createdAt" ? "createdAt" : "updatedAt" })}>
            <option value="updatedAt">最近更新</option>
            <option value="createdAt">最近新增</option>
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          {list.isLoading ? "加载中…" : total === 0 ? "0 条" : `第 ${filter.offset + 1}–${filter.offset + memories.length} 条，共 ${total} 条`}
          {list.data && ` · 核心 ${list.data.core.used} / ${list.data.core.limit}`}
        </p>
        <ul aria-label="记忆列表" className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {memories.map(memory => (
            <li key={memory.id}>
              <button type="button" aria-current={memory.id === selectedId} onClick={() => select(memory.id)}
                className="w-full rounded-md border border-transparent p-2 text-left hover:bg-accent aria-[current=true]:border-border aria-[current=true]:bg-accent">
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">{TYPE_LABEL[memory.type]}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{memory.title}</span>
                  {memory.core && <Badge>核心</Badge>}
                  {memory.status !== "active" && <Badge variant="outline">{STATUS_LABEL[memory.status]}</Badge>}
                  {!memory.trusted && <Badge variant="outline">未受信</Badge>}
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">{memory.description}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {[memory.originShadowName, memory.originUserName, ORIGIN_LABEL[memory.originKind], day(memory.updatedAt)].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
          {!list.isLoading && memories.length === 0 && <li className="p-2 text-sm text-muted-foreground">没有符合条件的记忆</li>}
        </ul>
        <div className="flex items-center justify-between gap-2">
          <Button type="button" size="sm" variant="outline" disabled={filter.offset === 0} onClick={() => setFilter({ ...filter, offset: Math.max(0, filter.offset - PAGE_SIZE) })}>上一页</Button>
          <Button type="button" size="sm" variant="outline" disabled={filter.offset + memories.length >= total} onClick={() => setFilter({ ...filter, offset: filter.offset + PAGE_SIZE })}>下一页</Button>
        </div>
      </aside>
      <article className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-md border p-3">
        {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
        {!selected && selectedId !== "new" && <p className="text-sm text-muted-foreground">选择一条记忆查看来源和修改历史，或新建一条。</p>}
        {(selected || selectedId === "new") && <>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <label className="grid gap-1 text-sm">类型
              {/* An existing entry never changes into or out of a persona entry. */}
              <select className={selectClass} value={form.type} disabled={pending || !editable || selected?.type === "persona"}
                onChange={event => { const type = event.target.value as DashboardMemoryType; edit({ type, ...(type === "person" ? { core: false } : type === "persona" ? { core: false, expiresAt: null, subjectUserId: null } : { subjectUserId: null }) }); }}>
                {Object.entries(TYPE_LABEL).filter(([value]) => value !== "persona" || !selected || selected.type === "persona").map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">标题
              <Input value={form.title} maxLength={120} disabled={pending || !editable} onChange={event => edit({ title: event.target.value })} />
            </label>
          </div>
          {form.type === "person" && <label className="grid gap-1 text-sm">关联用户 ID{selected?.subjectUserName ? `（${selected.subjectUserName}）` : ""}
            <Input value={form.subjectUserId ?? ""} disabled={pending || !editable} onChange={event => edit({ subjectUserId: event.target.value.trim() || null })} />
          </label>}
          {persona && <label className="grid gap-1 text-sm">所属分身（人格只对这个分身生效，每次会话开始时全文告诉它）
            {selected ? <Input value={selected.originShadowName ?? selected.originShadowId ?? ""} disabled />
              : <select aria-label="所属分身" className={selectClass} value={personaShadow} disabled={pending} onChange={event => setPersonaShadow(event.target.value)}>
                <option value="">选择分身</option>
                {shadows.filter(shadow => shadow.status !== "deleted").map(shadow => <option key={shadow.id} value={shadow.id}>{shadow.name}</option>)}
              </select>}
          </label>}
          <label className="grid gap-1 text-sm">一行描述
            <Input value={form.description} maxLength={200} disabled={pending || !editable} onChange={event => edit({ description: event.target.value })} />
          </label>
          <label className="grid gap-1 text-sm">正文
            <Textarea className="min-h-40 font-mono" value={form.body} disabled={pending || !editable} onChange={event => edit({ body: event.target.value })} />
          </label>
          {!persona && <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2" title="核心记忆在每个会话开始时都会告诉分身，且不会被遗忘">
              <input type="checkbox" aria-label="核心记忆" checked={form.core} disabled={pending || !editable || form.type === "person"} onChange={event => edit({ core: event.target.checked })} />
              核心记忆（每个会话都生效）
            </label>
            <label className="flex items-center gap-2">有效期至
              <Input type="date" aria-label="有效期" className="w-40" value={dateInput(form.expiresAt)} disabled={pending || !editable}
                onChange={event => edit({ expiresAt: event.target.value ? Date.parse(`${event.target.value}T23:59:59Z`) : null })} />
            </label>
          </div>}
          <div className="flex flex-wrap justify-end gap-2">
            {draft && <Button type="button" variant="outline" disabled={pending} onClick={reset}>放弃修改</Button>}
            {selected?.status === "archived" && <Button type="button" disabled={pending}
              onClick={() => unarchive.mutate({ id: selected.id, expectedRevision: selected.revision }, { onSuccess: reset })}>恢复为有效</Button>}
            {selected?.status === "active" && <Button type="button" variant="outline" disabled={pending}
              onClick={() => remove.mutate({ id: selected.id, expectedRevision: selected.revision }, { onSuccess: reset })}>删除</Button>}
            {editable && <Button type="button" disabled={!draft || pending || (persona && !selected && !personaShadow)} onClick={() => save.mutate(
              selected ? { ...form, id: selected.id, expectedRevision: selected.revision } : { ...form, ...(persona ? { shadowId: personaShadow } : {}) },
              { onSuccess: memory => { setSelectedId(memory.id); setDraft(undefined); } })}>保存</Button>}
          </div>
        </>}
        {selected && <>
          <dl className="grid gap-x-4 gap-y-1 border-t pt-3 text-sm sm:grid-cols-[6rem_1fr]">
            <dt className="text-muted-foreground">状态</dt>
            <dd>{STATUS_LABEL[selected.status]} · 第 {selected.revision} 版 · {selected.trusted ? "受信来源" : "未受信来源"} · {selected.visibility === "shadow" ? "仅来源分身可见" : "分身间共享"}</dd>
            <dt className="text-muted-foreground">来源</dt>
            <dd>{[ORIGIN_LABEL[selected.originKind], selected.originShadowName, selected.originUserName, day(selected.createdAt)].filter(Boolean).join(" · ")}</dd>
            <dt className="text-muted-foreground">最近使用</dt>
            <dd>{day(selected.lastUsedAt)}</dd>
            {selected.originSessionId && <><dt className="text-muted-foreground">来源会话</dt>
              <dd><a className="underline" href={`${base}/sessions/${encodeURIComponent(selected.originSessionId)}`}>{selected.originSessionId}</a></dd></>}
            {selected.originTaskId && <><dt className="text-muted-foreground">来源任务</dt>
              <dd><a className="underline" href={`${base}/tasks/${encodeURIComponent(selected.originTaskId)}`}>{selected.originTaskId}</a></dd></>}
          </dl>
          <section aria-label="修改历史" className="space-y-2 border-t pt-3">
            <h2 className="text-sm font-medium">修改历史</h2>
            {history.error && <p role="alert" className="text-sm text-destructive">{history.error.message}</p>}
            {(history.data ?? []).map(entry => (
              <details key={entry.revision} className="rounded-md border p-2 text-sm">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <span>第 {entry.revision} 版</span>
                  <span className="text-muted-foreground">{[ORIGIN_LABEL[entry.changeKind], STATUS_LABEL[entry.snapshot.status], day(entry.createdAt)].join(" · ")}</span>
                  {entry.revision !== selected.revision && <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={pending}
                    onClick={event => { event.preventDefault(); restore.mutate({ id: selected.id, revision: entry.revision, expectedRevision: selected.revision }, { onSuccess: reset }); }}>
                    恢复到此版本</Button>}
                </summary>
                <p className="mt-2 font-medium">{entry.snapshot.title}</p>
                <p className="text-muted-foreground">{entry.snapshot.description}</p>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">{entry.snapshot.body}</pre>
              </details>
            ))}
          </section>
        </>}
      </article>
    </section>
  );
}
