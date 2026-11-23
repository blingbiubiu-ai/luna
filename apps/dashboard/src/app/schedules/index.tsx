import { useAgentBasePath } from "@/lib/agent-route";
import { DeleteRecordButton } from "@/components/delete-record-button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu";
import { SelectField } from "@/components/ui/select-field";
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus, Search, Pause, Play, Pencil, RefreshCw, ArrowLeft, ChevronDown } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { useDashboardAuthSession, useSessions, useTasks } from "@/lib/api";
import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { useRouteAgent } from "@/lib/agent-route";
import { useTranslation } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/$agentId/schedules/")({ component: SchedulesPage });
type ScheduleFailureInfo = {
  occurrenceId: string;
  failedAt: number;
  reason: string;
  notifiedAt: number | null;
};
type Schedule = {
  id: string; title: string; paused: boolean; enabled: boolean; revision: number;
  actorUserId: string; sourceSessionId: string; targetSessionId: string;
  action: { kind: "message.send" | "session.invoke" | "task.run"; content: string; taskId?: string; contextRefs?: string[] };
  recurrence?: { kind: "daily" | "weekdays" | "weekly" | "custom"; time: string; days: number[]; frequency?: "hourly" | "daily" | "weekly" | "monthly" | "yearly"; every?: number; startDate?: string; monthDays?: number[]; dayOfMonth?: number; month?: number } | null;
  nextAt: number; intervalMs: number | null; timezone: string; createdAt: number;
  lastFailure?: ScheduleFailureInfo | null;
};
type Occurrence = { id: string; scheduleId: string; scheduledAt: number; status: string; reason: string | null; revision: number; snapshot: unknown };
const titleOf = (s: Schedule) => s.title || s.action.content.slice(0, 80);
const stateOf = (s: Schedule) => s.enabled ? "Active" : s.paused ? "Paused" : "Finished";
function localDateTime(value: number) {
  const d = new Date(value);
  return new Date(value - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
type ScheduleScope = { agentId: string; shadowId?: string };
function schedulePath(path: string, scope: ScheduleScope) {
  const query = new URLSearchParams({ agentId: scope.agentId });
  if (scope.shadowId) query.set("shadowId", scope.shadowId);
  return `/session-commands/${path}?${query}`;
}

function SchedulesPage() {
  const { t } = useTranslation();
  const auth = useDashboardAuthSession();
  const account = auth.data?.account?.id ?? "";
  const { ownerAccountId, ownerUserId } = useRouteAgent();
  const canManage = account === ownerAccountId;
  // Schedules created in the Dashboard run as the owner's user in this Agent.
  const actor = ownerUserId;
  const selection = useShadowScope(false, canManage);
  const scope = selection.scope;
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
      <h1 className="text-xl font-semibold">{t("Schedules")}</h1>
      {canManage && <ShadowPicker selection={selection} />}
    </header>
    {auth.error || selection.error ? <p role="alert" className="px-5 py-3 text-destructive">无法加载 Agent 或分身。</p>
      : auth.isLoading || selection.loading ? <p className="px-5 py-3">{t("Loading")}</p>
      : canManage ? <ScopedSchedules key={JSON.stringify(scope)} scope={scope} actor={actor} />
      : <p className="px-5 py-3 text-sm text-muted-foreground">只有 Agent 所有者可以管理定时任务。</p>}
  </div>;
}

function ScopedSchedules({ scope, actor }: { scope: ScheduleScope; actor: string }) {
  const base = useAgentBasePath();
  const { t, locale } = useTranslation();
  const cache = useQueryClient();
  const queryKey = ["luna", "schedules", scope.agentId, scope.shadowId ?? null] as const;
  const schedules = useQuery({
    queryKey: [...queryKey, "list"],
    queryFn: ({ signal }) => apiFetch<Schedule[]>(schedulePath("schedules", scope), { signal }),
    refetchInterval: 10000,
  });
  const occurrences = useQuery({
    queryKey: [...queryKey, "occurrences"],
    queryFn: ({ signal }) => apiFetch<Occurrence[]>(schedulePath("occurrences", scope), { signal }),
    refetchInterval: 10000,
  });
  const sessions = useSessions(scope);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Schedule | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ Active: false, Paused: true, Finished: true });
  const [notice, setNotice] = useState("");
  const all = schedules.data ?? [];
  const selected = all.find(s => s.id === selectedId);
  const history = [...(occurrences.data ?? [])].filter(o => o.scheduleId === selectedId).sort((a, b) => b.scheduledAt - a.scheduledAt);
  const refresh = () => cache.invalidateQueries({ queryKey });
  const stateMutation = useMutation({
    mutationFn: (s: Schedule) => apiFetch<Schedule>(schedulePath(`schedules/${encodeURIComponent(s.id)}/state`, scope), { method: "POST", body: JSON.stringify({ enabled: !s.enabled, revision: s.revision }) }),
    onSuccess: async s => { setNotice(t(s.enabled ? "Schedule resumed" : "Schedule paused")); await refresh(); },
    onError: () => { void refresh(); },
  });
  const sessionName = (id: string) => sessions.data?.find(s => s.id === id)?.displayTitle || id;
  const format = (value: number, timezone: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(value);
  const relativeTime = (s: Schedule) => {
    if (!s.enabled) return t(stateOf(s));
    const dateKey = (v: number) => new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(v);
    const day = dateKey(s.nextAt) === dateKey(Date.now()) ? "Today" : dateKey(s.nextAt) === dateKey(Date.now() + 86400000) ? "Tomorrow" : null;
    return day ? `${t(day)} ${new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: s.timezone }).format(s.nextAt)}` : format(s.nextAt, s.timezone);
  };
  const matching = all.filter(s => (filter === "all" || stateOf(s) === filter) && `${titleOf(s)} ${s.action.content} ${s.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  function select(id: string) { if (editor && !window.confirm(t("Discard unsaved changes?"))) return; setSelectedId(id); setEditor(null); setNotice(""); stateMutation.reset(); }
  function newTask() { if (editor && !window.confirm(t("Discard unsaved changes?"))) return; setEditor("new"); setSelectedId(null); setNotice(""); stateMutation.reset(); }
  return <main className="flex min-h-0 flex-1 flex-col text-sm md:flex-row">
    <aside className={`min-h-0 w-full shrink-0 flex-col border-r bg-muted/15 md:flex md:w-80 lg:w-96 ${selected || editor ? "hidden" : "flex"}`}>
      <header className="flex items-center justify-between px-5 pt-6 pb-4"><h2 className="text-base font-semibold">{t("All schedules")}</h2><Button variant="ghost" size="icon" aria-label={t("Refresh")} disabled={schedules.isFetching} onClick={() => void refresh()}><RefreshCw className="size-4" /></Button></header>
      <div className="space-y-3 px-4 pb-4"><Button variant="ghost" className="w-full justify-start text-sm" onClick={newTask}><Plus className="size-4" />{t("New task")}</Button>
        <div className="relative"><Search className="absolute top-3 left-3 size-4 text-muted-foreground" /><Input type="search" aria-label={t("Search schedules")} placeholder={t("Search schedules")} value={query} onChange={e => setQuery(e.target.value)} className="pl-9" /></div>
        <SelectField aria-label={t("Schedule status")} fullWidth value={filter} onValueChange={setFilter} options={[{ value: "all", label: t("All schedules") }, ...["Active", "Paused", "Finished"].map(s => ({ value: s, label: t(s) }))]} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {schedules.isError ? <p role="alert" className="p-3 text-sm text-destructive">{schedules.error.message}</p> : schedules.isLoading ? <p className="p-3">{t("Loading")}</p> : matching.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{t(all.length ? "No matching schedules" : "No schedules yet")}</p> : ["Active", "Paused", "Finished"].map(group => {
          const rows = matching.filter(s => stateOf(s) === group).sort((a, b) => group === "Active" ? a.nextAt - b.nextAt : b.createdAt - a.createdAt);
          return rows.length > 0 && <section key={group} className="mb-5"><h2><button type="button" aria-expanded={!collapsed[group]} aria-controls={`schedule-group-${group}`} onClick={() => setCollapsed(previous => ({ ...previous, [group]: !previous[group] }))} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><ChevronDown className={`size-3.5 transition-transform ${collapsed[group] ? "-rotate-90" : ""}`} />{t(group)} <span className="ml-auto">{rows.length}</span></button></h2><div id={`schedule-group-${group}`} hidden={collapsed[group] ?? false}>{rows.map(s => <button key={s.id} aria-current={s.id === selectedId ? "true" : undefined} onClick={() => select(s.id)} className={`mb-1 w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${s.id === selectedId ? "bg-muted" : ""}`}><span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{titleOf(s)}</span>{s.lastFailure && <Badge variant="destructive" className="shrink-0 text-[10px]">失败</Badge>}</span><span className="mt-1 block text-xs text-muted-foreground">{relativeTime(s)}</span></button>)}</div></section>;
        })}
      </div>
    </aside>
    <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto ${selected || editor ? "block" : "hidden md:block"}`}>
      <div className="mx-auto max-w-3xl p-5 md:p-8">
        {(selected || editor) && <Button variant="ghost" className="mb-4 md:hidden" onClick={() => { if (!editor || window.confirm(t("Discard unsaved changes?"))) { setSelectedId(null); setEditor(null); } }}><ArrowLeft />{t("Back")}</Button>}
        {notice && <p role="status" className="mb-4 text-sm text-emerald-700">{notice}</p>}
        {editor ? <ScheduleEditor scope={scope} key={editor === "new" ? "new" : editor.id} schedule={editor === "new" ? undefined : editor} onCancel={() => { if (window.confirm(t("Discard unsaved changes?"))) setEditor(null); }} onSaved={async s => { await refresh(); setSelectedId(s.id); setEditor(null); setNotice(t("Schedule saved")); }} /> : selected ? <>
          <header className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><Badge variant="secondary">{t(stateOf(selected))}</Badge><h2 className="mt-3 break-words text-xl font-semibold">{titleOf(selected)}</h2><p className="mt-2 text-sm text-muted-foreground">{relativeTime(selected)} · {selected.timezone}</p></div>
            <div className="flex gap-2"><Button variant="outline" disabled={stateMutation.isPending || selected.actorUserId !== actor} onClick={() => { setEditor(selected); setNotice(""); }}><Pencil className="size-4" />{t("Edit")}</Button><Button variant="outline" disabled={stateMutation.isPending || (!selected.enabled && (!selected.paused || selected.actorUserId !== actor))} onClick={() => stateMutation.mutate(selected)}>{selected.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}{t(selected.enabled ? "Pause" : "Resume")}</Button><DeleteRecordButton key={selected.id} kind="schedules" variant="outline" size="default" id={selected.id} path={schedulePath(`schedules/${encodeURIComponent(selected.id)}`, scope)} name={titleOf(selected)} onDeleted={() => { setSelectedId(null); setNotice("定时任务已删除"); }} /></div>
          </header>
          {stateMutation.isError && <p role="alert" className="mt-4 text-sm text-destructive">{stateMutation.error.message}</p>}
          {selected.lastFailure && (
            <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-testid="schedule-last-failure-banner">
              <p className="font-medium">最近执行失败（{format(selected.lastFailure.failedAt, selected.timezone)}）</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs">{selected.lastFailure.reason}</p>
            </div>
          )}
          {!selected.enabled && !selected.paused && <p className="mt-4 text-sm text-muted-foreground">{t("This one-time task has ended. Edit its time to schedule it again.")}</p>}
          <section className="my-7 space-y-5 rounded-xl border p-5"><div><h3 className="text-sm text-muted-foreground">{selected.action.kind === "message.send" ? t("Scheduled message") : selected.action.kind === "task.run" ? "直连后台任务执行（task.run）" : t("Scheduled execution")}</h3>{selected.action.kind === "task.run" && selected.action.taskId && <p className="mt-1 text-xs text-muted-foreground">关联 Task：<a href={`${base}/tasks/${encodeURIComponent(selected.action.taskId)}`} className="text-primary hover:underline">{selected.action.taskId}</a></p>}<p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{selected.action.content}</p></div><div className="grid gap-5 sm:grid-cols-2"><div><h3 className="text-sm text-muted-foreground">{t("Timing")}</h3><p className="mt-1">{selected.recurrence ? recurrenceLabel(selected.recurrence, t) : selected.intervalMs ? `${t("Every")} ${selected.intervalMs / 60000} ${t("minutes")}` : t("One-time")}</p></div><div><h3 className="text-sm text-muted-foreground">{t("Target session")}</h3><a href={`${base}/sessions/${encodeURIComponent(selected.targetSessionId)}`} className="mt-1 block break-words text-primary hover:underline">{sessionName(selected.targetSessionId)}</a></div></div></section>
          <details className="mb-7 text-sm text-muted-foreground"><summary className="cursor-pointer">{t("Advanced information")}</summary><dl className="mt-3 space-y-2 break-all"><div>ID: {selected.id}</div><div>{t("Revision")}: {selected.revision}</div><div>{t("Source session")}: {selected.sourceSessionId}</div><div>{t("Execution identity")}: {selected.actorUserId}</div></dl></details>
          <section><h3 className="mb-4 text-sm font-semibold">{t("Execution history")}</h3>{occurrences.isError ? <p role="alert" className="text-sm text-destructive">{occurrences.error.message}</p> : occurrences.isLoading ? <p>{t("Loading")}</p> : history.length === 0 ? <p className="text-sm text-muted-foreground">{t("No executions yet")}</p> : <ol className="space-y-3">{history.map(o => <li key={o.id} className="rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-2"><time>{format(o.scheduledAt, selected.timezone)}</time><Badge variant={["failed", "unknown"].includes(o.status) ? "destructive" : "secondary"}>{t(o.status === "unknown" ? "Outcome uncertain" : o.status)}</Badge></div>{o.reason && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{o.reason}</p>}<details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("Execution snapshot")} · {t("Revision")} {o.revision}</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(o.snapshot, null, 2)}</pre></details></li>)}</ol>}</section>
        </> : <div className="flex min-h-80 flex-col items-center justify-center text-center"><CalendarClock className="mb-4 size-10 text-muted-foreground" /><h2 className="text-lg font-medium">{t("Select a task or create a new one")}</h2><p className="mt-2 text-sm text-muted-foreground">{t("Schedule a reminder or let Luna work on a recurring task.")}</p><Button className="mt-6" onClick={newTask}><Plus />{t("New task")}</Button></div>}
      </div>
    </div>
  </main>;
}
function ScheduleEditor({ scope, schedule, onCancel, onSaved }: { scope: ScheduleScope; schedule: Schedule | undefined; onCancel: () => void; onSaved: (s: Schedule) => Promise<void> }) {
  const { t } = useTranslation();
  const sessions = useSessions(scope);
  const tasks = useTasks(scope);
  const [title, setTitle] = useState(schedule ? titleOf(schedule) : "");
  const [content, setContent] = useState(schedule?.action.content ?? "");
  const [kind, setKind] = useState<Schedule["action"]["kind"]>(schedule?.action.kind ?? "message.send");
  const [taskId, setTaskId] = useState(schedule?.action.taskId ?? "");
  const [target, setTarget] = useState(schedule?.targetSessionId ?? "");
  const [date, setDate] = useState(schedule ? localDateTime(schedule.nextAt > Date.now() ? schedule.nextAt : Date.now() + 3600000) : "");
  const [repeat, setRepeat] = useState<string>(schedule?.recurrence?.kind ?? (schedule?.intervalMs ? "interval" : "once"));
  const [time, setTime] = useState(schedule?.recurrence?.time ?? "09:00");
  const [days, setDays] = useState<number[]>(schedule?.recurrence?.days.length ? schedule.recurrence.days : [1]);
  const [frequency, setFrequency] = useState(schedule?.recurrence?.frequency ?? "weekly");
  const [every, setEvery] = useState(String(schedule?.recurrence?.every ?? 1));
  const [startDate, setStartDate] = useState(schedule?.recurrence?.startDate ?? localDateTime(Date.now()).slice(0, 10));
  const [monthDays, setMonthDays] = useState<number[]>(schedule?.recurrence?.monthDays ?? [schedule?.recurrence?.dayOfMonth ?? 1]);
  const [month, setMonth] = useState(String(schedule?.recurrence?.month ?? 1));
  const isCalendar = !["once", "interval"].includes(repeat);
  const initialInterval = schedule?.intervalMs ?? 3600000;
  const [intervalUnit, setIntervalUnit] = useState(initialInterval % 3600000 === 0 ? "hours" : "minutes");
  const [intervalValue, setIntervalValue] = useState(String(initialInterval / (initialInterval % 3600000 === 0 ? 3600000 : 60000)));
  const intervalMs = Number(intervalValue) * (intervalUnit === "hours" ? 3600000 : 60000);
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [calendarTimezone, setCalendarTimezone] = useState(schedule?.timezone ?? localTimezone);
  const timezone = isCalendar ? calendarTimezone : localTimezone;
  const [validation, setValidation] = useState("");
  const intervalNextAt = () => {
    const now = Date.now();
    if (!schedule || schedule.intervalMs !== intervalMs) return now + intervalMs;
    return schedule.nextAt > now ? schedule.nextAt : schedule.nextAt + (Math.floor((now - schedule.nextAt) / intervalMs) + 1) * intervalMs;
  };
  const save = useMutation({ mutationFn: () => apiFetch<Schedule>(schedulePath(schedule ? `schedule-editor/${encodeURIComponent(schedule.id)}` : "schedule-editor", scope), { method: schedule ? "PUT" : "POST", body: JSON.stringify({ title, targetSessionId: target, action: kind === "task.run" ? { kind: "task.run", taskId: taskId.trim(), content, contextRefs: schedule?.action.contextRefs ?? [] } : { kind, content, contextRefs: schedule?.action.contextRefs ?? [] }, nextAt: isCalendar ? Date.now() + 60000 : repeat === "interval" ? intervalNextAt() : new Date(date).getTime(), timezone, intervalMs: repeat === "interval" ? intervalMs : null, recurrence: isCalendar ? { kind: repeat, time, days, ...(repeat === "custom" ? { frequency, every: Number(every), startDate, ...(["monthly", "yearly"].includes(frequency) ? { monthDays } : {}), ...(frequency === "yearly" ? { month: Number(month) } : {}) } : {}) } : null, ...(schedule ? { revision: schedule.revision } : {}) }) }), onSuccess: onSaved });
  return <form onSubmit={e => { e.preventDefault(); if (!target) { setValidation(t("Select a session")); return; } if (kind === "task.run" && !taskId.trim()) { setValidation("请选择或输入关联的后台任务（Task ID）"); return; } if (repeat === "once" && (!date || new Date(date).getTime() <= Date.now())) { setValidation(t("Choose a future time")); return; } if ((repeat === "weekly" || (repeat === "custom" && frequency === "weekly")) && !days.length) { setValidation(t("Select at least one day")); return; } if (repeat === "custom" && ["monthly", "yearly"].includes(frequency) && !monthDays.length) { setValidation(t("Select at least one date")); return; } setValidation(""); save.mutate(); }} className="space-y-5">
    <h2 className="text-xl font-semibold">{t(schedule ? "Edit schedule" : "New task")}</h2>
    <fieldset disabled={save.isPending} className="space-y-5 disabled:opacity-60">
      <label className="block space-y-2 text-sm"><span>{t("Task name")}</span><Input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder={t("For example: Daily project summary")} /></label>
      <label className="block space-y-2 text-sm"><span>{t("Task type")}</span><SelectField disabled={save.isPending} fullWidth value={kind} onValueChange={v => setKind(v as Schedule["action"]["kind"])} options={[{ value: "message.send", label: t("Scheduled message") }, { value: "session.invoke", label: t("Scheduled execution") }, { value: "task.run", label: "直连后台任务巡检（task.run）" }]} /></label>
      {kind === "task.run" && (
        <label className="block space-y-2 text-sm">
          <span>关联后台任务（Task）</span>
          <SelectField
            disabled={save.isPending}
            fullWidth
            value={taskId}
            onValueChange={setTaskId}
            options={[
              { value: "", label: "请选择后台任务" },
              ...(tasks.data?.map(item => ({
                value: item.id,
                label: `${item.title || item.id} · ${item.id.slice(0, 8)}`,
              })) ?? []),
              ...(taskId && !(tasks.data ?? []).some(item => item.id === taskId)
                ? [{ value: taskId, label: taskId }]
                : []),
            ]}
          />
          <span className="block text-xs text-muted-foreground">到点直接以静默模式（quiet）唤醒该 Task Runner 执行，完成后再将报告交给目标会话 Main 决定是否发声。</span>
        </label>
      )}
      <label className="block space-y-2 text-sm"><span>{t(kind === "message.send" ? "Message content" : "Task instructions")}</span><textarea required rows={5} maxLength={100000} className="w-full rounded-md border bg-background p-3" value={content} onChange={e => setContent(e.target.value)} /></label>
      <label className="block space-y-2 text-sm"><span>{t("Target session")}</span><SelectField required disabled={save.isPending} fullWidth value={target} onValueChange={setTarget} options={[{ value: "", label: t("Select a session") }, ...(sessions.data?.map(s => ({ value: s.id, label: `${s.displayTitle || s.title || s.id} · ${s.id.slice(0, 8)}` })) ?? [])]} /></label>
      {sessions.isError && <p role="alert" className="text-sm text-destructive">无法加载会话。</p>}
      <section className="overflow-hidden rounded-xl border" aria-label={t("Schedule timing")}>
        <label className="flex items-center justify-between gap-4 border-b px-4 py-3"><span className="shrink-0 font-medium">{t("Repeat")}</span><SelectField aria-label={t("Repeat")} disabled={save.isPending} variant="ghost" align="end" value={repeat} onValueChange={setRepeat} options={[["once", "Never"], ["interval", "Interval"], ["daily", "Daily"], ["weekdays", "Weekdays"], ["weekly", "Weekly"], ["custom", "Custom"]].map(([value, label]) => ({ value: value!, label: t(label!) }))} /></label>
        {repeat === "custom" && <>
          <label className="flex items-center justify-between gap-4 border-b px-4 py-3"><span>{t("Repeats")}</span><SelectField aria-label={t("Repeats")} disabled={save.isPending} variant="ghost" align="end" value={frequency} onValueChange={v => setFrequency(v as typeof frequency)} options={[["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"]].map(([value, label]) => ({ value: value!, label: t(label!) }))} /></label>
          <label className="flex items-center justify-between gap-4 border-b px-4 py-3"><span>{t("Every")}</span><span className="flex items-center gap-2"><Input aria-label={t("Repeat interval")} type="number" required min={1} max={100} step={1} value={every} onChange={e => setEvery(e.target.value)} className="w-20 text-right" /><span className="text-muted-foreground">{t({hourly: "hours", daily: "days", weekly: "weeks", monthly: "months", yearly: "years"}[frequency])}</span></span></label>
          {frequency === "yearly" && <label className="flex items-center justify-between gap-4 border-b px-4 py-3"><span>{t("Month")}</span><SelectField aria-label={t("Month")} disabled={save.isPending} variant="ghost" align="end" value={month} onValueChange={setMonth} options={Array.from({length: 12}, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} /></label>}
          {["monthly", "yearly"].includes(frequency) && <div className="flex items-center justify-between gap-4 border-b px-4 py-3"><span>{t("On days")}</span><DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" aria-label={t("On days")} className="max-w-[70%] font-normal text-muted-foreground"><span className="truncate">{monthDays.length ? [...monthDays].sort((a,b) => a-b).join(", ") : t("Select dates")}</span><ChevronDown className="size-4 shrink-0" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-64 w-48 overflow-y-auto">{Array.from({length: 31}, (_, i) => i+1).map(day => <DropdownMenuCheckboxItem key={day} checked={monthDays.includes(day)} onSelect={event => event.preventDefault()} onCheckedChange={checked => setMonthDays(previous => checked ? [...new Set([...previous, day])].sort((a,b) => a-b) : previous.filter(d => d !== day))}>{day}</DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu></div>}
        </>}
        {(repeat === "weekly" || (repeat === "custom" && frequency === "weekly")) && <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"><span>{t("Run on")}</span><div className="flex flex-wrap gap-1">{[1,2,3,4,5,6,0].map(d => <Button key={d} type="button" size="sm" variant={days.includes(d) ? "default" : "outline"} aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter(value => value !== d) : [...days, d])}>{t(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]!)}</Button>)}</div></div>}
        {repeat === "custom" && <label className="flex items-center justify-between gap-4 border-b px-4 py-3"><span>{t("Start date")}</span><Input aria-label={t("Start date")} type="date" required className="w-auto max-w-full border-0 shadow-none" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>}
        {repeat !== "interval" && <label className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><span className="font-medium">{t(repeat === "custom" ? "Start time" : "Run time")}</span>{isCalendar ? <Input aria-label={t("Run time")} type="time" required value={time} onChange={e => setTime(e.target.value)} className="h-9 w-36 border-0 bg-transparent text-right shadow-none" /> : <Input aria-label={t("Run time")} type="datetime-local" required value={date} onChange={e => setDate(e.target.value)} className="h-9 w-auto max-w-full border-0 bg-transparent shadow-none" />}</label>}
        {repeat === "interval" && <div className="flex items-center justify-between gap-4 px-4 py-3"><span>{t("Every")}</span><div className="flex items-center gap-1"><Input aria-label={t("Repeat interval")} type="number" required min={1} max={intervalUnit === "hours" ? 8760 : 525600} step={1} value={intervalValue} onChange={e => setIntervalValue(e.target.value)} className="w-20 border-0 text-right shadow-none" /><SelectField aria-label={t("Interval unit")} disabled={save.isPending} variant="ghost" align="end" value={intervalUnit} onValueChange={setIntervalUnit} options={[{ value: "minutes", label: t("minutes") }, { value: "hours", label: t("hours") }]} /></div></div>}
      </section>
      <p className="text-xs text-muted-foreground">{t("Timezone")}: {timezone}{repeat === "once" ? ` · ${t("Runs once at the selected time")}` : repeat === "custom" && ["monthly", "yearly"].includes(frequency) ? ` · ${t("Dates that do not exist are skipped, not moved to month end.")}` : ""}</p>
      {isCalendar && <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("Advanced")}</summary><label className="mt-3 block space-y-2"><span>{t("Timezone")}</span><Input value={calendarTimezone} onChange={e => setCalendarTimezone(e.target.value)} required placeholder="Asia/Singapore" /></label></details>}
      <p className="text-xs leading-5 text-muted-foreground">计划任务使用当前登录用户的身份执行。</p>
      {schedule && <p className="text-xs text-muted-foreground">{t("Editing cancels pending runs. A run already in progress continues with its original settings.")}</p>}
      {(validation || save.isError) && <p role="alert" className="text-sm text-destructive">{validation || save.error?.message}</p>}
      <div className="flex gap-3"><Button type="submit" disabled={sessions.isLoading || sessions.isError}>{t(save.isPending ? "Saving…" : schedule ? "Save changes" : "Create task")}</Button><Button type="button" variant="outline" onClick={onCancel}>{t("Cancel")}</Button></div>
    </fieldset>
  </form>;
}

function recurrenceLabel(rule: NonNullable<Schedule["recurrence"]>, t: (key: string) => string) {
  const weekdays = () => rule.days.map(d => t(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]!)).join("、");
  if (rule.kind !== "custom" || !rule.frequency) return `${t({daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", custom: "Custom"}[rule.kind])} ${rule.time}${["weekly", "custom"].includes(rule.kind) ? " · " + weekdays() : ""}`;
  const unit = {hourly: "hours", daily: "days", weekly: "weeks", monthly: "months", yearly: "years"}[rule.frequency];
  return `${t("Every")} ${rule.every ?? 1} ${t(unit)} · ${rule.frequency === "weekly" ? weekdays() + " · " : rule.frequency === "yearly" ? `${rule.month}/${(rule.monthDays ?? [rule.dayOfMonth]).join(", ")} · ` : rule.frequency === "monthly" ? `${t("On days")} ${(rule.monthDays ?? [rule.dayOfMonth]).join(", ")} · ` : ""}${rule.time}`;
}
