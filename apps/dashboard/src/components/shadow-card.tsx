import { IdentityAvatar } from "@/components/identity-link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { consoleLabels, type ConsoleKind } from "@/lib/containers";
import type { BotStatus } from "@/lib/bot-status";
import { cn } from "@/lib/utils";

/** A Shadow's runtime environment as shown on its card. */
export interface ShadowEnvironment {
  state: "running" | "stopped" | "cold";
  workerId?: string;
  cpus?: number;
  memory?: string;
  /** Whether the container runs its Worker's current image; undefined when unknown. */
  imageCurrent?: boolean;
  activeJobs?: number;
  activeStreams?: number;
  /** Environments left on other Workers (after the Shadow moved). */
  elsewhere?: { workerId: string; running: boolean }[];
}

const order: ConsoleKind[] = ["terminal", "vnc", "root"];

/**
 * One Shadow: who it is (name, bot binding) and its runtime environment (state, root switch,
 * facts, console buttons). `compact` is the narrow column shown beside open consoles.
 */
export function ShadowCard({ id, avatarUrl, name, isBody, subtitle, statusTag, bot, environment, coldHint, root, menu, footer, compact, selected, onOpen, openBlocked }: {
  id: string;
  /** The Shadow user's avatar (its bot's, once a bot is bound). */
  avatarUrl?: string | null;
  name: string;
  isBody: boolean;
  subtitle?: string;
  /** The Shadow's own status, shown beside its name only when it is not active (e.g. 分身已停用). */
  statusTag?: string;
  /** The channel bot row: its own status, separate from the Shadow's. */
  bot?: ReactNode;
  environment: ShadowEnvironment;
  coldHint?: string;
  root: ReactNode;
  menu: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
  selected?: boolean;
  onOpen: (kind: ConsoleKind) => void;
  /** Why a console kind cannot open right now; undefined when it can. */
  openBlocked: (kind: ConsoleKind) => string | undefined;
}) {
  const env = environment;
  const facts = env.state === "cold"
    ? [coldHint ?? "首次打开终端或桌面时自动创建"]
    : [
      env.workerId && `Worker ${env.workerId}`,
      env.cpus !== undefined && `${env.cpus} CPU · ${env.memory}`,
      env.imageCurrent === true ? "镜像最新" : env.imageCurrent === false ? "镜像待更新" : undefined,
      env.activeJobs ? `${env.activeJobs} 个任务进行中` : "空闲",
      env.activeStreams ? `${env.activeStreams} 个控制台已打开` : undefined,
    ].filter((fact): fact is string => Boolean(fact));
  return (
    <article aria-label={name} className={cn("rounded-[14px] border bg-card transition-colors hover:border-foreground/15",
      selected && "border-foreground/25 shadow-[0_0_0_2px_rgba(48,48,43,0.08)]")}>
      <div className={cn("flex items-center gap-3", compact ? "px-3 pt-2.5 pb-2" : "px-4 pt-3.5 pb-3")}>
        <IdentityAvatar className={cn("shrink-0", compact ? "size-7" : "size-9")} size={compact ? "sm" : "default"} identity={{
          id, channel: { type: "user", id: "" }, externalId: id, identityKind: "shadow", displayName: name,
          status: "active", avatarUrl: avatarUrl ?? null, providerIds: {},
        }} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold">{name}</h2>
            {isBody && <span className="shrink-0 rounded-full bg-muted px-2 text-[11px] text-muted-foreground">本体</span>}
            {statusTag && <span className="shrink-0 rounded-full bg-amber-500/10 px-2 text-[11px] text-amber-700 dark:text-amber-400">{statusTag}</span>}
          </div>
          {!compact && subtitle && <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{subtitle}</p>}
        </div>
        {menu}
      </div>
      {!compact && bot}
      <div className={cn("grid gap-2 rounded-[10px] bg-muted", compact ? "mx-2 mb-2 px-2.5 py-2" : "mx-2.5 mb-2.5 px-3 py-2.5")}>
        <div className="flex items-center gap-2">
          <EnvironmentState state={env.state} />
          <span className="flex-1" />
          {!compact && root}
        </div>
        {!compact && <p className="flex flex-wrap text-[12.5px] text-muted-foreground">
          {facts.map((fact, index) => <span key={fact} className={cn(fact === "镜像待更新" && "text-amber-700 dark:text-amber-400")}
            title={fact === "镜像待更新" ? "下次启动或重建容器时更新到 Worker 当前镜像" : undefined}>
            {index > 0 && <span aria-hidden="true" className="mx-2 text-muted-foreground/50">·</span>}{fact}
          </span>)}
        </p>}
        <div className="flex flex-wrap gap-1.5">
          {order.map(kind => {
            const blocked = openBlocked(kind);
            return <Button key={kind} size={compact ? "xs" : "sm"} variant={kind === "root" ? "ghost" : "outline"}
              className={cn(kind === "root" && "text-muted-foreground")} disabled={Boolean(blocked)} title={blocked}
              onClick={() => onOpen(kind)}>{consoleLabels[kind]}</Button>;
          })}
        </div>
        {!compact && env.elsewhere?.map(other => <p key={other.workerId} className="border-t border-dashed pt-2 text-xs text-muted-foreground">
          Worker {other.workerId} 上还留有一个旧环境（{other.running ? "运行中" : "已停止"}）
        </p>)}
        {footer}
      </div>
    </article>
  );
}

function EnvironmentState({ state }: { state: ShadowEnvironment["state"] }) {
  return <span className="worker-presence shrink-0" data-online={state === "running"} data-cold={state === "cold"}>
    <span className="worker-presence-dot" aria-hidden="true" />
    {state === "running" ? "运行中" : state === "stopped" ? "已停止" : "未创建"}
  </span>;
}

const toneClass: Record<BotStatus["tone"], string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  pending: "bg-muted text-muted-foreground",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  error: "bg-destructive/10 text-destructive",
  off: "bg-muted text-muted-foreground",
};
const actionLabel: Record<NonNullable<BotStatus["action"]>, string> = { enable: "启用机器人", retry: "重试连接", resecret: "重新填写 App Secret" };

/**
 * The channel bot row on a Shadow card, labelled 渠道机器人 so its status is never read as the
 * Shadow's. `name` is null when no bot is bound.
 */
export function ShadowBotRow({ channel, name, status, busy, onAction }: {
  channel: string; name: string | null; status?: BotStatus; busy?: boolean; onAction?: (action: NonNullable<BotStatus["action"]>) => void;
}) {
  return <div className="mx-2.5 mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-1.5 text-[12.5px]">
    <span className="shrink-0 text-muted-foreground">渠道机器人</span>
    {name === null ? <span className="text-muted-foreground">未绑定</span> : <>
      <span className="min-w-0 truncate">{channel} · {name}</span>
      {status && <span title={status.detail} className={cn("shrink-0 rounded-full px-2 text-[11.5px]", toneClass[status.tone])}>{status.label}</span>}
      {status?.action && onAction && <Button size="xs" variant="outline" disabled={busy} onClick={() => onAction(status.action!)}>{actionLabel[status.action]}</Button>}
    </>}
  </div>;
}
