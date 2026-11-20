import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useRouteAgent } from "@/lib/agent-route";
import { apiFetch } from "@/lib/api/client";

export const Route = createFileRoute("/$agentId/settings/general/")({ component: AgentSettingsPage });

export type ProgressCardStyle = "card" | "native";
export interface AgentSettings {
  inbound: { processingReaction: boolean };
  work: { progressCard: { show: boolean; style: ProgressCardStyle } };
  main: { taskProgressCard: { send: boolean; style: ProgressCardStyle } };
  task?: { runLimitHours: number };
  pty?: { idleTimeoutMinutes: number };
}

const PTY_TIMEOUT_PRESETS: ReadonlyArray<{ readonly minutes: number; readonly label: string }> = [
  { minutes: 5, label: "5 分钟" },
  { minutes: 10, label: "10 分钟（默认）" },
  { minutes: 30, label: "30 分钟" },
  { minutes: 60, label: "1 小时" },
  { minutes: 120, label: "2 小时" },
  { minutes: 360, label: "6 小时" },
  { minutes: 1440, label: "24 小时" },
  { minutes: 0, label: "常驻不自动休眠" },
];

function validRunLimit(hours: number): boolean {
  return Number.isInteger(hours) && hours >= 1 && hours <= 168;
}

function normalizeSettings(settings: AgentSettings): Required<AgentSettings> {
  return {
    inbound: settings.inbound,
    work: settings.work,
    main: settings.main,
    task: { runLimitHours: settings.task?.runLimitHours ?? 10 },
    pty: { idleTimeoutMinutes: settings.pty?.idleTimeoutMinutes ?? 10 },
  };
}

function AgentSettingsPage() {
  const agent = useRouteAgent();
  return <AgentSettingsLoader key={agent.id} agentId={agent.id} agentName={agent.name} />;
}

function AgentSettingsLoader({ agentId, agentName }: { agentId: string; agentName: string }) {
  const client = useQueryClient();
  const path = `/agents/${encodeURIComponent(agentId)}/settings`;
  const query = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => apiFetch<{ settings: AgentSettings }>(path, { signal }),
  });

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestReqIdRef = useRef(0);

  const enqueueSave = (nextSettings: AgentSettings) => {
    const reqId = ++latestReqIdRef.current;
    setSaving(true);
    setSaveError(null);
    saveChainRef.current = saveChainRef.current
      .catch(() => {})
      .then(async () => {
        try {
          const data = await apiFetch<{ settings: AgentSettings }>(path, {
            method: "PUT",
            body: JSON.stringify(nextSettings),
          });
          if (reqId === latestReqIdRef.current) {
            client.setQueryData([path], data);
            setSaving(false);
            setSavedAt(Date.now());
          }
        } catch (err) {
          if (reqId === latestReqIdRef.current) {
            setSaving(false);
            setSaveError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
  };

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Agent 设置</h1>
          <p className="text-muted-foreground">{agentName} 的通用设置，修改后立即自动保存并对所有分身生效。</p>
        </div>
        <div className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {saving ? "正在自动保存…" : saveError ? null : savedAt ? "已自动保存" : null}
        </div>
      </div>
      {query.error && <p role="alert" className="text-destructive">无法加载设置。{query.error.message}</p>}
      {query.isLoading && <p role="status">正在加载…</p>}
      {query.data && (
        <AgentSettingsForm
          settings={query.data.settings}
          error={saveError}
          onChange={enqueueSave}
        />
      )}
    </main>
  );
}

export function AgentSettingsForm({
  settings,
  error,
  onChange,
}: {
  readonly settings: AgentSettings;
  readonly error: Error | null;
  readonly onChange: (value: AgentSettings) => void;
}) {
  const [value, setValue] = useState<Required<AgentSettings>>(() => normalizeSettings(settings));

  useEffect(() => {
    setValue(normalizeSettings(settings));
  }, [settings]);

  const update = (next: Required<AgentSettings>) => {
    setValue(next);
    if (validRunLimit(next.task.runLimitHours)) {
      onChange(next);
    }
  };

  const work = value.work.progressCard;
  const main = value.main.taskProgressCard;
  const ptyMinutes = value.pty.idleTimeoutMinutes;
  const runLimitValid = validRunLimit(value.task.runLimitHours);
  const hasPreset = PTY_TIMEOUT_PRESETS.some(p => p.minutes === ptyMinutes);

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-destructive">保存失败：{error.message}</p>}

      <section className="space-y-4 rounded-lg border p-4" aria-labelledby="inbound-title">
        <div>
          <h2 id="inbound-title" className="font-medium">收到消息</h2>
          <p className="text-sm text-muted-foreground">在聊天里 @ 或私聊分身时的即时反馈。</p>
        </div>
        <Row label="收到消息时添加表情回应" hint="分身开始处理前给这条消息加一个表情，回复后自动移除。">
          <Switch
            aria-label="收到消息时添加表情回应"
            checked={value.inbound.processingReaction}
            onCheckedChange={processingReaction => update({ ...value, inbound: { processingReaction } })}
          />
        </Row>
      </section>

      <section className="space-y-4 rounded-lg border p-4" aria-labelledby="pty-title">
        <div>
          <h2 id="pty-title" className="font-medium">TUI 伪终端</h2>
          <p className="text-sm text-muted-foreground">
            模型配置使用「交互式伪终端（pty）」时，控制空闲 CLI 进程在容器内的常驻保活时间。休眠后不丢失上下文，下次发消息自动恢复。
          </p>
        </div>
        <Row
          label="空闲保活时长"
          hint="每轮对话结束或手动接管输入后重新计时；设为「常驻不自动休眠」时进程一直保留到容器重启。"
        >
          <select
            aria-label="TUI 空闲保活时长"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={String(ptyMinutes)}
            onChange={e => {
              const minutes = Number(e.target.value);
              if (Number.isInteger(minutes) && minutes >= 0) {
                update({ ...value, pty: { idleTimeoutMinutes: minutes } });
              }
            }}
          >
            {!hasPreset && (
              <option value={String(ptyMinutes)}>{ptyMinutes} 分钟</option>
            )}
            {PTY_TIMEOUT_PRESETS.map(item => (
              <option key={item.minutes} value={String(item.minutes)}>
                {item.label}
              </option>
            ))}
          </select>
        </Row>
      </section>

      <section className="space-y-4 rounded-lg border p-4" aria-labelledby="work-progress-title">
        <div>
          <h2 id="work-progress-title" className="font-medium">Work 会话进度卡</h2>
          <p className="text-sm text-muted-foreground">`#work` 会话执行时，在话题里展示并实时更新的进度。</p>
        </div>
        <Row label="展示进度卡" hint="关闭后执行中和完成时都不发进度卡；执行出错或被取消仍会提示。">
          <Switch
            aria-label="展示 Work 进度卡"
            checked={work.show}
            onCheckedChange={show => update({ ...value, work: { progressCard: { ...work, show } } })}
          />
        </Row>
        <Row label="进度卡样式">
          <StyleChoice
            name="work-style"
            value={work.style}
            disabled={!work.show}
            onChange={style => update({ ...value, work: { progressCard: { ...work, style } } })}
          />
        </Row>
      </section>

      <section className="space-y-4 rounded-lg border p-4" aria-labelledby="main-progress-title">
        <div>
          <h2 id="main-progress-title" className="font-medium">Main 启动任务的进度卡</h2>
          <p className="text-sm text-muted-foreground">
            主会话启动任务时默认怎么发进度卡。用户或 Agent 对某个任务另有要求时，以那次的要求为准。
          </p>
        </div>
        <Row label="发送进度卡">
          <Switch
            aria-label="Main 启动任务时发送进度卡"
            checked={main.send}
            onCheckedChange={send => update({ ...value, main: { taskProgressCard: { ...main, send } } })}
          />
        </Row>
        <Row label="默认样式">
          <StyleChoice
            name="main-style"
            value={main.style}
            disabled={!main.send}
            onChange={style => update({ ...value, main: { taskProgressCard: { ...main, style } } })}
          />
        </Row>
      </section>

      <section className="space-y-4 rounded-lg border p-4" aria-labelledby="task-limit-title">
        <div>
          <h2 id="task-limit-title" className="font-medium">任务运行时长</h2>
          <p className="text-sm text-muted-foreground">
            任务每次运行最多可以持续多久。超过后这次运行会被停止并记为失败，可以重新运行。
          </p>
        </div>
        <Row label="单次运行上限（小时）" hint="1 到 168 之间的整数。对之后开始的运行生效。">
          <Input
            type="number"
            aria-label="任务单次运行上限（小时）"
            className="w-24"
            min={1}
            max={168}
            step={1}
            value={Number.isFinite(value.task.runLimitHours) ? value.task.runLimitHours : ""}
            onChange={event => update({ ...value, task: { runLimitHours: event.target.valueAsNumber } })}
          />
        </Row>
        {!runLimitValid && (
          <p role="alert" className="text-xs text-destructive">
            请输入 1 到 168 之间的整数小时数。
          </p>
        )}
      </section>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

const STYLES: { value: ProgressCardStyle; label: string; hint: string }[] = [
  { value: "card", label: "卡片", hint: "带标题和步骤列表的交互卡片" },
  { value: "native", label: "飞书原生进度", hint: "飞书自带的执行过程消息，样式更轻" },
];

function StyleChoice({
  name,
  value,
  disabled,
  onChange,
}: {
  name: string;
  value: ProgressCardStyle;
  disabled: boolean;
  onChange: (style: ProgressCardStyle) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={name === "work-style" ? "Work 进度卡样式" : "Main 进度卡默认样式"}
      className="flex gap-2"
    >
      {STYLES.map(style => (
        <label
          key={style.value}
          title={style.hint}
          className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
            value === style.value ? "border-primary bg-primary/5" : ""
          } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
        >
          <input
            type="radio"
            name={name}
            value={style.value}
            checked={value === style.value}
            disabled={disabled}
            onChange={() => onChange(style.value)}
          />
          {style.label}
        </label>
      ))}
    </div>
  );
}
