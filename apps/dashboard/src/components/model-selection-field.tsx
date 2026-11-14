export interface ShadowModelChoice {revisionId:string;label:string;validated:boolean}

export function ModelSelectionField({value,choices,activeLabel,disabled,onChange}:{
  value:string;choices:ShadowModelChoice[];activeLabel:string|null;disabled:boolean;onChange:(value:string)=>void;
}) {
  return <div className="space-y-3">
    <label className="block space-y-2 text-sm">
      <span>模型选择</span>
      <select aria-label="分身模型" className="block h-9 w-full rounded-md border bg-background px-3" value={value} disabled={disabled}
        onChange={event=>onChange(event.target.value)}>
        <option value="inherit">跟随当前激活配置{activeLabel ? ` · ${activeLabel}` : ""}</option>
        {choices.map(choice=><option key={choice.revisionId} value={choice.revisionId} disabled={!choice.validated}>
          {choice.label}{choice.validated ? "" : " · 未通过连接验证"}
        </option>)}
      </select>
    </label>
    <p className="text-xs leading-5 text-muted-foreground">{value==="inherit"
      ? "使用此 Agent 当前激活的模型配置。切换激活配置后，分身在下次执行时跟随切换。"
      : "固定使用所选模型配置，不随激活配置变化。从下次会话或任务执行生效；配置修改后，可重新选择并保存。"}</p>
  </div>;
}
