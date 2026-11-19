import { useAgentBasePath } from "@/lib/agent-route";
import { useSession, type DashboardMemorySource } from "@/lib/api";

const when = (time: number) => new Date(time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Where a memory version was written, linking to that message in its conversation. */
export function MemorySourceLine({ agentId, source }: { agentId: string; source: DashboardMemorySource }) {
  const base = useAgentBasePath();
  const session = useSession(source.sessionId, agentId).data;
  const name = session?.displayTitle || session?.title || `会话 ${source.sessionId.slice(0, 8)}`;
  return (
    <p className="text-muted-foreground" data-testid="memory-source">
      来源：{name} · {when(source.at)} ·{" "}
      <a className="text-primary hover:underline" href={`${base}/sessions/${encodeURIComponent(source.sessionId)}?entry=${encodeURIComponent(source.entryId)}`}>
        查看原文
      </a>
    </p>
  );
}
