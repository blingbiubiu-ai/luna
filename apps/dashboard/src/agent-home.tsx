import { ArrowUpRight, Bot } from "lucide-react";
import { CreateNameForm } from "@/components/create-name-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/theme-toggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDashboardAgents } from "@/lib/api";
import { apiFetch } from "@/lib/api/client";
import type { DashboardAgentChoice } from "@/lib/api/hooks";

export function AgentHome() {
  const agents = useDashboardAgents();
  const items = agents.data?.agents ?? [];

  async function createAgent(name: string, key: string) {
    const { agent } = await apiFetch<{ agent: DashboardAgentChoice }>("/agents", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ name }),
    });
    window.location.assign(`/agent/${encodeURIComponent(agent.id)}`);
  }

  return (
    <main className="luna-shell min-h-svh">
      <div className="luna-overview mx-auto flex max-w-7xl flex-col">
        <header className="flex items-center justify-between border-b pb-4">
          <span className="text-sm font-semibold tracking-tight">Luna</span>
          <div className="flex items-center gap-3">
            <TooltipProvider><ThemeToggle /></TooltipProvider>
          </div>
        </header>

        <section className="luna-hero">
          <div className="min-w-0">
            <h1 className="font-semibold tracking-tight">Luna Agents</h1>
            <p className="mt-3 text-sm text-muted-foreground">创建 Agent，或打开你拥有的 Agent 工作台。</p>
          </div>
          <Card className="w-full min-w-0 gap-4 rounded-2xl lg:w-[24rem]">
            <CardHeader>
              <CardTitle>新建 Agent</CardTitle>
            </CardHeader>
            <CardContent>
              <CreateNameForm label="Agent 名称" action="创建 Agent" onCreate={createAgent} />
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="agent-list-title" className="space-y-4">
          <h2 id="agent-list-title" className="text-lg font-semibold">我的 Agent</h2>
          {agents.isLoading && <p role="status" className="text-sm text-muted-foreground">正在加载…</p>}
          {agents.isError && (
            <p role="alert" className="rounded-xl border bg-card p-5 text-sm text-destructive">无法加载 Agent。</p>
          )}
          {agents.isSuccess && items.length === 0 && (
            <p className="rounded-xl border border-dashed bg-card p-6 text-sm text-muted-foreground">暂无 Agent。</p>
          )}
          {items.length > 0 && (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map(agent => (
                <li key={agent.id}>
                  <a className="group block h-full rounded-xl outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                    href={`/agent/${encodeURIComponent(agent.id)}`}>
                    <Card className="luna-metric h-full gap-0 py-0 transition-colors group-hover:border-primary/45 group-hover:bg-muted/30">
                      <CardContent className="flex min-h-28 items-center gap-4 p-5">
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                          <Bot className="size-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="break-words font-semibold">{agent.name}</h3>
                          {agent.status === "disabled" && <Badge className="mt-2" variant="secondary">已停用</Badge>}
                        </div>
                        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                      </CardContent>
                    </Card>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
