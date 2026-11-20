import { SelectField } from "@/components/ui/select-field";

export interface WorkerRoutingOption {
  workerId: string;
  label: string;
}

export function WorkerRoutingFields({
  mode,
  workerId,
  workers,
  disabled,
  onModeChange,
  onWorkerChange,
}: {
  mode: "automatic" | "bound";
  workerId: string;
  workers: WorkerRoutingOption[];
  disabled: boolean;
  onModeChange: (mode: "automatic" | "bound") => void;
  onWorkerChange: (workerId: string) => void;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <label className="block space-y-2 text-sm">
        <span>Worker 分流规则</span>
        <SelectField
          aria-label="Worker 分流规则"
          value={mode}
          disabled={disabled}
          fullWidth
          onValueChange={(next) =>
            onModeChange(next === "bound" ? "bound" : "automatic")
          }
          options={[
            { value: "automatic", label: "自动分流" },
            { value: "bound", label: "绑定 Worker" },
          ]}
        />
      </label>
      {mode === "bound" && (
        <label className="block space-y-2 text-sm">
          <span>绑定 Worker</span>
          <SelectField
            aria-label="绑定 Worker"
            required
            value={workerId}
            disabled={disabled}
            fullWidth
            onValueChange={onWorkerChange}
            options={[
              { value: "", label: "选择已分配给此 Agent 的 Worker" },
              ...(workerId && !workers.some((w) => w.workerId === workerId)
                ? [
                    {
                      value: workerId,
                      label: `${workerId} · 已不可用，请重新选择`,
                    },
                  ]
                : []),
              ...workers.map((w) => ({ value: w.workerId, label: w.label })),
            ]}
          />
        </label>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        {mode === "automatic"
          ? "按节点可用性和负载自动分配，优先使用此分身已有的 Worker。"
          : "所有会话和任务在下一次执行时使用绑定节点。切换节点会重建上下文，不搬迁原运行目录；节点离线或暂停接单时不会自动分流。"}
      </p>
    </fieldset>
  );
}
