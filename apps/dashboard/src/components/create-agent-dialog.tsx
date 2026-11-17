import { CreateNameForm } from "@/components/create-name-form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api/client";
import type { DashboardAgentChoice } from "@/lib/api/hooks";

/** Creates an Agent and opens its workspace. */
export function CreateAgentDialog({ open, onOpenChange }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  async function createAgent(name: string, key: string) {
    const { agent } = await apiFetch<{ agent: DashboardAgentChoice }>("/agents", {
      method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ name }),
    });
    window.location.assign(`/agent/${encodeURIComponent(agent.id)}`);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>新建 Agent</DialogTitle></DialogHeader>
        <CreateNameForm label="Agent 名称" action="创建 Agent" onCreate={createAgent} />
      </DialogContent>
    </Dialog>
  );
}
