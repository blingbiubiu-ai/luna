import { createFileRoute } from "@tanstack/react-router";
import { Brain, CheckCircle2, Eye, Pencil, Plus, RotateCcw, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useAgentShadows } from "@/components/shadow-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAgentBasePath, useRouteAgent } from "@/lib/agent-route";
import { useAgentMemories, useAgentMemoryHistory } from "@/lib/api";
import { MemorySourceLine } from "@/components/memory-source-line";
import { ApiFetchError } from "@/lib/api/client";
import type {
  DashboardMemory,
  DashboardMemoryChangeKind,
  DashboardMemoryFields,
  DashboardMemoryFilter,
  DashboardMemoryStatus,
  DashboardMemoryType
} from "@/lib/api";

export const Route = createFileRoute("/$agentId/memory/")({ component: MemoryPage });

function MemoryPage() {
  const agent = useRouteAgent();
  return <MemoryWorkspace key={agent.id} agentId={agent.id} agentName={agent.name} defaultShadowId={agent.defaultShadowId} />;
}

type Surface = "memories" | "persona";
type MemoryScope = "active" | "core" | "untrusted" | "archived" | "deleted";
type PersonaScope = "active" | "deleted";

const TYPE_META: Record<DashboardMemoryType, { label: string; dot: string; short: string; desc: string }> = {
  persona: { label: "人格", dot: "#8b9085", short: "身份语气与原则", desc: "分身身份、语气与行事原则" },
  person: { label: "人物", dot: "#5b8a72", short: "职责与沟通偏好", desc: "协作对象的职责、偏好与沟通习惯" },
  feedback: { label: "做法", dot: "#b07d4f", short: "确认的工作方式", desc: "被纠正或确认的工作方式" },
  project: { label: "项目", dot: "#5c7c99", short: "背景决策与排期", desc: "进行中的工作背景、决策与排期" },
  procedure: { label: "经验", dot: "#7d6b91", short: "可复用操作方法", desc: "可复用的排查步骤与操作方法" },
  reference: { label: "资料", dot: "#8c8c82", short: "文档与资源指针", desc: "外部文档、看板与资源指针" },
  episode: { label: "经历", dot: "#a3826b", short: "发生过的事", desc: "何时、和谁、发生了什么，由反思记录" },
};

const NON_PERSONA_TYPES: readonly DashboardMemoryType[] = ["person", "feedback", "project", "procedure", "reference"];
/** Episodes are written by reflection, not by hand, so they are a filter but not a type to create. */
const FILTER_TYPES: readonly DashboardMemoryType[] = [...NON_PERSONA_TYPES, "episode"];
const ORIGIN_LABEL: Record<DashboardMemoryChangeKind, string> = {
  inline: "对话写入",
  reflection: "事后反思",
  consolidation: "定期整理",
  owner: "所有者",
  migration: "旧文档迁移",
  forgetting: "自动遗忘",
};
const STATUS_LABEL: Record<DashboardMemoryStatus, string> = { active: "有效", deleted: "已删除", archived: "已遗忘" };
const EMPTY_MEMORY: DashboardMemoryFields = { type: "project", title: "", description: "", body: "", subjectUserId: null, core: false, expiresAt: null };
const EMPTY_PERSONA: DashboardMemoryFields = { type: "persona", title: "", description: "", body: "", subjectUserId: null, core: false, expiresAt: null };
const PAGE_SIZE = 50;

const day = (time: number) => new Date(time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const dateInput = (time: number | null) => time === null ? "" : new Date(time).toISOString().slice(0, 10);
const fieldsOf = ({ type, title, description, body, subjectUserId, core, expiresAt }: DashboardMemoryFields): DashboardMemoryFields => ({
  type, title, description, body, subjectUserId, core, expiresAt,
});
const byteSizeLabel = (text: string) => {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} B / 8 KB` : `${(bytes / 1024).toFixed(1)} KB / 8 KB`;
};

const selectClass = "h-8 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:border-ring";
const sageCardClass = "relative overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_5px_#00000004] before:absolute before:top-0 before:left-5 before:h-[3px] before:w-6 before:rounded-xs before:bg-[#a3b69e] dark:before:bg-[#8ea487]";
const cardClass = "rounded-2xl border border-border bg-card shadow-[0_2px_5px_#00000004]";

/** Service answers memory errors with a stable code and no prose. */
const ERROR_TEXT: Record<string, string> = {
  memory_revision_conflict: "这条记忆已在别处被修改，请重新选择它后再编辑。",
  memory_core_full: "核心记忆名额已满，请先取消其他条目的核心标记。",
  memory_persona_full: "这个分身的人格条目已达上限。",
  memory_protected: "这条记忆受保护，不能这样修改。",
  memory_not_active: "这条记忆不是有效状态，请先恢复。",
  memory_not_archived: "这条记忆没有被遗忘，无需恢复。",
  memory_already_trusted: "这条记忆已经是受信状态。",
  invalid_memory_title: "标题不能为空，且不超过 120 字。",
  invalid_memory_description: "一行描述不能为空，且不超过 200 字。",
  invalid_memory_body: "正文不能为空，且不超过 8 KB。",
  invalid_memory_subject: "人物记忆需要填写关联用户 ID，其他类型不能填写。",
  invalid_memory_core: "人物和人格记忆不能设为核心。",
  invalid_memory_persona: "人格记忆需要选择所属分身，且不能设置有效期。",
  invalid_memory_expiry: "有效期无效。",
  memory_revision_not_found: "要恢复的版本不存在。",
  memory_not_found: "这条记忆不存在或已不可见。",
};
const errorText = (error: Error) => (error instanceof ApiFetchError && error.code && ERROR_TEXT[error.code]) || error.message;

function TypePill({ type }: { type: DashboardMemoryType }) {
  const meta = TYPE_META[type];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: meta.dot }} />
      {meta.label}
    </span>
  );
}

/** Unified owner workspace for shared Agent memories and per-Shadow persona modules. */
function MemoryWorkspace({ agentId, agentName, defaultShadowId }: { agentId: string; agentName: string; defaultShadowId: string }) {
  const base = useAgentBasePath();
  const shadows = (useAgentShadows(agentId).data?.shadows ?? []).filter(shadow => shadow.status !== "deleted");
  const [surface, setSurface] = useState<Surface>("memories");

  // Long-term memory filters
  const [memScope, setMemScope] = useState<MemoryScope>("active");
  const [memType, setMemType] = useState("");
  const [originKind, setOriginKind] = useState("");
  const [memShadowId, setMemShadowId] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);

  // Shadow persona filters
  const [personaScope, setPersonaScope] = useState<PersonaScope>("active");
  const [personaFilterShadowId, setPersonaFilterShadowId] = useState("");
  const [previewPrompt, setPreviewPrompt] = useState(false);

  // Shared search, sort, paging, selection, and inline editor state
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"updatedAt" | "createdAt">("updatedAt");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [editorMode, setEditorMode] = useState<"new" | "edit" | null>(null);
  const [draft, setDraft] = useState<DashboardMemoryFields>();
  const [newPersonaShadow, setNewPersonaShadow] = useState("");

  const isMem = surface === "memories";
  const filter: DashboardMemoryFilter = isMem
    ? {
        query,
        type: memType,
        excludeType: memType ? "" : "persona",
        originKind,
        originShadowId: memShadowId,
        status: memScope === "archived" ? "archived" : memScope === "deleted" ? "deleted" : "active",
        core: memScope === "core" ? "true" : "",
        trusted: memScope === "untrusted" ? "false" : "",
        sort,
        limit: PAGE_SIZE,
        offset,
      }
    : {
        query,
        type: "persona",
        excludeType: "",
        originKind: "",
        originShadowId: personaFilterShadowId,
        status: personaScope,
        core: "",
        trusted: "",
        sort,
        limit: PAGE_SIZE,
        offset,
      };

  const { list, save, remove, revert, restore, confirm } = useAgentMemories(agentId, filter);
  const memories = list.data?.memories ?? [];
  const total = list.data?.total ?? 0;
  const stats = list.data?.stats;
  const coreQuota = list.data?.core;
  const personaQuota = list.data?.persona;

  const selected = editorMode === "new" ? undefined : memories.find(item => item.id === selectedId);
  const history = useAgentMemoryHistory(agentId, selected?.id, selected?.revision);
  // Where the entry was last written in a conversation; history is newest first.
  const latestSource = history.data?.find(entry => entry.snapshot.source)?.snapshot.source;

  // Auto-select the first visible entry when list changes and current selection is absent.
  useEffect(() => {
    if (editorMode === "new") return;
    if (memories.length > 0 && !memories.some(item => item.id === selectedId)) {
      setSelectedId(memories[0]!.id);
      setEditorMode(null);
      setDraft(undefined);
    }
  }, [memories, selectedId, editorMode]);

  const form = draft ?? (selected ? fieldsOf(selected) : isMem ? EMPTY_MEMORY : EMPTY_PERSONA);
  const pending = save.isPending || remove.isPending || revert.isPending || restore.isPending || confirm.isPending;
  const error = list.error ?? save.error ?? remove.error ?? revert.error ?? restore.error ?? confirm.error;

  const clearMutations = () => {
    save.reset(); remove.reset(); revert.reset(); restore.reset(); confirm.reset();
  };
  const closeEditor = () => {
    setEditorMode(null); setDraft(undefined); clearMutations();
  };
  const openCreate = () => {
    clearMutations();
    setPreviewPrompt(false);
    if (isMem) {
      setDraft(EMPTY_MEMORY);
    } else {
      setDraft(EMPTY_PERSONA);
      setNewPersonaShadow(personaFilterShadowId || defaultShadowId || shadows[0]?.id || "");
    }
    setEditorMode("new");
  };
  const openEdit = (entry: DashboardMemory) => {
    clearMutations();
    setPreviewPrompt(false);
    setSelectedId(entry.id);
    setDraft(fieldsOf(entry));
    setEditorMode("edit");
  };
  const selectEntry = (id: string) => {
    setSelectedId(id);
    setPreviewPrompt(false);
    closeEditor();
  };
  const editDraft = (change: Partial<DashboardMemoryFields>) => setDraft({ ...form, ...change });

  const switchSurface = (next: Surface) => {
    if (next === surface) return;
    setSurface(next);
    setOffset(0);
    setPreviewPrompt(false);
    closeEditor();
  };

  const hasSecondaryFilters = Boolean(originKind || memShadowId || sort !== "updatedAt");
  const activePersonaShadow = shadows.find(s => s.id === (personaFilterShadowId || selected?.originShadowId || defaultShadowId)) ?? shadows[0];
  const personaShadowUsed = activePersonaShadow ? (personaQuota?.byShadow[activePersonaShadow.id] ?? 0) : (stats?.activePersonas ?? 0);
  const personaShadowLimit = personaQuota?.limit ?? 5;

  // Active persona modules of the currently inspected Shadow (for full injection preview).
  const activeShadowPersonas = !isMem && selected
    ? [...memories.filter(m => m.status === "active" && m.originShadowId === selected.originShadowId)].reverse()
    : [];

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      {/* Top Page Header */}
      <header className="border-b border-border px-6 pt-5 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="size-2 rounded-full bg-[#a3b69e] dark:bg-[#8ea487]" />
              <span>Workspace · Memory</span>
              <Badge variant="secondary" className="ml-0.5">{agentName}</Badge>
            </div>
            <h1 className="text-xl font-semibold tracking-tight">记忆与人格</h1>
            <p className="text-xs text-muted-foreground">
              分身间共享的长期记忆，以及每个分身独立的人格设定（按会话实时注入与召回，不触发容器快照重建）
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {isMem ? (
              <div className={`${sageCardClass} px-3.5 py-2 text-xs`} title="共享核心记忆在所有分身每次新会话开始时都会注入，且不会因长期未读取而被遗忘">
                <div className="flex items-center justify-between gap-5">
                  <span className="text-muted-foreground">共享核心配额</span>
                  <span className="font-mono font-medium tabular-nums">
                    {coreQuota ? `${coreQuota.used} / ${coreQuota.limit}` : "– / 30"}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-32 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-ring transition-all"
                    style={{ width: `${Math.min(100, coreQuota ? (coreQuota.used / coreQuota.limit) * 100 : 0)}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className={`${sageCardClass} px-3.5 py-2 text-xs`} title="每个分身独立拥有最多 5 条有效人格，每次新会话开始时全文注入">
                <div className="flex items-center justify-between gap-5">
                  <span className="text-muted-foreground">{activePersonaShadow ? `${activePersonaShadow.name} · 人格配额` : "分身人格配额"}</span>
                  <span className="font-mono font-medium tabular-nums">{personaShadowUsed} / {personaShadowLimit}</span>
                </div>
                <div className="mt-1.5 h-1.5 w-32 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-ring transition-all"
                    style={{ width: `${Math.min(100, (personaShadowUsed / personaShadowLimit) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            <Button type="button" size="sm" className="h-9 px-3.5 text-xs" onClick={openCreate}>
              <Plus className="size-3.5" />
              {isMem ? "新建记忆" : "新建人格"}
            </Button>
          </div>
        </div>

        {/* Surface Switcher Tabs */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div role="tablist" aria-label="记忆与人格视图" className="inline-flex items-center rounded-lg border border-border bg-muted p-[3px]">
            <button
              type="button"
              role="tab"
              aria-selected={isMem}
              onClick={() => switchSurface("memories")}
              className={`inline-flex cursor-pointer items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all ${
                isMem ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span>长期记忆</span>
              {stats !== undefined && (
                <span className="rounded-full bg-secondary px-1.5 font-mono text-xs text-muted-foreground">{stats.activeMemories}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isMem}
              onClick={() => switchSurface("persona")}
              className={`inline-flex cursor-pointer items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all ${
                !isMem ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span>分身人格</span>
              {stats !== undefined && (
                <span className="rounded-full bg-secondary px-1.5 font-mono text-xs text-muted-foreground">{stats.activePersonas}</span>
              )}
            </button>
          </div>

          {isMem && stats ? (
            <div className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400" />
                有效 <strong className="font-mono font-medium text-foreground">{stats.activeMemories}</strong>
              </span>
              <span>·</span>
              <button
                type="button"
                onClick={() => { setMemScope("archived"); setOffset(0); closeEditor(); }}
                className="cursor-pointer hover:text-foreground"
              >
                已遗忘 <strong className="font-mono font-medium text-foreground">{stats.archivedMemories}</strong>
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => { setMemScope("untrusted"); setOffset(0); closeEditor(); }}
                className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground"
              >
                <span className="size-1.5 rounded-full bg-amber-500" />
                待确认 <strong className="font-mono font-medium text-foreground">{stats.untrustedMemories}</strong>
              </button>
            </div>
          ) : (
            <div className="hidden text-xs text-muted-foreground sm:block">
              仅 Agent 所有者可编辑 · 每次会话启动全文注入 · 不随常规记忆遗忘
            </div>
          )}
        </div>
      </header>

      {/* Unified Master-Detail Workspace */}
      <section className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[23.5rem_1fr]">
        {/* Left List Rail */}
        <aside className="flex min-h-0 flex-col border-b border-border bg-sidebar lg:border-r lg:border-b-0">
          <div className="space-y-3 border-b border-border p-4">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="搜索记忆"
                  placeholder={isMem ? "搜索标题、描述或正文…" : "搜索人格标题、描述或正文…"}
                  className="h-9 bg-card pl-9 text-xs"
                  value={query}
                  onChange={event => { setQuery(event.target.value); setOffset(0); }}
                />
              </div>
              {isMem && (
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen(!moreOpen)}
                  className={`inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
                    moreOpen || hasSecondaryFilters
                      ? "border-primary/40 bg-accent font-medium text-foreground"
                      : "border-input bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <SlidersHorizontal className="size-3.5" />
                  筛选
                </button>
              )}
            </div>

            {isMem ? (
              <>
                {/* Scope Segmented Bar */}
                <div className="grid grid-cols-5 gap-0.5 rounded-lg border border-border bg-muted p-[3px] text-xs">
                  {([
                    ["active", "有效"],
                    ["core", "核心"],
                    ["untrusted", "待确认"],
                    ["archived", "已遗忘"],
                    ["deleted", "已删除"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => { setMemScope(value); setOffset(0); closeEditor(); }}
                      className={`cursor-pointer rounded-md py-1 text-xs font-medium transition-colors ${
                        memScope === value ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Type Pills */}
                <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
                  {([["", "全部"], ...FILTER_TYPES.map(t => [t, TYPE_META[t].label])] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => { setMemType(value); setOffset(0); closeEditor(); }}
                      className={`shrink-0 cursor-pointer rounded-full px-2.5 py-1 text-xs transition-colors ${
                        memType === value
                          ? "bg-primary font-medium text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {moreOpen && (
                  <div className="grid grid-cols-3 gap-1.5 border-t border-border pt-2.5 text-xs">
                    <select
                      aria-label="写入方式"
                      className={selectClass}
                      value={originKind}
                      onChange={event => { setOriginKind(event.target.value); setOffset(0); }}
                    >
                      <option value="">全部来源</option>
                      {Object.entries(ORIGIN_LABEL).filter(([k]) => k !== "forgetting").map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    <select
                      aria-label="来源分身"
                      className={selectClass}
                      value={memShadowId}
                      onChange={event => { setMemShadowId(event.target.value); setOffset(0); }}
                    >
                      <option value="">全部分身</option>
                      {shadows.map(shadow => <option key={shadow.id} value={shadow.id}>{shadow.name}</option>)}
                    </select>
                    <select
                      aria-label="排序"
                      className={selectClass}
                      value={sort}
                      onChange={event => { setSort(event.target.value === "createdAt" ? "createdAt" : "updatedAt"); setOffset(0); }}
                    >
                      <option value="updatedAt">最近更新</option>
                      <option value="createdAt">最近新增</option>
                    </select>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Persona Status Bar */}
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted p-[3px] text-xs">
                  {([
                    ["active", "有效人格"],
                    ["deleted", "已删除历史"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => { setPersonaScope(value); setOffset(0); closeEditor(); }}
                      className={`cursor-pointer rounded-md py-1 text-xs font-medium transition-colors ${
                        personaScope === value ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Shadow Filter Pills */}
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { setPersonaFilterShadowId(""); setOffset(0); closeEditor(); }}
                    className={`cursor-pointer rounded-full px-2.5 py-1 text-xs transition-colors ${
                      personaFilterShadowId === ""
                        ? "bg-primary font-medium text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    全部分身
                  </button>
                  {shadows.map(shadow => {
                    const used = personaQuota?.byShadow[shadow.id] ?? 0;
                    const active = personaFilterShadowId === shadow.id;
                    return (
                      <button
                        key={shadow.id}
                        type="button"
                        onClick={() => { setPersonaFilterShadowId(shadow.id); setOffset(0); closeEditor(); }}
                        className={`cursor-pointer rounded-full px-2.5 py-1 text-xs transition-colors ${
                          active
                            ? "bg-primary font-medium text-primary-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground"
                        }`}
                      >
                        {shadow.name} <span className="font-mono opacity-75">{used}/{personaShadowLimit}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Entry List */}
          <ul aria-label="记忆列表" className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5">
            {memories.map(memory => {
              const isSelected = editorMode !== "new" && memory.id === selected?.id;
              return (
                <li key={memory.id}>
                  <button
                    type="button"
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => selectEntry(memory.id)}
                    className={`block w-full cursor-pointer rounded-xl px-3 py-2.5 text-left transition-colors ${
                      isSelected
                        ? "bg-accent shadow-[inset_0_0_0_1px_var(--border)]"
                        : "hover:bg-accent/70"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <TypePill type={memory.type} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{memory.title}</span>
                      {memory.type === "persona" && memory.originShadowName && (
                        <Badge variant="outline" className="px-2 py-0 text-xs text-muted-foreground">{memory.originShadowName}</Badge>
                      )}
                      {memory.core && <Badge className="px-2 py-0 text-xs">核心</Badge>}
                      {memory.status !== "active" && <Badge variant="outline" className="px-2 py-0 text-xs">{STATUS_LABEL[memory.status]}</Badge>}
                      {!memory.trusted && (
                        <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-900 dark:text-amber-200">
                          待确认
                        </span>
                      )}
                    </span>
                    <span className="mt-1.5 block truncate text-xs text-muted-foreground">{memory.description}</span>
                    <span className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate">
                        {[
                          memory.type === "persona" ? `v${memory.revision}` : (memory.originShadowName || "分身间共享"),
                          memory.originUserName,
                          ORIGIN_LABEL[memory.originKind],
                          day(memory.updatedAt),
                        ].filter(Boolean).join(" · ")}
                      </span>
                      {memory.expiresAt !== null && <span className="shrink-0 font-mono">{dateInput(memory.expiresAt)} 到期</span>}
                      {memory.type !== "persona" && memory.visibility === "shadow" && <span className="shrink-0">分身私有</span>}
                    </span>
                  </button>
                </li>
              );
            })}

            {!list.isLoading && memories.length === 0 && (
              <li className="px-4 py-12 text-center">
                <p className="text-xs font-medium text-foreground">
                  {isMem ? "没有符合条件的长期记忆" : "当前筛选下暂无分身人格"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {query || memType || originKind || memShadowId
                    ? "可尝试切换上方分类或清空搜索关键词。"
                    : isMem
                      ? "Luna 会在对话纠正、静默反思或手动录入时沉淀记忆。"
                      : "人格条目取代了旧版 SOUL.md 与 USER.md，可在右侧新建。"}
                </p>
              </li>
            )}
          </ul>

          {/* Pagination Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            <span>
              {list.isLoading ? "加载中…" : total === 0 ? "0 条记录" : `第 ${offset + 1}–${offset + memories.length} 条，共 ${total} 条`}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                上一页
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={offset + memories.length >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                下一页
              </Button>
            </div>
          </div>
        </aside>

        {/* Right Unified Inspector / Inline Editor / Revision History Pane */}
        <article className="min-h-0 min-w-0 overflow-y-auto bg-background p-6 lg:p-8">
          <div className="mx-auto max-w-3xl space-y-6">
            {error && (
              <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                {errorText(error)}
              </div>
            )}

            {/* Mode 1: Unified Inline Editor (Create or Edit, staying inside current tab) */}
            {(editorMode === "new" || (editorMode === "edit" && selected)) ? (() => {
              const isPersona = form.type === "persona";
              const isPerson = form.type === "person";
              return (
                <div className="space-y-6">
                  <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
                    <div>
                      <h2 className="text-lg font-semibold tracking-tight">
                        {editorMode === "new" ? (isPersona ? "新建分身人格" : "新建长期记忆") : (isPersona ? "编辑分身人格" : "编辑记忆条目")}
                      </h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {isPersona
                          ? "定义该分身的名字、语气与固定原则；每次新对话开始时在 Who you are 下全文注入。"
                          : "一条记忆只记录一个独立事实；标题与一行描述决定了它在何时被对话自动召回。"}
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={pending} onClick={closeEditor}>
                      取消
                    </Button>
                  </div>

                  {!isPersona ? (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium">记忆类型</span>
                        <span className="text-xs text-muted-foreground">{TYPE_META[form.type].desc}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        {NON_PERSONA_TYPES.map(t => {
                          const meta = TYPE_META[t];
                          const active = form.type === t;
                          return (
                            <button
                              key={t}
                              type="button"
                              disabled={pending}
                              onClick={() => editDraft({
                                type: t,
                                ...(t === "person" ? { core: false } : { subjectUserId: null }),
                              })}
                              className={`min-w-0 cursor-pointer rounded-xl border px-3 py-2.5 text-left transition-colors ${
                                active ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/60"
                              }`}
                            >
                              <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-foreground">
                                <span className="size-2 shrink-0 rounded-full" style={{ background: meta.dot }} />
                                {meta.label}
                              </span>
                              <span className="mt-1 block truncate text-xs text-muted-foreground">{meta.short}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <label className="grid gap-1.5 text-xs">
                      <span className="font-medium">
                        所属分身 <span className="font-normal text-muted-foreground">（人格只对该分身生效，创建后不可跨分身转移）</span>
                      </span>
                      {selected ? (
                        <Input value={selected.originShadowName ?? selected.originShadowId ?? ""} disabled className="h-9 text-xs" />
                      ) : (
                        <select
                          aria-label="所属分身"
                          className="h-9 w-full rounded-lg border border-input bg-card px-3 text-xs text-foreground"
                          value={newPersonaShadow}
                          disabled={pending}
                          onChange={event => setNewPersonaShadow(event.target.value)}
                        >
                          <option value="">选择分身</option>
                          {shadows.map(shadow => <option key={shadow.id} value={shadow.id}>{shadow.name}</option>)}
                        </select>
                      )}
                    </label>
                  )}

                  {isPerson && (
                    <label className="grid gap-1.5 text-xs">
                      <span className="font-medium">
                        关联用户 ID{selected?.subjectUserName ? `（${selected.subjectUserName}）` : ""}{" "}
                        <span className="font-normal text-muted-foreground">（仅当该用户参与会话时可见）</span>
                      </span>
                      <Input
                        value={form.subjectUserId ?? ""}
                        disabled={pending}
                        placeholder="例如：user_..."
                        className="h-9 font-mono text-xs"
                        onChange={event => editDraft({ subjectUserId: event.target.value.trim() || null })}
                      />
                    </label>
                  )}

                  <div className="grid gap-4">
                    <label className="grid gap-1.5 text-xs">
                      <span className="flex items-center justify-between">
                        <span className="font-medium">标题</span>
                        <span className="font-mono text-muted-foreground">{form.title.length} / 120</span>
                      </span>
                      <Input
                        aria-label="标题"
                        value={form.title}
                        maxLength={120}
                        disabled={pending}
                        placeholder={isPersona ? "例如：身份与说话语气 / 风险操作确认原则" : "简明概括这条事实，例如：周报与复盘格式要求"}
                        className="h-9 text-xs"
                        onChange={event => editDraft({ title: event.target.value })}
                      />
                    </label>

                    <label className="grid gap-1.5 text-xs">
                      <span className="flex items-center justify-between">
                        <span className="font-medium">
                          {isPersona ? "一行描述" : "一行召回描述"}{" "}
                          <span className="font-normal text-muted-foreground">
                            {isPersona ? "（用于列表概览）" : "（请包含触发场景的常见关键词）"}
                          </span>
                        </span>
                        <span className="font-mono text-muted-foreground">{form.description.length} / 200</span>
                      </span>
                      <Input
                        aria-label="一行描述"
                        value={form.description}
                        maxLength={200}
                        disabled={pending}
                        placeholder={isPersona ? "一句话说明该人格模块的用途" : "模型默认通过标题和这行描述判断是否按需读取正文"}
                        className="h-9 text-xs"
                        onChange={event => editDraft({ description: event.target.value })}
                      />
                    </label>

                    <label className="grid gap-1.5 text-xs">
                      <span className="flex items-center justify-between">
                        <span className="font-medium">{isPersona ? "人格指令全文" : "正文"}</span>
                        <span className="font-mono text-muted-foreground">{byteSizeLabel(form.body)}</span>
                      </span>
                      <Textarea
                        aria-label="正文"
                        className="min-h-44 rounded-xl font-mono text-xs leading-6"
                        value={form.body}
                        disabled={pending}
                        placeholder={isPersona ? "编写希望该分身遵循的身份、语气与基本原则…" : "展开具体规则、原因、步骤或外部资源地址…"}
                        onChange={event => editDraft({ body: event.target.value })}
                      />
                    </label>
                  </div>

                  {!isPersona && (
                    <div className={`${cardClass} flex flex-wrap items-center justify-between gap-4 p-4`}>
                      <label className="flex cursor-pointer items-start gap-2.5 text-xs" title="核心记忆在每个会话开始时都会告诉分身，且不会被遗忘">
                        <input
                          type="checkbox"
                          aria-label="核心记忆"
                          checked={form.core}
                          disabled={pending || isPerson}
                          className="mt-0.5 accent-primary"
                          onChange={event => editDraft({ core: event.target.checked })}
                        />
                        <span className="space-y-0.5">
                          <span className="block font-medium text-foreground">设为常驻核心记忆（Core）</span>
                          <span className="block text-muted-foreground">
                            每次会话开始时都会告知分身，且不会因长期未读取而遗忘{isPerson ? "（人物记忆不可设为核心）" : ""}
                          </span>
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">有效期至</span>
                        <Input
                          type="date"
                          aria-label="有效期"
                          className="h-8 w-38 font-mono text-xs"
                          value={dateInput(form.expiresAt)}
                          disabled={pending}
                          onChange={event => editDraft({ expiresAt: event.target.value ? Date.parse(`${event.target.value}T23:59:59Z`) : null })}
                        />
                      </label>
                    </div>
                  )}

                  <div className="flex flex-wrap justify-end gap-2 pt-1">
                    <Button type="button" variant="outline" size="sm" className="h-9 px-4 text-xs" disabled={pending} onClick={closeEditor}>
                      放弃修改
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-9 px-4 text-xs"
                      disabled={pending || (isPersona && !selected && !newPersonaShadow)}
                      onClick={() => save.mutate(
                        selected
                          ? { ...form, id: selected.id, expectedRevision: selected.revision }
                          : { ...form, ...(isPersona ? { shadowId: newPersonaShadow } : {}) },
                        {
                          onSuccess: memory => {
                            setSelectedId(memory.id);
                            setEditorMode(null);
                            setDraft(undefined);
                          },
                        },
                      )}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              );
            })() : !selected ? (
              /* Mode 2: Empty / Unselected State */
              <div className="mx-auto flex min-h-96 max-w-md flex-col items-center justify-center space-y-4 text-center">
                <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted text-muted-foreground">
                  <Brain className="size-5" />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-base font-semibold tracking-tight">
                    {isMem
                      ? (total === 0 ? "还没有符合条件的长期记忆" : "选择左侧一条记忆查看详情")
                      : (total === 0 ? "尚未配置分身人格" : "选择左侧一条人格查看详情")}
                  </h2>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {isMem
                      ? "Luna 会在日常对话被纠正时实时记录，也会在会话静默后自动反思、每日定时合并去重。你也可以直接手动录入核心规范。"
                      : "人格条目取代了旧版的 SOUL.md 与 USER.md，每个分身最多启用 5 条，每次对话开始时全文注入给对应分身。"}
                  </p>
                </div>
                <div className="flex items-center gap-2.5 pt-1">
                  <Button type="button" size="sm" className="h-9 px-4 text-xs" onClick={openCreate}>
                    <Plus className="size-3.5" />
                    {isMem ? "新建记忆" : "新建人格"}
                  </Button>
                  {isMem && (
                    <Button type="button" variant="outline" size="sm" className="h-9 px-4 text-xs" onClick={() => switchSurface("persona")}>
                      管理分身人格
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              /* Mode 3: Unified Read-First Inspector + Provenance + Revision History */
              <>
                {/* Untrusted Confirmation Banner */}
                {selected.status === "active" && !selected.trusted && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs">
                    <div className="space-y-0.5">
                      <p className="font-medium text-amber-900 dark:text-amber-200">待确认记忆 · 当前仅对作者本人参与的会话可见</p>
                      <p className="text-muted-foreground">
                        由「{selected.originUserName ?? selected.originUserId ?? ORIGIN_LABEL[selected.originKind]}」触发写入；确认共享或编辑保存后即可对所有分身会话生效。
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        disabled={pending}
                        title="确认后这条记忆对所有分身、所有会话可见"
                        onClick={() => confirm.mutate({ id: selected.id, expectedRevision: selected.revision }, { onSuccess: clearMutations })}
                      >
                        <CheckCircle2 className="size-3.5" />
                        确认共享
                      </Button>
                      <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={pending} onClick={() => openEdit(selected)}>
                        审核编辑
                      </Button>
                    </div>
                  </div>
                )}

                {/* Inspector Header Badges & Action Bar */}
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <TypePill type={selected.type} />
                      {selected.core && <Badge className="px-2.5 py-0.5 text-xs">常驻核心</Badge>}
                      <Badge variant="outline" className="px-2.5 py-0.5 text-xs text-muted-foreground">
                        {STATUS_LABEL[selected.status]} · 第 {selected.revision} 版
                      </Badge>
                      <Badge variant="outline" className="px-2.5 py-0.5 text-xs text-muted-foreground">
                        {selected.type === "persona"
                          ? `所属分身：${selected.originShadowName ?? selected.originShadowId ?? "未知"}`
                          : selected.visibility === "shadow"
                            ? `仅「${selected.originShadowName ?? "来源分身"}」可见`
                            : selected.trusted
                              ? "分身间共享"
                              : "仅作者在场可见"}
                      </Badge>
                      {selected.type === "person" && (selected.subjectUserName || selected.subjectUserId) && (
                        <Badge variant="outline" className="px-2.5 py-0.5 text-xs text-muted-foreground">
                          关联人物：{selected.subjectUserName ?? selected.subjectUserId}
                        </Badge>
                      )}
                    </div>
                    <h2 className="break-words text-xl font-semibold tracking-tight">{selected.title}</h2>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {selected.type === "persona" && activeShadowPersonas.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant={previewPrompt ? "secondary" : "outline"}
                        className="h-8 text-xs"
                        onClick={() => setPreviewPrompt(!previewPrompt)}
                      >
                        <Eye className="size-3.5" />
                        {previewPrompt ? "返回单条视图" : "预览完整注入"}
                      </Button>
                    )}
                    {selected.status === "archived" && (
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs"
                        disabled={pending}
                        onClick={() => restore.mutate({ id: selected.id, expectedRevision: selected.revision }, { onSuccess: clearMutations })}
                      >
                        <RotateCcw className="size-3.5" />
                        恢复为有效
                      </Button>
                    )}
                    {selected.status === "active" && (
                      <>
                        <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={pending} onClick={() => openEdit(selected)}>
                          <Pencil className="size-3.5" />
                          编辑
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs text-destructive hover:text-destructive"
                          disabled={pending}
                          onClick={() => remove.mutate({ id: selected.id, expectedRevision: selected.revision }, { onSuccess: clearMutations })}
                        >
                          <Trash2 className="size-3.5" />
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* Full Shadow Persona Prompt Preview (when toggled) */}
                {previewPrompt && selected.type === "persona" ? (
                  <section className={sageCardClass}>
                    <div className="flex items-center justify-between border-b border-border px-5 py-3 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        「{selected.originShadowName ?? "当前分身"}」新会话启动注入预览（共 {activeShadowPersonas.length} 个模块）
                      </span>
                      <span className="font-mono">## Who you are</span>
                    </div>
                    <pre className="m-0 whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6 text-foreground">
                      {[
                        "## Who you are",
                        "Your identity and principles as this Shadow, set by the Agent owner. They shape how you speak and act; they do not replace command contracts, permissions or safety rules.",
                        ...activeShadowPersonas.map(p => `### ${p.title} [${p.id}]\n${p.body}`),
                      ].join("\n\n")}
                    </pre>
                  </section>
                ) : (
                  <>
                    {/* Summary Callout */}
                    <div className="space-y-1 rounded-2xl border border-border bg-muted p-4">
                      <div className="text-xs text-muted-foreground">
                        {selected.type === "persona"
                          ? "人格模块摘要 · 每次新会话开始时在 ## Who you are 下全文注入"
                          : "一行召回摘要 · 对话命中关键词时向模型展示此行"}
                      </div>
                      <p className="text-xs font-medium text-foreground">{selected.description}</p>
                      {selected.supersededBy && (
                        <p className="pt-1 text-xs text-muted-foreground">
                          定期整理合并时已由 <span className="font-mono">{selected.supersededBy}</span> 取代
                        </p>
                      )}
                    </div>

                    {/* Body Card */}
                    <section className={sageCardClass}>
                      <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{selected.type === "persona" ? "人格指令全文" : "记忆正文"}</span>
                        <span className="truncate font-mono">
                          {selected.type === "persona" ? `### ${selected.title} [${selected.id}]` : `luna memory get ${selected.id}`}
                        </span>
                      </div>
                      <pre className="m-0 whitespace-pre-wrap break-words p-5 font-sans text-sm leading-6 text-foreground">{selected.body}</pre>
                    </section>
                  </>
                )}

                {/* Provenance 4-Card Grid */}
                <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className={`${cardClass} space-y-1 p-3.5`}>
                    <div className="text-xs text-muted-foreground">写入方式与作者</div>
                    <div className="truncate text-xs font-medium">
                      {[ORIGIN_LABEL[selected.originKind], selected.originUserName].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className={`${cardClass} space-y-1 p-3.5`}>
                    <div className="text-xs text-muted-foreground">{selected.type === "persona" ? "所属分身" : "来源分身"}</div>
                    <div className="truncate text-xs font-medium">{selected.originShadowName ?? "无（平台/所有者）"}</div>
                  </div>
                  <div className={`${cardClass} space-y-1 p-3.5`}>
                    <div className="text-xs text-muted-foreground">{selected.type === "persona" ? "创建时间" : "最近使用"}</div>
                    <div className="truncate text-xs font-medium">
                      {selected.type === "persona" ? day(selected.createdAt) : day(selected.lastUsedAt)}
                      {selected.expiresAt !== null ? ` · ${dateInput(selected.expiresAt)} 到期` : ""}
                    </div>
                  </div>
                  <div className={`${cardClass} space-y-1 p-3.5`}>
                    <div className="text-xs text-muted-foreground">来源上下文</div>
                    <div className="truncate text-xs font-medium">
                      {latestSource ? (
                        <a className="underline hover:text-primary" title="打开会话并定位到最近一次写入时的消息"
                          href={`${base}/sessions/${encodeURIComponent(latestSource.sessionId)}?entry=${encodeURIComponent(latestSource.entryId)}`}>
                          会话 {latestSource.sessionId.slice(0, 8)} · {day(latestSource.at)} 原文
                        </a>
                      ) : selected.originSessionId && (
                        <a className="underline hover:text-primary" href={`${base}/sessions/${encodeURIComponent(selected.originSessionId)}`}>
                          会话 {selected.originSessionId.slice(0, 8)}
                        </a>
                      )}
                      {selected.originSessionId && selected.originTaskId && " · "}
                      {selected.originTaskId && (
                        <a className="underline hover:text-primary" href={`${base}/tasks/${encodeURIComponent(selected.originTaskId)}`}>
                          任务 {selected.originTaskId.slice(0, 8)}
                        </a>
                      )}
                      {!selected.originSessionId && !selected.originTaskId && (
                        <span className="text-muted-foreground">手动录入 / 迁移</span>
                      )}
                    </div>
                  </div>
                </section>

                {/* Revision History */}
                <section aria-label="修改历史" className="space-y-2.5 pt-1">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    修改历史{history.data ? `（共 ${history.data.length} 个版本）` : ""}
                  </h3>
                  {history.error && <p role="alert" className="text-xs text-destructive">{errorText(history.error)}</p>}
                  <ol className="space-y-2">
                    {(history.data ?? []).map(entry => (
                      <li key={entry.revision} className={cardClass}>
                        <details>
                          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-2.5 text-xs">
                            <span className="rounded-full bg-secondary px-2 py-0.5 font-mono font-medium text-secondary-foreground">
                              第 {entry.revision} 版
                            </span>
                            <span className="font-medium">{ORIGIN_LABEL[entry.changeKind]}</span>
                            <span className="text-muted-foreground">
                              · {STATUS_LABEL[entry.snapshot.status]} · {day(entry.createdAt)}
                            </span>
                            {entry.snapshot.source ? (
                              <a className="text-primary hover:underline" data-testid="memory-version-source"
                                href={`${base}/sessions/${encodeURIComponent(entry.snapshot.source.sessionId)}?entry=${encodeURIComponent(entry.snapshot.source.entryId)}`}>
                                原文
                              </a>
                            ) : null}
                            {entry.revision === selected.revision ? (
                              <span className="ml-auto text-xs text-muted-foreground">当前版本</span>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="ml-auto h-7 px-2.5 text-xs"
                                disabled={pending}
                                onClick={event => {
                                  event.preventDefault();
                                  revert.mutate({ id: selected.id, revision: entry.revision, expectedRevision: selected.revision }, { onSuccess: clearMutations });
                                }}
                              >
                                回退到此版本
                              </Button>
                            )}
                          </summary>
                          <div className="space-y-1.5 border-t border-border px-4 pt-2.5 pb-4 text-xs">
                            {entry.snapshot.source ? <MemorySourceLine agentId={agentId} source={entry.snapshot.source} /> : null}
                            <p className="font-medium">{entry.snapshot.title}</p>
                            <p className="text-muted-foreground">{entry.snapshot.description}</p>
                            <pre className="m-0 mt-2 whitespace-pre-wrap break-words rounded-xl bg-muted p-3 font-mono text-xs">
                              {entry.snapshot.body}
                            </pre>
                          </div>
                        </details>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
          </div>
        </article>
      </section>
    </main>
  );
}
