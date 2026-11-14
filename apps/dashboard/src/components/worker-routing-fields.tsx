export interface WorkerRoutingOption {
  workerId: string;
  label: string;
}

export function WorkerRoutingFields({ mode, workerId, workers, disabled, onModeChange, onWorkerChange }: {
  mode: "automatic" | "bound"; workerId: string; workers: WorkerRoutingOption[]; disabled: boolean;
  onModeChange: (mode: "automatic" | "bound") => void; onWorkerChange: (workerId: string) => void;
}) {
  return <fieldset disabled={disabled} className="space-y-3">
    <label className="block space-y-2 text-sm">
      <span>Worker 分流规则</span>
      <select aria-label="Worker 分流规则" className="block h-9 w-full rounded-md border bg-background px-3" value={mode}
        onChange={event => onModeChange(event.target.value as "automatic" | "bound")}>
        <option value="automatic">自动分流</option>
        <option value="bound">绑定 Worker</option>
      </select>
    </label>
    {mode === "bound" && <label className="block space-y-2 text-sm">
      <span>绑定 Worker</span>
      <select aria-label="绑定 Worker" required className="block h-9 w-full rounded-md border bg-background px-3" value={workerId}
        onChange={event => onWorkerChange(event.target.value)}>
        <option value="">选择已分配给此 Agent 的 Worker</option>
        {workerId && !workers.some(worker => worker.workerId === workerId) && <option value={workerId}>{workerId} · 已不可用，请重新选择</option>}
        {workers.map(worker => <option key={worker.workerId} value={worker.workerId}>{worker.label}</option>)}
      </select>
    </label>}
    <p className="text-xs leading-5 text-muted-foreground">{mode === "automatic"
      ? "按节点可用性和负载自动分配，优先使用此分身已有的 Worker。"
      : "所有会话和任务在下一次执行时使用绑定节点。切换节点会重建上下文，不搬迁原运行目录；节点离线或暂停接单时不会自动分流。"}</p>
  </fieldset>;
}
