import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { useDashboardAgents } from "@/lib/api";
import { useAcceptLineageInvite, useLineageInvitePreview } from "@/lib/api/lineage";
import { appHistory } from "@/lib/app-history";

export function LineageInvitePage({ token }: { readonly token: string }) {
  const preview = useLineageInvitePreview(token);
  const agents = useDashboardAgents();
  const accept = useAcceptLineageInvite(token);
  const [mode, setMode] = useState<"create_agent" | "attach_agent">("create_agent");
  const [agentName, setAgentName] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");

  if (preview.isPending) {
    return <div className="p-8 text-sm text-muted-foreground">正在校验传承邀请…</div>;
  }

  if (preview.isError || !preview.data?.invite) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <div className="space-y-2 rounded-2xl border border-destructive/30 bg-card p-6">
          <h1 className="text-base font-semibold">邀请链接无效或已过期</h1>
          <p className="text-xs text-muted-foreground">请联系传承方重新生成有效的邀请链接。</p>
        </div>
      </div>
    );
  }

  const { invite } = preview.data;
  const userAgents = agents.data?.agents ?? [];
  const resolvedAgentId = selectedAgentId || userAgents[0]?.id || "";

  const handleAccept = () => {
    const payload =
      mode === "create_agent"
        ? { mode: "create_agent" as const, agentName: agentName.trim() || `${invite.lineage.name}助手` }
        : { mode: "attach_agent" as const, agentId: resolvedAgentId };
    accept.mutate(payload, {
      onSuccess: res => {
        appHistory.push(`/agent/${encodeURIComponent(res.agentId)}/memory`);
      },
    });
  };

  return (
    <main className="mx-auto w-full max-w-xl p-6">
      <div className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-xs">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="size-4 text-primary" />
            <span>传承记忆邀请</span>
            {invite.requireApproval && <Badge variant="outline">需审批加入</Badge>}
          </div>
          <h1 className="text-xl font-semibold">{invite.lineage.name}</h1>
          {invite.lineage.description && <p className="text-xs text-muted-foreground">{invite.lineage.description}</p>}
          <div className="flex flex-wrap gap-3 pt-1 text-xs text-muted-foreground">
            <span>来源 Agent：{invite.lineage.sourceAgentName}</span>
            <span>·</span>
            <span>传承条目：{invite.lineage.memoryCount} 条</span>
            <span>·</span>
            <span>成员 Agent：{invite.lineage.memberCount} 个</span>
          </div>
          {invite.lineage.intakeGuidelines && (
            <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              <strong className="text-foreground">收录范围：</strong>
              {invite.lineage.intakeGuidelines}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "create_agent" ? "default" : "outline"}
            onClick={() => setMode("create_agent")}
          >
            创建新 Agent 并接收传承
          </Button>
          {userAgents.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant={mode === "attach_agent" ? "default" : "outline"}
              onClick={() => setMode("attach_agent")}
            >
              挂载到已有 Agent
            </Button>
          )}
        </div>

        {mode === "create_agent" ? (
          <div className="space-y-2">
            <label className="text-xs font-medium">为你的新 Agent 命名</label>
            <Input
              placeholder={invite.lineage.template.defaultAgentNamePrefix || `${invite.lineage.name}助手`}
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              className="h-9 text-xs"
            />
          </div>
        ) : (
          <div className="space-y-2">
            <label className="text-xs font-medium">选择要挂载的已有 Agent</label>
            <SelectField
              aria-label="选择要挂载的已有 Agent"
              fullWidth
              value={resolvedAgentId}
              onValueChange={setSelectedAgentId}
              options={userAgents.map(a => ({ value: a.id, label: a.name }))}
            />
          </div>
        )}

        {accept.isError && (
          <p className="text-xs text-destructive">{accept.error instanceof Error ? accept.error.message : "接收传承失败"}</p>
        )}

        <Button
          type="button"
          className="w-full"
          disabled={accept.isPending || (mode === "attach_agent" && !resolvedAgentId)}
          onClick={handleAccept}
        >
          {accept.isPending ? "正在接入传承…" : "接收传承"}
        </Button>
      </div>
    </main>
  );
}
