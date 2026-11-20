import { SelectField } from "@/components/ui/select-field";

export interface ShadowModelChoice {
  revisionId: string;
  label: string;
  validated: boolean;
}

export function ModelSelectionField({
  value,
  choices,
  activeLabel,
  disabled,
  onChange,
}: {
  value: string;
  choices: ShadowModelChoice[];
  activeLabel: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-2 text-sm">
        <span>模型选择</span>
        <SelectField
          aria-label="分身模型"
          value={value}
          disabled={disabled}
          fullWidth
          onValueChange={onChange}
          options={[
            {
              value: "inherit",
              label: `跟随当前激活配置${activeLabel ? ` · ${activeLabel}` : ""}`,
            },
            ...choices.map((choice) => ({
              value: choice.revisionId,
              label: `${choice.label}${choice.validated ? "" : " · 未通过连接验证"}`,
              disabled: !choice.validated,
            })),
          ]}
        />
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        {value === "inherit"
          ? "使用此 Agent 当前激活的模型配置。切换激活配置后，分身在下次执行时跟随切换。"
          : "固定使用所选模型配置，不随激活配置变化。从下次会话或任务执行生效；配置修改后，可重新选择并保存。"}
      </p>
    </div>
  );
}
