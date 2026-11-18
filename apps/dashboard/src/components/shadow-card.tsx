import Avatar from "boring-avatars";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { consoleLabels, type ConsoleKind } from "@/lib/containers";
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

/**
 * One hue family per Shadow, assigned by list position so neighbouring Shadows never look alike
 * (the default palette, picked by ID hash, often gave two Shadows the same colours).
 */
export const SHADOW_PALETTES = [
  ["#1d4ed8", "#3b82f6", "#93c5fd", "#1e3a8a", "#dbeafe"],
  ["#c2410c", "#f97316", "#fdba74", "#7c2d12", "#ffedd5"],
  ["#047857", "#10b981", "#6ee7b7", "#064e3b", "#d1fae5"],
  ["#7e22ce", "#a855f7", "#d8b4fe", "#4c1d95", "#f3e8ff"],
  ["#be123c", "#f43f5e", "#fda4af", "#881337", "#ffe4e6"],
  ["#0e7490", "#06b6d4", "#67e8f9", "#164e63", "#cffafe"],
  ["#a16207", "#eab308", "#fde047", "#713f12", "#fef9c3"],
  ["#4338ca", "#6366f1", "#a5b4fc", "#312e81", "#e0e7ff"],
] as const;

const order: ConsoleKind[] = ["terminal", "vnc", "root"];

/**
 * One Shadow: who it is (name, bot binding) and its runtime environment (state, root switch,
 * facts, console buttons). `compact` is the narrow column shown beside open consoles.
 */
export function ShadowCard({ id, paletteIndex = 0, name, isBody, subtitle, statusTag, environment, coldHint, root, menu, footer, compact, selected, onOpen, openBlocked }: {
  id: string;
  /** Position in the Shadow list; picks the avatar's hue family. */
  paletteIndex?: number;
  name: string;
  isBody: boolean;
  subtitle: string;
  /** Shown beside the name when the Shadow is not simply active (e.g. 已停用). */
  statusTag?: string;
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
        <span className="flex shrink-0 overflow-hidden rounded-[10px] ring-1 ring-black/5" aria-hidden="true">
          <Avatar name={id} variant="marble" size={compact ? 28 : 36} square colors={[...SHADOW_PALETTES[paletteIndex % SHADOW_PALETTES.length]!]} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold">{name}</h2>
            {isBody && <span className="shrink-0 rounded-full bg-muted px-2 text-[11px] text-muted-foreground">本体</span>}
            {statusTag && <span className="shrink-0 rounded-full bg-amber-500/10 px-2 text-[11px] text-amber-700 dark:text-amber-400">{statusTag}</span>}
          </div>
          {!compact && <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{subtitle}</p>}
        </div>
        {menu}
      </div>
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
