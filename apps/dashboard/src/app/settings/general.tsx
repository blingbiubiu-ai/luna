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
  messages?: MessageSettings;
  listening?: ListeningSettings;
}

/** Listening in group chats: when overheard messages are given to the Runner together. Times are in milliseconds. */
export interface ListeningSettings {
  defaultEnabled: boolean;
  quietMs: number;
  batchSize: number;
  maxWaitMs: number;
  backoffMaxMs: number;
  maxTurnsPerHour: number;
}
const DEFAULT_LISTENING: ListeningSettings = { defaultEnabled: false, quietMs: 30000, batchSize: 10, maxWaitMs: 180000, backoffMaxMs: 600000, maxTurnsPerHour: 12 };

type ListeningNumber = Exclude<keyof ListeningSettings, "defaultEnabled">;
const LISTENING_FIELDS: Record<ListeningNumber, { label: string; hint: string; unit: string; scale: number; min: number; max: number; step: number }> = {
  quietMs: { label: "群里安静多久后看一批（秒）", hint: "最后一条消息之后这么久没人说话，就把攒下的消息交给分身。", unit: "秒", scale: 1000, min: 5, max: 3600, step: 1 },
  batchSize: { label: "攒够几条就看", hint: "不等安静，攒到这么多条就交给分身。", unit: "条", scale: 1, min: 1, max: 100, step: 1 },
  maxWaitMs: { label: "最长攒多久（分钟）", hint: "从第一条消息起最多等这么久。", unit: "分钟", scale: 60000, min: 0.5, max: 60, step: 0.5 },
  backoffMaxMs: { label: "连续沉默后的间隔上限（分钟）", hint: "分身每次看完不说话，下次等待时间翻倍，最长到这个值；它开口或被 @ 后恢复。", unit: "分钟", scale: 60000, min: 0.5, max: 1440, step: 0.5 },
  maxTurnsPerHour: { label: "每个群每小时最多几轮", hint: "一个群一小时内最多旁听这么多轮，超出的消息攒到下一小时或有人 @ 时一起看。", unit: "轮", scale: 1, min: 1, max: 120, step: 1 },
};


/** How incoming messages become Runner turns; a field left out follows the Service configuration. */
export interface MessageSettings {
  coalesceIdleMs?: number;
  coalesceMaxWaitMs?: number;
  maxBatchSize?: number;
  groupBotAliases?: string[];
  followupWindowMs?: number;
  followupMaxMessages?: number;
  followupSenders?: FollowupSenders;
  followupInterruptOnOtherUser?: boolean;
  followupRecentMessages?: number;
  contextWindowMs?: number;
  contextMaxMessages?: number;
  contextMaxChars?: number;
  contextRecentUnprocessedMessages?: number;
}
export type FollowupSenders = "requester_only" | "requester_and_reporters";
export type MessageDefaults = Required<MessageSettings>;

/** The Service defaults, used until the server has said what they are. */
const FALLBACK_MESSAGE_DEFAULTS: MessageDefaults = {
  coalesceIdleMs: 1200, coalesceMaxWaitMs: 5000, maxBatchSize: 8, groupBotAliases: [],
  followupWindowMs: 300000, followupMaxMessages: 8, followupSenders: "requester_and_reporters",
  followupInterruptOnOtherUser: true, followupRecentMessages: 3,
  contextWindowMs: 300000, contextMaxMessages: 12, contextMaxChars: 6000, contextRecentUnprocessedMessages: 10,
};

type NumericMessageSetting = { [K in keyof MessageSettings]-?: MessageSettings[K] extends number | undefined ? K : never }[keyof MessageSettings];

/** Each number setting as shown on the page: the unit it is edited in and its allowed range in that unit. */
const NUMBER_FIELDS: Record<NumericMessageSetting, { label: string; hint: string; unit: string; scale: number; min: number; max: number; step: number }> = {
  coalesceIdleMs: { label: "合并等待（秒）", hint: "会话空闲时收到一条消息，等同一个人在这段时间内继续发，再一起交给分身。", unit: "秒", scale: 1000, min: 0.1, max: 60, step: 0.1 },
  coalesceMaxWaitMs: { label: "最长合并时间（秒）", hint: "从第一条消息起最多等这么久，不能短于合并等待。", unit: "秒", scale: 1000, min: 0.1, max: 300, step: 0.1 },
  maxBatchSize: { label: "每轮最多几条", hint: "一轮最多合并同一个人的几条消息。", unit: "条", scale: 1, min: 1, max: 50, step: 1 },
  followupWindowMs: { label: "追问有效时长（分钟）", hint: "群里有人叫过分身后，这段时间内不 @ 也算在叫它；0 表示关闭追问。", unit: "分钟", scale: 60000, min: 0, max: 60, step: 1 },
  followupMaxMessages: { label: "追问最多几条", hint: "一次唤醒之后最多把几条不 @ 的消息当作追问。", unit: "条", scale: 1, min: 0, max: 50, step: 1 },
  followupRecentMessages: { label: "判断追问时看最近几条", hint: "判断话题有没有转移、以及唤醒时至少带几条最近消息。", unit: "条", scale: 1, min: 0, max: 20, step: 1 },
  contextWindowMs: { label: "上下文时间窗口（分钟）", hint: "群里被叫时，把这段时间内的群消息作为上下文一起交给分身。", unit: "分钟", scale: 60000, min: 0, max: 1440, step: 1 },
  contextMaxMessages: { label: "上下文最多几条", hint: "带进去的群消息条数上限。", unit: "条", scale: 1, min: 0, max: 100, step: 1 },
  contextMaxChars: { label: "上下文最多多少字", hint: "带进去的群消息总字数上限。", unit: "字", scale: 1, min: 0, max: 50000, step: 100 },
  contextRecentUnprocessedMessages: { label: "补充未处理消息条数", hint: "时间窗口内消息太少时，最多再补几条还没交给过分身的消息。", unit: "条", scale: 1, min: 0, max: 100, step: 1 },
};

/** Whether a value typed in a field's unit is allowed; the stored value is in milliseconds or a count. */
function validNumber(field: NumericMessageSetting, shown: number): boolean {
  const { min, max, scale } = NUMBER_FIELDS[field];
  if (!Number.isFinite(shown) || shown < min || shown > max) return false;
  // Counts are whole numbers; a time may have a fraction as long as it is a whole number of milliseconds.
  return scale === 1 ? Number.isInteger(shown) : Math.abs(shown * scale - Math.round(shown * scale)) < 1e-6;
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
    messages: settings.messages ?? {},
    listening: settings.listening ?? DEFAULT_LISTENING,
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
    queryFn: ({ signal }) => apiFetch<{ settings: AgentSettings; messageDefaults?: MessageDefaults }>(path, { signal }),
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
          const data = await apiFetch<{ settings: AgentSettings; messageDefaults?: MessageDefaults }>(path, {
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
          {...(query.data.messageDefaults ? { messageDefaults: query.data.messageDefaults } : {})}
          error={saveError}
          onChange={enqueueSave}
        />
      )}
    </main>
  );
}

export function AgentSettingsForm({
  settings,
  messageDefaults = FALLBACK_MESSAGE_DEFAULTS,
  error,
  onChange,
}: {
  readonly settings: AgentSettings;
  /** What each message setting the Agent leaves unset follows. */
  readonly messageDefaults?: MessageDefaults;
  readonly error: Error | null;
  readonly onChange: (value: AgentSettings) => void;
}) {
  const [value, setValue] = useState<Required<AgentSettings>>(() => normalizeSettings(settings));

  useEffect(() => {
    setValue(normalizeSettings(settings));
  }, [settings]);

  const update = (next: Required<AgentSettings>) => {
    setValue(next);
    const idle = next.messages.coalesceIdleMs ?? messageDefaults.coalesceIdleMs;
    const maxWait = next.messages.coalesceMaxWaitMs ?? messageDefaults.coalesceMaxWaitMs;
    if (validRunLimit(next.task.runLimitHours) && maxWait >= idle) {
      onChange(next);
    }
  };

  const work = value.work.progressCard;
  const main = value.main.taskProgressCard;
  const ptyMinutes = value.pty.idleTimeoutMinutes;
  const runLimitValid = validRunLimit(value.task.runLimitHours);
  const hasPreset = PTY_TIMEOUT_PRESETS.some(p => p.minutes === ptyMinutes);
  const messages = value.messages;
  /** Sets or, with undefined, clears one message setting; the server checks the combination. */
  const setMessage = <K extends keyof MessageSettings>(key: K, next: MessageSettings[K] | undefined) => {
    const rest = { ...messages };
    delete rest[key];
    update({ ...value, messages: next === undefined ? rest : { ...rest, [key]: next } });
  };
  const effectiveIdle = messages.coalesceIdleMs ?? messageDefaults.coalesceIdleMs;
  const effectiveMaxWait = messages.coalesceMaxWaitMs ?? messageDefaults.coalesceMaxWaitMs;
  const numberRow = (field: NumericMessageSetting) => (
    <MessageNumberRow
      key={field}
      field={field}
      value={messages[field]}
      fallback={messageDefaults[field]}
      onChange={next => setMessage(field, next)}
    />
  );

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

      <section className="space-y-4 rounded-lg border p-4" aria-labelledby="messages-title">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="messages-title" className="font-medium">消息处理</h2>
            <p className="text-sm text-muted-foreground">
              消息怎么合并成一轮交给分身、群里什么算在叫分身、被叫时带多少群上下文。留空的项使用平台默认值（输入框里灰色显示）。
            </p>
          </div>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
            disabled={Object.keys(messages).length === 0}
            onClick={() => update({ ...value, messages: {} })}
          >
            全部恢复默认
          </button>
        </div>

        <h3 className="text-sm font-medium text-muted-foreground">合并消息</h3>
        {numberRow("coalesceIdleMs")}
        {numberRow("coalesceMaxWaitMs")}
        {effectiveMaxWait < effectiveIdle && (
          <p role="alert" className="text-xs text-destructive">最长合并时间不能短于合并等待，这次修改没有保存。</p>
        )}
        {numberRow("maxBatchSize")}

        <h3 className="text-sm font-medium text-muted-foreground">群里怎么算叫分身</h3>
        <AliasRow
          value={messages.groupBotAliases}
          fallback={messageDefaults.groupBotAliases}
          onChange={next => setMessage("groupBotAliases", next)}
        />
        {numberRow("followupWindowMs")}
        {numberRow("followupMaxMessages")}
        <Row label="谁的消息算追问">
          <select
            aria-label="谁的消息算追问"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={messages.followupSenders ?? ""}
            onChange={event => setMessage("followupSenders", (event.target.value || undefined) as FollowupSenders | undefined)}
          >
            <option value="">默认（{SENDER_LABEL[messageDefaults.followupSenders]}）</option>
            <option value="requester_only">{SENDER_LABEL.requester_only}</option>
            <option value="requester_and_reporters">{SENDER_LABEL.requester_and_reporters}</option>
          </select>
        </Row>
        <Row label="别人插话时结束追问" hint="开启后，追问期间有其他人说话，就要重新 @ 分身。">
          <Switch
            aria-label="别人插话时结束追问"
            checked={messages.followupInterruptOnOtherUser ?? messageDefaults.followupInterruptOnOtherUser}
            onCheckedChange={next => setMessage("followupInterruptOnOtherUser", next === messageDefaults.followupInterruptOnOtherUser ? undefined : next)}
          />
        </Row>
        {numberRow("followupRecentMessages")}

        <h3 className="text-sm font-medium text-muted-foreground">被叫时带的群上下文</h3>
        {numberRow("contextWindowMs")}
        {numberRow("contextMaxMessages")}
        {numberRow("contextMaxChars")}
        {numberRow("contextRecentUnprocessedMessages")}
      </section>

      <section className="space-y-4 rounded-lg border p-4" aria-labelledby="listening-title">
        <div>
          <h2 id="listening-title" className="font-medium">旁听</h2>
          <p className="text-sm text-muted-foreground">
            在开了旁听的群里，没有 @ 分身的消息会攒成一批交给它，它觉得该说话时才开口，否则保持沉默。@ 它的消息仍然立即处理。
            每个群单独开关：在群里 @ 分身让它开始或停止旁听，或在该群的会话页面右上角切换。
          </p>
        </div>
        <Row label="新群默认开启旁听" hint="没有单独设置过的群是否旁听。开启后，这些群里所有人的消息都会发给模型。">
          <Switch
            aria-label="新群默认开启旁听"
            checked={value.listening.defaultEnabled}
            onCheckedChange={defaultEnabled => update({ ...value, listening: { ...value.listening, defaultEnabled } })}
          />
        </Row>
        {(Object.keys(LISTENING_FIELDS) as ListeningNumber[]).map(field => (
          <RequiredNumberRow
            key={field}
            meta={LISTENING_FIELDS[field]}
            value={value.listening[field]}
            onChange={next => update({ ...value, listening: { ...value.listening, [field]: next } })}
          />
        ))}
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

const SENDER_LABEL: Record<FollowupSenders, string> = {
  requester_only: "只有叫分身的人",
  requester_and_reporters: "叫分身的人和向它汇报的人",
};

/**
 * One number setting, edited in its own unit. An empty box follows the default; a value out of range is not saved.
 * The typed text is kept while editing so a half-typed number is not overwritten.
 */
function MessageNumberRow({ field, value, fallback, onChange }: {
  field: NumericMessageSetting;
  value: number | undefined;
  fallback: number;
  onChange: (next: number | undefined) => void;
}) {
  const meta = NUMBER_FIELDS[field];
  const shown = (ms: number | undefined) => ms === undefined ? "" : String(Math.round((ms / meta.scale) * 1000) / 1000);
  const [text, setText] = useState(shown(value));
  useEffect(() => { setText(shown(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = text.trim() === "" ? undefined : Number(text);
  const invalid = parsed !== undefined && !validNumber(field, parsed);
  return (
    <div className="space-y-1">
      <Row label={meta.label} hint={meta.hint}>
        <Input
          type="number"
          aria-label={meta.label}
          className="w-28"
          min={meta.min}
          max={meta.max}
          step={meta.step}
          placeholder={shown(fallback)}
          value={text}
          onChange={event => {
            const next = event.target.value;
            setText(next);
            if (next.trim() === "") { onChange(undefined); return; }
            const number = Number(next);
            if (validNumber(field, number)) onChange(Math.round(number * meta.scale));
          }}
        />
      </Row>
      {invalid && (
        <p role="alert" className="text-xs text-destructive">请输入 {meta.min} 到 {meta.max} {meta.unit}之间的数，这次修改没有保存。</p>
      )}
    </div>
  );
}

/** A number setting that always has a value, edited in its own unit; a value out of range is not saved. */
function RequiredNumberRow({ meta, value, onChange }: {
  meta: { label: string; hint: string; unit: string; scale: number; min: number; max: number; step: number };
  value: number;
  onChange: (next: number) => void;
}) {
  const shown = (stored: number) => String(Math.round((stored / meta.scale) * 1000) / 1000);
  const [text, setText] = useState(shown(value));
  useEffect(() => { setText(shown(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = (number: number) => Number.isFinite(number) && number >= meta.min && number <= meta.max && Number.isInteger(Math.round(number * meta.scale * 1000) / 1000);
  return (
    <div className="space-y-1">
      <Row label={meta.label} hint={meta.hint}>
        <Input
          type="number"
          aria-label={meta.label}
          className="w-28"
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={text}
          onChange={event => {
            setText(event.target.value);
            const number = Number(event.target.value);
            if (event.target.value.trim() !== "" && valid(number)) onChange(Math.round(number * meta.scale));
          }}
        />
      </Row>
      {(text.trim() === "" || !valid(Number(text))) && (
        <p role="alert" className="text-xs text-destructive">请输入 {meta.min} 到 {meta.max} {meta.unit}之间的数，这次修改没有保存。</p>
      )}
    </div>
  );
}

/** Group aliases as one comma-separated line, saved when the box loses focus; empty follows the default. */
function AliasRow({ value, fallback, onChange }: {
  value: string[] | undefined;
  fallback: string[];
  onChange: (next: string[] | undefined) => void;
}) {
  const [text, setText] = useState((value ?? []).join("，"));
  useEffect(() => { setText((value ?? []).join("，")); }, [value]);
  const aliases = text.split(/[,，]/).map(alias => alias.trim()).filter(Boolean);
  const invalid = aliases.length > 10 || aliases.some(alias => alias.length > 32);
  return (
    <div className="space-y-1">
      <Row label="唤醒别名" hint="群消息以这些名字开头时，和 @ 分身一样。多个用逗号分隔，最多 10 个，每个不超过 32 字。">
        <Input
          aria-label="唤醒别名"
          className="w-56"
          placeholder={fallback.length ? fallback.join("，") : "默认：无"}
          value={text}
          onChange={event => setText(event.target.value)}
          onBlur={() => { if (!invalid) onChange(aliases.length ? aliases : undefined); }}
        />
      </Row>
      {invalid && <p role="alert" className="text-xs text-destructive">最多 10 个别名，每个不超过 32 字，这次修改没有保存。</p>}
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
