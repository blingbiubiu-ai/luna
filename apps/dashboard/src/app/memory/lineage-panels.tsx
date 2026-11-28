import {
  ArrowRight,
  Check,
  Copy,
  EyeOff,
  GitFork,
  GitPullRequestArrow,
  Link2,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { Textarea } from "@/components/ui/textarea";
import { appHistory } from "@/lib/app-history";
import {
  useAgentLineage,
  useAgentSubscription,
  type DashboardLineageMemory,
  type LineageMemoryType,
} from "@/lib/api/lineage";

const LINEAGE_TYPE_META: Record<LineageMemoryType, { label: string; dot: string }> = {
  procedure: { label: "经验", dot: "#7d6b91" },
  feedback: { label: "做法", dot: "#b07d4f" },
  reference: { label: "资料", dot: "#8c8c82" },
  project: { label: "项目", dot: "#5c7c99" },
};

const LINEAGE_TYPE_OPTIONS = (Object.entries(LINEAGE_TYPE_META) as [LineageMemoryType, { label: string; dot: string }][]).map(
  ([value, meta]) => ({ value, label: `${meta.label} (${value})` }),
);

const CONTRIBUTION_STATUS_LABELS: Record<string, string> = {
  pending_owner: "待 Owner 确认",
  pending_lineage: "待传承方审批",
  approved: "已合入传承",
  rejected_by_owner: "Owner 已忽略",
  rejected_by_lineage: "传承方已退回",
  cancelled: "已取消",
  expired: "已过期",
};

const sageCardClass =
  "relative overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_5px_#00000004] before:absolute before:top-0 before:left-5 before:h-[3px] before:w-6 before:rounded-xs before:bg-[#a3b69e] dark:before:bg-[#8ea487]";
const cardClass = "rounded-2xl border border-border bg-card shadow-[0_2px_5px_#00000004]";

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function LineageTypePill({ type }: { readonly type: LineageMemoryType }) {
  const meta = LINEAGE_TYPE_META[type];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: meta.dot }} />
      {meta.label}
    </span>
  );
}

/** Refined monochrome/sage toggle switch replacing native browser checkboxes. */
function ToggleSwitch({
  checked,
  onChange,
  label,
  description,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl border border-border bg-muted/35 px-3.5 py-3 text-left transition-colors hover:bg-muted/60"
    >
      <div className="min-w-0 space-y-0.5">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {description && <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-input"
        }`}
      >
        <span
          className={`inline-block size-3.5 rounded-full bg-background shadow-xs transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </span>
    </button>
  );
}

function extractInviteToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (match) return match[1]!;
  if (/^[A-Za-z0-9_-]{8,}$/.test(trimmed)) return trimmed;
  return null;
}

// ── 已接收传承 ─────────────────────────────────────────────────────────────────

export function InheritedMemoryPanel({ agentId }: { readonly agentId: string }) {
  const sub = useAgentSubscription(agentId);
  const [tab, setTab] = useState<"entries" | "contributions">("entries");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>();
  const [selectedContribId, setSelectedContribId] = useState<string>();
  const [inviteInput, setInviteInput] = useState("");

  // Contribute form state
  const [showContribute, setShowContribute] = useState(false);
  const [contribKind, setContribKind] = useState<"add" | "update">("add");
  const [targetMemory, setTargetMemory] = useState<DashboardLineageMemory | null>(null);
  const [cType, setCType] = useState<LineageMemoryType>("procedure");
  const [cTitle, setCTitle] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cBody, setCBody] = useState("");
  const [cRationale, setCRationale] = useState("");

  const memoriesQuery = sub.memories(query, typeFilter);
  const memories = memoriesQuery.data?.memories ?? [];
  const contributions = sub.contributions.data?.contributions ?? [];

  useEffect(() => {
    if (tab === "entries" && memories.length > 0 && !memories.some(m => m.id === selectedMemoryId)) {
      setSelectedMemoryId(memories[0]!.id);
    }
  }, [tab, memories, selectedMemoryId]);

  useEffect(() => {
    if (tab === "contributions" && contributions.length > 0 && !contributions.some(c => c.id === selectedContribId)) {
      setSelectedContribId(contributions[0]!.id);
    }
  }, [tab, contributions, selectedContribId]);

  const data = sub.info.data;

  if (sub.info.isPending) {
    return <div className="p-8 text-xs text-muted-foreground">正在加载已接收的传承记忆…</div>;
  }

  if (!data?.subscription || !data.lineage) {
    const parsedToken = extractInviteToken(inviteInput);
    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6 lg:p-10">
        <div className="mx-auto grid max-w-4xl gap-6 lg:grid-cols-[1.1fr_1fr]">
          {/* Left: Overview & Value Props */}
          <div className="flex flex-col justify-center space-y-5 py-2">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-secondary-foreground">
                <Sparkles className="size-3 text-[#7d9477]" />
                尚未接收传承记忆
              </div>
              <h2 className="text-lg font-semibold tracking-tight">接入团队经验，跳过冷启动</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                接收传承后，当前 Agent 会在对话中按需召回传承记忆，无需重复教导流程规范与排障经验，同时保持个人记忆完全私密。
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                  <ShieldCheck className="size-3.5" />
                </span>
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">物理隔离 · 个人优先</div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    传承记忆以只读方式按需召回，不占核心配额；个人记忆与传承冲突时始终以个人记忆为准。
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                  <GitFork className="size-3.5" />
                </span>
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">支持单条屏蔽与内化覆写</div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    不适合当前工作流的条目可随时屏蔽，或复制一份成为自己的私有记忆自由修改。
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                  <GitPullRequestArrow className="size-3.5" />
                </span>
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">记忆整理自动推荐反哺</div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    沉淀出通用经验后，经你脱敏确认并由传承方审批合入，所有成员同步受益。
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Direct Invite Entry Card */}
          <div className={`${sageCardClass} flex flex-col justify-between space-y-5 p-6`}>
            <div className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">通过邀请链接接收传承</h3>
                <p className="text-xs text-muted-foreground">
                  粘贴传承方分享的完整链接（<code>/invite/...</code>）或邀请口令，预览信息后即可挂载到当前 Agent。
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">邀请链接或口令</label>
                <Input
                  placeholder="例如：http://.../invite/linv_xxxxx 或 linv_xxxxx"
                  value={inviteInput}
                  onChange={e => setInviteInput(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
            </div>
            <div className="border-t border-border pt-4">
              <Button
                type="button"
                className="w-full text-xs"
                disabled={!parsedToken}
                onClick={() => {
                  if (parsedToken) appHistory.push(`/invite/${encodeURIComponent(parsedToken)}`);
                }}
              >
                前往预览并接收传承
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const selectedMemory = memories.find(m => m.id === selectedMemoryId) ?? null;
  const selectedContrib = contributions.find(c => c.id === selectedContribId) ?? null;
  const pendingOwnerCount = contributions.filter(c => c.status === "pending_owner").length;

  const openContributeNew = () => {
    setContribKind("add");
    setTargetMemory(null);
    setCType("procedure");
    setCTitle("");
    setCDesc("");
    setCBody("");
    setCRationale("");
    setShowContribute(true);
  };

  const openContributeUpdate = (mem: DashboardLineageMemory) => {
    setContribKind("update");
    setTargetMemory(mem);
    setCType(mem.type);
    setCTitle(mem.title);
    setCDesc(mem.description);
    setCBody(mem.body);
    setCRationale("");
    setShowContribute(true);
  };

  const handleSubmitContribution = () => {
    sub.submitContribution.mutate(
      {
        kind: contribKind,
        targetLineageMemoryId: targetMemory?.id ?? null,
        proposedType: cType,
        proposedTitle: cTitle,
        proposedDescription: cDesc,
        proposedBody: cBody,
        rationale: cRationale,
      },
      {
        onSuccess: res => {
          setShowContribute(false);
          setTab("contributions");
          setSelectedContribId(res.contribution.id);
        },
      },
    );
  };

  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[23.5rem_1fr]">
      {/* Left List Rail */}
      <aside className="flex min-h-0 flex-col border-b border-border bg-sidebar lg:border-r lg:border-b-0">
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">{data.lineage.name}</span>
                <Badge variant={data.subscription.status === "active" ? "secondary" : "outline"} className="shrink-0 text-[10px]">
                  {data.subscription.status === "active" ? "已订阅" : "待批准"}
                </Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground">来源 Agent：{data.sourceAgentName}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
              disabled={sub.leave.isPending}
              onClick={() => {
                if (window.confirm("确定退出该传承吗？退出后将立即停止召回传承记忆，本地已内化覆写的私有记忆仍会保留。")) {
                  sub.leave.mutate();
                }
              }}
            >
              退出
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted p-[3px] text-xs">
            <button
              type="button"
              onClick={() => { setTab("entries"); setShowContribute(false); }}
              className={`cursor-pointer rounded-md py-1 text-xs font-medium transition-colors ${
                tab === "entries" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              传承条目 ({memoriesQuery.data?.total ?? 0})
            </button>
            <button
              type="button"
              onClick={() => { setTab("contributions"); setShowContribute(false); }}
              className={`cursor-pointer rounded-md py-1 text-xs font-medium transition-colors ${
                tab === "contributions" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              我的反哺{pendingOwnerCount > 0 ? ` (${pendingOwnerCount})` : ""}
            </button>
          </div>

          {tab === "entries" && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder="搜索传承标题、描述或正文…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="h-9 bg-card pl-9 text-xs"
                />
              </div>
              <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
                {([["", "全部"], ...Object.entries(LINEAGE_TYPE_META).map(([k, v]) => [k, v.label])] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setTypeFilter(val)}
                    className={`shrink-0 cursor-pointer rounded-full px-2.5 py-1 text-xs transition-colors ${
                      typeFilter === val
                        ? "bg-primary font-medium text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}

          {data.subscription.status === "active" && (
            <Button size="sm" variant="outline" className="h-8 w-full bg-card text-xs" onClick={openContributeNew}>
              <Send className="mr-1.5 size-3.5" />
              向传承方提交反哺
            </Button>
          )}
        </div>

        {/* Scrollable Entry List matching MemoryWorkspace */}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5">
          {tab === "entries" ? (
            memories.length === 0 ? (
              <li className="px-4 py-12 text-center text-xs text-muted-foreground">暂无可见的传承记忆条目。</li>
            ) : (
              memories.map(mem => {
                const active = !showContribute && selectedMemory?.id === mem.id;
                return (
                  <li key={mem.id}>
                    <button
                      type="button"
                      onClick={() => { setSelectedMemoryId(mem.id); setShowContribute(false); }}
                      className={`block w-full cursor-pointer rounded-xl px-3 py-2.5 text-left transition-colors ${
                        active ? "bg-accent shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-accent/70"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <LineageTypePill type={mem.type} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{mem.title}</span>
                        {mem.override?.mode === "muted" && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">已屏蔽</Badge>}
                        {mem.override?.mode === "overridden" && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">已覆写</Badge>}
                      </span>
                      <span className="mt-1.5 block truncate text-xs text-muted-foreground">{mem.description}</span>
                      <span className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>v{mem.revision} · {fmtDate(mem.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })
            )
          ) : contributions.length === 0 ? (
            <li className="px-4 py-12 text-center text-xs text-muted-foreground">暂无反哺记录。</li>
          ) : (
            contributions.map(c => {
              const active = !showContribute && selectedContrib?.id === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => { setSelectedContribId(c.id); setShowContribute(false); }}
                    className={`block w-full cursor-pointer rounded-xl px-3 py-2.5 text-left transition-colors ${
                      active ? "bg-accent shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-accent/70"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <LineageTypePill type={c.proposedType} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{c.proposedTitle}</span>
                    </span>
                    <span className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{c.kind === "add" ? "新增" : "修改"} · {fmtDate(c.createdAt)}</span>
                      <Badge variant={c.status === "approved" ? "secondary" : "outline"} className="px-1.5 py-0 text-[10px]">
                        {CONTRIBUTION_STATUS_LABELS[c.status] ?? c.status}
                      </Badge>
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </aside>

      {/* Right Detail Pane */}
      <article className="min-h-0 min-w-0 overflow-y-auto bg-background p-6 lg:p-8">
        <div className="mx-auto max-w-3xl space-y-5">
          {(data.lineage.intakeGuidelines || data.ancestors.length > 1) && (
            <div className={`${cardClass} space-y-1.5 px-4 py-3 text-xs text-muted-foreground`}>
              {data.lineage.intakeGuidelines && (
                <p>
                  <strong className="text-foreground">收录范围：</strong>
                  {data.lineage.intakeGuidelines}
                </p>
              )}
              {data.ancestors.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>继承链路：</span>
                  {data.ancestors.map((a, idx) => (
                    <span key={a.lineageId} className="inline-flex items-center gap-1">
                      {idx > 0 && <span>→</span>}
                      <Badge variant="outline" className="text-[11px]">
                        {a.depth === 1 ? `直接传承: ${a.name}` : `上游第 ${a.depth} 层: ${a.name}`}
                      </Badge>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {showContribute ? (
            <div className={`${sageCardClass} space-y-5 p-6`}>
              <div className="flex items-center justify-between border-b border-border pb-4">
                <div>
                  <h3 className="text-sm font-semibold">
                    {contribKind === "add" ? "提交新增反哺提案" : `提议修改传承条目：${targetMemory?.title}`}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">请确保内容已去除个人偏好与私密信息，提交后由传承方审批合入。</p>
                </div>
                <Button size="icon" variant="ghost" className="size-8" onClick={() => setShowContribute(false)}>
                  <X className="size-4" />
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">记忆类型</label>
                  <SelectField
                    aria-label="记忆类型"
                    fullWidth
                    value={cType}
                    onValueChange={v => setCType(v as LineageMemoryType)}
                    options={LINEAGE_TYPE_OPTIONS}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">标题</label>
                  <Input placeholder="不超过 120 字" value={cTitle} onChange={e => setCTitle(e.target.value)} className="h-9 text-xs" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">一句话描述</label>
                <Input placeholder="用于对话中按需召回匹配，不超过 200 字" value={cDesc} onChange={e => setCDesc(e.target.value)} className="h-9 text-xs" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">脱敏正文</label>
                <Textarea placeholder="面向团队的通用经验正文…" rows={8} value={cBody} onChange={e => setCBody(e.target.value)} className="text-xs leading-relaxed" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">推荐或修改理由（可选）</label>
                <Input placeholder="说明这条经验适用的场景或改动原因" value={cRationale} onChange={e => setCRationale(e.target.value)} className="h-9 text-xs" />
              </div>
              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <Button size="sm" variant="outline" onClick={() => setShowContribute(false)}>取消</Button>
                <Button
                  size="sm"
                  disabled={sub.submitContribution.isPending || !cTitle.trim() || !cDesc.trim() || !cBody.trim()}
                  onClick={handleSubmitContribution}
                >
                  提交给传承方审批
                </Button>
              </div>
            </div>
          ) : tab === "entries" ? (
            selectedMemory ? (
              <div className={`${sageCardClass} space-y-5 p-6`}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <LineageTypePill type={selectedMemory.type} />
                      <span className="font-mono text-xs text-muted-foreground">v{selectedMemory.revision}</span>
                      {selectedMemory.override?.mode === "muted" && <Badge variant="outline">已屏蔽</Badge>}
                      {selectedMemory.override?.mode === "overridden" && <Badge variant="outline">已内化覆写</Badge>}
                    </div>
                    <h2 className="text-base font-semibold">{selectedMemory.title}</h2>
                    <p className="text-xs text-muted-foreground">{selectedMemory.description}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => openContributeUpdate(selectedMemory)}>
                      提议修改
                    </Button>
                    {selectedMemory.override ? (
                      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => sub.clearOverride.mutate(selectedMemory.id)}>
                        恢复同步
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs"
                          onClick={() => sub.setOverride.mutate({ lineageMemoryId: selectedMemory.id, mode: "overridden" })}
                        >
                          <GitFork className="mr-1.5 size-3.5" />
                          内化覆写
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-xs text-muted-foreground"
                          onClick={() => sub.setOverride.mutate({ lineageMemoryId: selectedMemory.id, mode: "muted" })}
                        >
                          <EyeOff className="mr-1.5 size-3.5" />
                          屏蔽
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <pre className="whitespace-pre-wrap break-words rounded-xl bg-muted/45 p-4 font-sans text-xs leading-relaxed text-foreground">
                  {selectedMemory.body}
                </pre>
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span>更新于 {fmtDate(selectedMemory.updatedAt)}</span>
                  {selectedMemory.contributorAccountName && <span>贡献者：{selectedMemory.contributorAccountName}</span>}
                  {selectedMemory.approvedByAccountName && <span>审批人：{selectedMemory.approvedByAccountName}</span>}
                </div>
              </div>
            ) : (
              <div className={`${cardClass} p-10 text-center text-xs text-muted-foreground`}>
                从左侧选择一条传承记忆查看详情。
              </div>
            )
          ) : selectedContrib ? (
            <div className={`${sageCardClass} space-y-5 p-6`}>
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-4">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <LineageTypePill type={selectedContrib.proposedType} />
                    <Badge variant="secondary">{selectedContrib.kind === "add" ? "新增提案" : "修改提案"}</Badge>
                    <Badge variant={selectedContrib.status === "approved" ? "default" : "outline"}>
                      {CONTRIBUTION_STATUS_LABELS[selectedContrib.status] ?? selectedContrib.status}
                    </Badge>
                  </div>
                  <h2 className="text-base font-semibold">{selectedContrib.proposedTitle}</h2>
                  <p className="text-xs text-muted-foreground">{selectedContrib.proposedDescription}</p>
                </div>
                <span className="text-xs text-muted-foreground">{fmtDate(selectedContrib.createdAt)}</span>
              </div>
              {selectedContrib.rationale && <p className="text-xs text-muted-foreground">理由：{selectedContrib.rationale}</p>}
              <pre className="whitespace-pre-wrap break-words rounded-xl bg-muted/45 p-4 font-sans text-xs leading-relaxed">
                {selectedContrib.proposedBody}
              </pre>
              {selectedContrib.reviewComment && (
                <p className="rounded-xl bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
                  <strong className="text-foreground">审批备注：</strong>
                  {selectedContrib.reviewComment}
                </p>
              )}
              {selectedContrib.status === "pending_owner" && (
                <div className="flex justify-end gap-2 border-t border-border pt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => sub.decideOwnerContribution.mutate({ contributionId: selectedContrib.id, action: "reject" })}
                  >
                    忽略
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => sub.decideOwnerContribution.mutate({ contributionId: selectedContrib.id, action: "approve" })}
                  >
                    确认脱敏并提交给传承方
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className={`${cardClass} p-10 text-center text-xs text-muted-foreground`}>
              暂无反哺记录，记忆整理会自动筛选可共享经验，你也可以点击左侧「向传承方提交反哺」手动发起。
            </div>
          )}
        </div>
      </article>
    </section>
  );
}

// ── 我的传承 ───────────────────────────────────────────────────────────────────

export function MyLineagePanel({ agentId, agentName }: { readonly agentId: string; readonly agentName: string }) {
  const lin = useAgentLineage(agentId);
  const [subTab, setSubTab] = useState<"memories" | "inbox" | "invites" | "settings">("memories");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [selectedMemId, setSelectedMemId] = useState<string>();
  const [selectedContribId, setSelectedContribId] = useState<string>();
  const [editorMode, setEditorMode] = useState<"new" | "edit" | null>(null);

  const [mType, setMType] = useState<LineageMemoryType>("procedure");
  const [mTitle, setMTitle] = useState("");
  const [mDesc, setMDesc] = useState("");
  const [mBody, setMBody] = useState("");
  const [mReason, setMReason] = useState("");

  // Enable / Settings form
  const existing = lin.overview.data?.lineage ?? null;
  const [name, setName] = useState(existing?.name ?? `${agentName}的传承记忆`);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [intakeGuidelines, setIntakeGuidelines] = useState(existing?.intakeGuidelines ?? "");
  const [allowAncestorLookup, setAllowAncestorLookup] = useState(existing?.allowAncestorLookup ?? true);

  // Invite creation
  const [inviteLabel, setInviteLabel] = useState("");
  const [inviteRequireApproval, setInviteRequireApproval] = useState(false);
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reviewComments, setReviewComments] = useState<Record<string, string>>({});

  const memoriesQuery = lin.memories(query, typeFilter);
  const memories = memoriesQuery.data?.memories ?? [];
  const allContributions = lin.contributions.data?.contributions ?? [];

  useEffect(() => {
    if (subTab === "memories" && !editorMode && memories.length > 0 && !memories.some(m => m.id === selectedMemId)) {
      setSelectedMemId(memories[0]!.id);
    }
  }, [subTab, editorMode, memories, selectedMemId]);

  useEffect(() => {
    if (subTab === "inbox" && allContributions.length > 0 && !allContributions.some(c => c.id === selectedContribId)) {
      setSelectedContribId(allContributions[0]!.id);
    }
  }, [subTab, allContributions, selectedContribId]);

  if (lin.overview.isPending) {
    return <div className="p-8 text-xs text-muted-foreground">正在加载我的传承…</div>;
  }

  // Polished two-column onboarding layout when lineage is not yet enabled.
  if (!existing) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6 lg:p-10">
        <div className="mx-auto grid max-w-4xl gap-8 lg:grid-cols-[0.95fr_1.25fr]">
          {/* Left editorial explanation */}
          <div className="flex flex-col justify-center space-y-5 py-2">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-secondary-foreground">
                <span className="size-1.5 rounded-full bg-[#a3b69e]" />
                独立传承池 · 物理隔离
              </div>
              <h2 className="text-lg font-semibold tracking-tight">为「{agentName}」开启对外传承</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                把沉淀好的流程规范与通用经验放入独立的传承记忆池，邀请同事一键开号复用，并通过审批接收大家的新实践反哺。
              </p>
            </div>

            <div className="space-y-3.5">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                  <ShieldCheck className="size-3.5" />
                </span>
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">私有记忆绝不外泄</div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    传承记忆独立存储，仅主动发布或审批合入的条目对外可见，日常自动整理不会触碰传承池。
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                  <Link2 className="size-3.5" />
                </span>
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">邀请链接一键创建 Agent</div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    生成可控有效期的邀请链接，新成员点击即可创建带传承记忆的专属 Agent。
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                  <GitPullRequestArrow className="size-3.5" />
                </span>
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">双向审批持续进化</div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    成员提交新增或修改提案后，经你审批合入即自动同步给所有订阅成员。
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Right structured onboarding form card */}
          <div className={`${sageCardClass} space-y-5 p-6`}>
            <div className="space-y-1 border-b border-border pb-3.5">
              <h3 className="text-sm font-semibold">基础配置</h3>
              <p className="text-xs text-muted-foreground">开启后可随时在「传承设置」中调整以下内容。</p>
            </div>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">传承名称</label>
                <Input placeholder="例如：研发团队通用传承" value={name} onChange={e => setName(e.target.value)} className="h-9 text-xs" />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">传承简介</label>
                <Textarea
                  placeholder="简要说明这份传承适合谁使用、包含哪些方面的经验（向受邀者展示）"
                  rows={2}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="text-xs leading-relaxed"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">收录范围说明</label>
                <Textarea
                  placeholder="例如：收录组内发布流程、排障经验与常用工具指针；不收录个人偏好和具体人名"
                  rows={3}
                  value={intakeGuidelines}
                  onChange={e => setIntakeGuidelines(e.target.value)}
                  className="text-xs leading-relaxed"
                />
                <p className="text-[11px] text-muted-foreground">
                  用于指导订阅成员的 Agent 在记忆整理时自动筛选可共享经验。
                </p>
              </div>

              <ToggleSwitch
                checked={allowAncestorLookup}
                onChange={setAllowAncestorLookup}
                label="允许 Agent 按需向上查找本传承记忆"
                description="当订阅成员向下继续建立传承时，允许下游 Agent 在需要时按需向上检索本传承条目。"
              />
            </div>

            <div className="flex justify-end border-t border-border pt-4">
              <Button
                size="sm"
                className="h-9 px-5 text-xs"
                disabled={lin.saveConfig.isPending || !name.trim()}
                onClick={() => lin.saveConfig.mutate({ name, description, intakeGuidelines, allowAncestorLookup })}
              >
                开启对外传承
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const pendingContributions = allContributions.filter(c => c.status === "pending_lineage");
  const stats = lin.overview.data?.stats;
  const selectedMem = memories.find(m => m.id === selectedMemId) ?? null;
  const selectedContrib = allContributions.find(c => c.id === selectedContribId) ?? null;

  const openNewMemory = () => {
    setMType("procedure");
    setMTitle("");
    setMDesc("");
    setMBody("");
    setMReason("");
    setEditorMode("new");
  };

  const openEditMemory = (mem: DashboardLineageMemory) => {
    setMType(mem.type);
    setMTitle(mem.title);
    setMDesc(mem.description);
    setMBody(mem.body);
    setMReason("");
    setSelectedMemId(mem.id);
    setEditorMode("edit");
  };

  const handleSaveMemory = () => {
    if (editorMode === "new") {
      lin.createMemory.mutate(
        { type: mType, title: mTitle, description: mDesc, body: mBody, ...(mReason.trim() ? { reason: mReason.trim() } : {}) },
        {
          onSuccess: res => {
            setEditorMode(null);
            setSelectedMemId(res.memory.id);
          },
        },
      );
    } else if (editorMode === "edit" && selectedMem) {
      lin.updateMemory.mutate(
        {
          memoryId: selectedMem.id,
          expectedRevision: selectedMem.revision,
          type: mType,
          title: mTitle,
          description: mDesc,
          body: mBody,
          ...(mReason.trim() ? { reason: mReason.trim() } : {}),
        },
        {
          onSuccess: () => setEditorMode(null),
        },
      );
    }
  };

  const handleCreateInvite = () => {
    lin.createInvite.mutate(
      { label: inviteLabel, requireApproval: inviteRequireApproval },
      {
        onSuccess: res => {
          setLatestInviteUrl(`${window.location.origin}/invite/${res.token}`);
          setInviteLabel("");
        },
      },
    );
  };

  const copyUrl = async (url: string) => {
    await navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[23.5rem_1fr]">
      {/* Left Rail */}
      <aside className="flex min-h-0 flex-col border-b border-border bg-sidebar lg:border-r lg:border-b-0">
        <div className="space-y-3 border-b border-border p-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold">{existing.name}</span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">独立传承池</Badge>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span>条目 <strong className="font-mono text-foreground">{stats?.activeMemories ?? 0}</strong></span>
              <span>成员 <strong className="font-mono text-foreground">{stats?.activeMembers ?? 0}</strong></span>
              <span>待审 <strong className="font-mono text-foreground">{stats?.pendingContributions ?? 0}</strong></span>
            </div>
          </div>

          {/* 4-Way Segmented Bar */}
          <div className="grid grid-cols-4 gap-0.5 rounded-lg border border-border bg-muted p-[3px] text-xs">
            <button
              type="button"
              onClick={() => { setSubTab("memories"); setEditorMode(null); }}
              className={`cursor-pointer rounded-md py-1 text-xs font-medium transition-colors ${
                subTab === "memories" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              传承库
            </button>
            <button
              type="button"
              onClick={() => { setSubTab("inbox"); setEditorMode(null); }}
              className={`cursor-pointer rounded-md py-1 text-xs font-medium transition-colors ${
                subTab === "inbox" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              审批{pendingContributions.length > 0 ? `(${pendingContributions.length})` : ""}
            </button>
            <button
              type="button"
              onClick={() => { setSubTab("invites"); setEditorMode(null); }}
              className={`cursor-pointer rounded-md py-1 text-xs font-medium transition-colors ${
                subTab === "invites" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              邀请
            </button>
            <button
              type="button"
              onClick={() => {
                setName(existing.name);
                setDescription(existing.description);
                setIntakeGuidelines(existing.intakeGuidelines);
                setAllowAncestorLookup(existing.allowAncestorLookup);
                setSubTab("settings");
                setEditorMode(null);
              }}
              className={`cursor-pointer rounded-md py-1 text-xs font-medium transition-colors ${
                subTab === "settings" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              设置
            </button>
          </div>

          {subTab === "memories" && (
            <>
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="搜索传承记忆…"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    className="h-9 bg-card pl-9 text-xs"
                  />
                </div>
                <Button size="sm" className="h-9 shrink-0 px-2.5 text-xs" onClick={openNewMemory}>
                  <Plus className="size-3.5" />
                  发布
                </Button>
              </div>
              <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
                {([["", "全部"], ...Object.entries(LINEAGE_TYPE_META).map(([k, v]) => [k, v.label])] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setTypeFilter(val)}
                    className={`shrink-0 cursor-pointer rounded-full px-2.5 py-1 text-xs transition-colors ${
                      typeFilter === val
                        ? "bg-primary font-medium text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Left List Body */}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5">
          {subTab === "memories" ? (
            memories.length === 0 ? (
              <li className="px-4 py-12 text-center text-xs text-muted-foreground">传承池还是空的，点击上方「发布」添加第一条传承记忆。</li>
            ) : (
              memories.map(mem => {
                const active = !editorMode && selectedMem?.id === mem.id;
                return (
                  <li key={mem.id}>
                    <button
                      type="button"
                      onClick={() => { setSelectedMemId(mem.id); setEditorMode(null); }}
                      className={`block w-full cursor-pointer rounded-xl px-3 py-2.5 text-left transition-colors ${
                        active ? "bg-accent shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-accent/70"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <LineageTypePill type={mem.type} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{mem.title}</span>
                      </span>
                      <span className="mt-1.5 block truncate text-xs text-muted-foreground">{mem.description}</span>
                      <span className="mt-1.5 block text-[11px] text-muted-foreground">v{mem.revision} · {fmtDate(mem.updatedAt)}</span>
                    </button>
                  </li>
                );
              })
            )
          ) : subTab === "inbox" ? (
            allContributions.length === 0 ? (
              <li className="px-4 py-12 text-center text-xs text-muted-foreground">暂无反哺提案。</li>
            ) : (
              allContributions.map(c => {
                const active = selectedContrib?.id === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedContribId(c.id)}
                      className={`block w-full cursor-pointer rounded-xl px-3 py-2.5 text-left transition-colors ${
                        active ? "bg-accent shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-accent/70"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <LineageTypePill type={c.proposedType} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{c.proposedTitle}</span>
                      </span>
                      <span className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>{c.sourceOwnerName ?? "成员"} · {fmtDate(c.createdAt)}</span>
                        <Badge variant={c.status === "pending_lineage" ? "default" : "outline"} className="px-1.5 py-0 text-[10px]">
                          {CONTRIBUTION_STATUS_LABELS[c.status] ?? c.status}
                        </Badge>
                      </span>
                    </button>
                  </li>
                );
              })
            )
          ) : subTab === "invites" ? (
            <li className="space-y-2 p-2 text-xs text-muted-foreground">
              <p>在右侧生成邀请链接，管理已订阅传承的成员 Agent。</p>
              <div className="rounded-xl border border-border bg-card p-3.5">
                <div className="flex items-center justify-between">
                  <span>活跃成员</span>
                  <strong className="font-mono text-foreground">{stats?.activeMembers ?? 0}</strong>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span>待审批加入</span>
                  <strong className="font-mono text-foreground">{stats?.pendingMembers ?? 0}</strong>
                </div>
              </div>
            </li>
          ) : (
            <li className="space-y-2.5 p-2 text-xs text-muted-foreground">
              <p>在右侧调整传承名称、简介、收录范围与向上查找记忆开关。</p>
              {existing.allowAncestorLookup && (
                <Badge variant="outline" className="text-[11px]">允许向上查找记忆</Badge>
              )}
            </li>
          )}
        </ul>
      </aside>

      {/* Right Detail / Editor / Management Pane */}
      <article className="min-h-0 min-w-0 overflow-y-auto bg-background p-6 lg:p-8">
        <div className="mx-auto max-w-3xl space-y-5">
          {subTab === "memories" && (
            editorMode ? (
              <div className={`${sageCardClass} space-y-5 p-6`}>
                <div className="flex items-center justify-between border-b border-border pb-4">
                  <h3 className="text-sm font-semibold">{editorMode === "new" ? "发布传承记忆" : "编辑传承记忆"}</h3>
                  <Button size="icon" variant="ghost" className="size-8" onClick={() => setEditorMode(null)}>
                    <X className="size-4" />
                  </Button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">记忆类型</label>
                    <SelectField
                      aria-label="记忆类型"
                      fullWidth
                      value={mType}
                      onValueChange={v => setMType(v as LineageMemoryType)}
                      options={LINEAGE_TYPE_OPTIONS}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">标题</label>
                    <Input placeholder="不超过 120 字" value={mTitle} onChange={e => setMTitle(e.target.value)} className="h-9 text-xs" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">一句话描述</label>
                  <Input placeholder="用于按需召回匹配，不超过 200 字" value={mDesc} onChange={e => setMDesc(e.target.value)} className="h-9 text-xs" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">正文</label>
                  <Textarea placeholder="面向团队的通用脱敏内容…" rows={8} value={mBody} onChange={e => setMBody(e.target.value)} className="text-xs leading-relaxed" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">变更说明（可选）</label>
                  <Input placeholder="记录在版本历史中" value={mReason} onChange={e => setMReason(e.target.value)} className="h-9 text-xs" />
                </div>
                <div className="flex justify-end gap-2 border-t border-border pt-4">
                  <Button size="sm" variant="outline" onClick={() => setEditorMode(null)}>取消</Button>
                  <Button
                    size="sm"
                    disabled={lin.createMemory.isPending || lin.updateMemory.isPending || !mTitle.trim() || !mDesc.trim() || !mBody.trim()}
                    onClick={handleSaveMemory}
                  >
                    {editorMode === "new" ? "发布" : "保存更新"}
                  </Button>
                </div>
              </div>
            ) : selectedMem ? (
              <div className={`${sageCardClass} space-y-5 p-6`}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <LineageTypePill type={selectedMem.type} />
                      <span className="font-mono text-xs text-muted-foreground">v{selectedMem.revision}</span>
                    </div>
                    <h2 className="text-base font-semibold">{selectedMem.title}</h2>
                    <p className="text-xs text-muted-foreground">{selectedMem.description}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => openEditMemory(selectedMem)}>
                      <Pencil className="mr-1.5 size-3.5" />
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        if (window.confirm(`确定删除传承记忆「${selectedMem.title}」吗？`)) {
                          lin.deleteMemory.mutate({ memoryId: selectedMem.id, expectedRevision: selectedMem.revision });
                        }
                      }}
                    >
                      <Trash2 className="mr-1 size-3.5" />
                      删除
                    </Button>
                  </div>
                </div>
                <pre className="whitespace-pre-wrap break-words rounded-xl bg-muted/45 p-4 font-sans text-xs leading-relaxed">
                  {selectedMem.body}
                </pre>
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span>更新于 {fmtDate(selectedMem.updatedAt)}</span>
                  {selectedMem.contributorAccountName && <span>贡献者：{selectedMem.contributorAccountName}</span>}
                  {selectedMem.approvedByAccountName && <span>审批人：{selectedMem.approvedByAccountName}</span>}
                </div>
              </div>
            ) : (
              <div className={`${cardClass} p-10 text-center text-xs text-muted-foreground`}>
                从左侧选择一条传承记忆查看详情，或点击「发布」创建新条目。
              </div>
            )
          )}

          {subTab === "inbox" && (
            selectedContrib ? (
              <div className={`${sageCardClass} space-y-5 p-6`}>
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <LineageTypePill type={selectedContrib.proposedType} />
                      <Badge variant="secondary">{selectedContrib.kind === "add" ? "新增提案" : "修改提案"}</Badge>
                      <Badge variant={selectedContrib.status === "pending_lineage" ? "default" : "outline"}>
                        {CONTRIBUTION_STATUS_LABELS[selectedContrib.status] ?? selectedContrib.status}
                      </Badge>
                    </div>
                    <h2 className="text-base font-semibold">{selectedContrib.proposedTitle}</h2>
                    <p className="text-xs text-muted-foreground">{selectedContrib.proposedDescription}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    来自 {selectedContrib.sourceOwnerName ?? "成员"}（{selectedContrib.sourceAgentName ?? selectedContrib.sourceAgentId}） · {fmtDate(selectedContrib.createdAt)}
                  </span>
                </div>
                {selectedContrib.rationale && <p className="text-xs text-muted-foreground">理由：{selectedContrib.rationale}</p>}
                {selectedContrib.kind === "update" && selectedContrib.targetMemory ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-muted-foreground">当前版本 (v{selectedContrib.targetMemory.revision})</div>
                      <pre className="whitespace-pre-wrap break-words rounded-xl bg-muted/45 p-3.5 font-sans text-xs">{selectedContrib.targetMemory.body}</pre>
                    </div>
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">建议更新</div>
                      <pre className="whitespace-pre-wrap break-words rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3.5 font-sans text-xs">{selectedContrib.proposedBody}</pre>
                    </div>
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-xl bg-muted/45 p-4 font-sans text-xs leading-relaxed">
                    {selectedContrib.proposedBody}
                  </pre>
                )}
                {selectedContrib.status === "pending_lineage" && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <Input
                      placeholder="审批备注或退回理由（可选）"
                      className="h-9 flex-1 text-xs"
                      value={reviewComments[selectedContrib.id] ?? ""}
                      onChange={e => setReviewComments(prev => ({ ...prev, [selectedContrib.id]: e.target.value }))}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 text-xs text-destructive"
                      disabled={lin.decideContribution.isPending}
                      onClick={() =>
                        lin.decideContribution.mutate({
                          contributionId: selectedContrib.id,
                          action: "reject",
                          reviewComment: reviewComments[selectedContrib.id],
                        })
                      }
                    >
                      退回
                    </Button>
                    <Button
                      size="sm"
                      className="h-9 text-xs"
                      disabled={lin.decideContribution.isPending}
                      onClick={() =>
                        lin.decideContribution.mutate({
                          contributionId: selectedContrib.id,
                          action: "approve",
                          reviewComment: reviewComments[selectedContrib.id],
                        })
                      }
                    >
                      <ShieldCheck className="mr-1.5 size-3.5" />
                      批准并写入传承
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className={`${cardClass} p-10 text-center text-xs text-muted-foreground`}>
                暂无反哺提案。订阅成员在记忆整理或手动提交经验后，会出现在这里等待审批。
              </div>
            )
          )}

          {subTab === "invites" && (
            <div className="space-y-5">
              <div className={`${sageCardClass} space-y-4 p-6`}>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">生成传承邀请链接</h3>
                  <p className="text-xs text-muted-foreground">受邀成员点击链接后可一键创建新 Agent 或挂载到已有 Agent。</p>
                </div>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      placeholder="邀请备注（例如：研发组新人入职）"
                      value={inviteLabel}
                      onChange={e => setInviteLabel(e.target.value)}
                      className="h-9 flex-1 text-xs"
                    />
                    <Button size="sm" className="h-9 px-4 text-xs" disabled={lin.createInvite.isPending} onClick={handleCreateInvite}>
                      <Link2 className="mr-1.5 size-3.5" />
                      生成链接
                    </Button>
                  </div>
                  <ToggleSwitch
                    checked={inviteRequireApproval}
                    onChange={setInviteRequireApproval}
                    label="需要审批后加入"
                    description="开启后，成员通过该链接提交申请需经你批准后才开始同步传承记忆。"
                  />
                </div>
                {latestInviteUrl && (
                  <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs">
                    <code className="flex-1 truncate">{latestInviteUrl}</code>
                    <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => void copyUrl(latestInviteUrl)}>
                      {copied ? <Check className="mr-1 size-3" /> : <Copy className="mr-1 size-3" />}
                      {copied ? "已复制" : "复制"}
                    </Button>
                  </div>
                )}
                {(lin.invites.data?.invites ?? []).length > 0 && (
                  <div className="space-y-1.5 border-t border-border pt-3">
                    {(lin.invites.data?.invites ?? []).map(inv => (
                      <div key={inv.id} className="flex items-center justify-between rounded-xl border border-border px-3.5 py-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{inv.label || "未命名邀请"}</span>
                          <Badge variant={inv.status === "active" ? "secondary" : "outline"} className="text-[10px]">
                            {inv.status === "active" ? "有效" : "已吊销"}
                          </Badge>
                          <span className="text-muted-foreground">已使用 {inv.usedCount}{inv.maxUses ? ` / ${inv.maxUses}` : ""} 次</span>
                        </div>
                        {inv.status === "active" && (
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => lin.revokeInvite.mutate(inv.id)}>
                            吊销
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className={`${cardClass} space-y-3 p-6`}>
                <div className="flex items-center gap-2">
                  <Users className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">已接收传承的成员 Agent</h3>
                </div>
                {(lin.members.data?.members ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无成员订阅。</p>
                ) : (
                  (lin.members.data?.members ?? []).map(m => (
                    <div key={m.subscriptionId} className="flex items-center justify-between rounded-xl border border-border px-3.5 py-2.5 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{m.agentName}</span>
                        <span className="text-muted-foreground">所有者：{m.ownerDisplayName}</span>
                        <Badge variant={m.status === "active" ? "secondary" : "outline"} className="text-[10px]">
                          {m.status === "active" ? "活跃" : "待审批"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {m.status === "pending_approval" && (
                          <Button size="sm" className="h-7 text-xs" onClick={() => lin.approveMember.mutate(m.subscriptionId)}>
                            批准加入
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => lin.removeMember.mutate(m.subscriptionId)}>
                          移除
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {subTab === "settings" && (
            <div className={`${sageCardClass} space-y-5 p-6`}>
              <div className="space-y-1 border-b border-border pb-4">
                <h3 className="text-sm font-semibold">传承基础设置</h3>
                <p className="text-xs text-muted-foreground">修改后即时生效，不影响现有成员的订阅状态。</p>
              </div>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">传承名称</label>
                  <Input placeholder="传承名称" value={name} onChange={e => setName(e.target.value)} className="h-9 text-xs" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">传承简介</label>
                  <Textarea placeholder="向受邀者展示的简介" rows={2} value={description} onChange={e => setDescription(e.target.value)} className="text-xs leading-relaxed" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">收录范围说明</label>
                  <Textarea placeholder="用于指导记忆整理自动筛选可共享经验" rows={3} value={intakeGuidelines} onChange={e => setIntakeGuidelines(e.target.value)} className="text-xs leading-relaxed" />
                </div>
                <ToggleSwitch
                  checked={allowAncestorLookup}
                  onChange={setAllowAncestorLookup}
                  label="允许 Agent 按需向上查找本传承记忆"
                  description="当订阅成员向下继续建立传承时，允许下游 Agent 在需要时按需向上检索本传承条目。"
                />
              </div>
              <div className="flex justify-end border-t border-border pt-4">
                <Button
                  size="sm"
                  className="h-9 px-5 text-xs"
                  disabled={lin.saveConfig.isPending || !name.trim()}
                  onClick={() => lin.saveConfig.mutate({ name, description, intakeGuidelines, allowAncestorLookup })}
                >
                  保存设置
                </Button>
              </div>
            </div>
          )}
        </div>
      </article>
    </section>
  );
}
