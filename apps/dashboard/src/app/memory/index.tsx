import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { useRouteAgent } from "@/lib/agent-route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAgentMemory, useShadowPersona } from "@/lib/api";

export const Route = createFileRoute("/$agentId/memory/")({ component: MemoryPage });

function MemoryPage() {
  const [mode, setMode] = useState<"memory" | "persona">("memory");
  const selection = useShadowScope(true, mode === "persona");
  const agent = useRouteAgent();
  const shadowId = selection.scope.shadowId;
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <h1 className="text-xl font-semibold">记忆与人格</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="内容类型" className="h-9 rounded-md border bg-background px-2 text-sm"
            value={mode} onChange={event => setMode(event.target.value === "persona" ? "persona" : "memory")}>
            <option value="memory">共享记忆</option>
            <option value="persona">分身人格</option>
          </select>
          {mode === "persona" && <ShadowPicker selection={selection} />}
        </div>
      </header>
      {selection.error && <p role="alert" className="px-5 py-3 text-destructive">{selection.error.message}</p>}
      {mode === "memory" && <MemoryEditor key={agent.id} agentId={agent.id} />}
      {mode === "persona" && shadowId && <PersonaEditor key={`${agent.id}:${shadowId}`} agentId={agent.id} shadowId={shadowId} />}
    </main>
  );
}

function MemoryEditor({ agentId }: { agentId: string }) {
  const { snapshot, update } = useAgentMemory(agentId);
  const [selection, setSelection] = useState<string>();
  const [draft, setDraft] = useState<{ content: string; revision: string | null }>();
  const [newPath, setNewPath] = useState("");
  const files = Object.keys(snapshot.data?.files ?? {});
  const path = selection ?? files[0];
  const current = path ? snapshot.data?.files[path] ?? "" : "";
  const error = snapshot.error ?? update.error;
  function edit(content: string) {
    if (!snapshot.data) return;
    setDraft(draft => ({ content, revision: draft ? draft.revision : snapshot.data!.revision }));
  }

  return (
    <section className="grid min-h-0 flex-1 gap-4 p-5 md:grid-cols-[16rem_1fr]">
      <aside className="space-y-3 rounded-md border p-3">
        <label className="block text-sm" htmlFor="memory-path">记忆文件</label>
        <select id="memory-path" className="w-full rounded-md border bg-background p-2 text-sm"
          value={path ?? ""} disabled={update.isPending} onChange={event => { setSelection(event.target.value); setDraft(undefined); update.reset(); }}>
          {!path && <option value="">暂无文件</option>}
          {path && !files.includes(path) && <option value={path}>{path}</option>}
          {files.map(file => <option key={file} value={file}>{file}</option>)}
        </select>
        <Input aria-label="新文件路径" placeholder="notes/example.md" value={newPath} onChange={event => setNewPath(event.target.value)} />
        <Button type="button" variant="outline" disabled={!snapshot.data || !newPath.trim() || update.isPending}
          onClick={() => { setSelection(newPath.trim()); setNewPath(""); setDraft(undefined); update.reset(); }}>
          新建记忆文件
        </Button>
      </aside>
      <article className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
        {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
        <Textarea aria-label="记忆正文" value={draft?.content ?? current} disabled={!path || !snapshot.data || update.isPending}
          className="min-h-64 flex-1 font-mono" onChange={event => edit(event.target.value)} />
        <div className="flex justify-end gap-2">
          {draft && <Button type="button" variant="outline" disabled={update.isPending} onClick={() => {
            setDraft(undefined);
            update.reset();
            void snapshot.refetch();
          }}>放弃修改</Button>}
          <Button type="button" disabled={!path || !draft || update.isPending} onClick={() => {
            if (path && draft) update.mutate({ path, content: draft.content, expectedRevision: draft.revision }, { onSuccess: () => setDraft(undefined) });
          }}>保存</Button>
        </div>
      </article>
    </section>
  );
}

function PersonaEditor({ agentId, shadowId }: { agentId: string; shadowId: string }) {
  const { snapshot, update } = useShadowPersona(agentId, shadowId);
  const [draft, setDraft] = useState<{ user: string; soul: string; expectedRevision: string }>();
  const current = { user: snapshot.data?.files["USER.md"] ?? "", soul: snapshot.data?.files["SOUL.md"] ?? "" };
  const error = snapshot.error ?? update.error;
  function edit(field: "user" | "soul", value: string) {
    const expectedRevision = snapshot.data?.revision;
    if (expectedRevision) setDraft(previous => ({ ...(previous ?? { ...current, expectedRevision }), [field]: value }));
  }
  return (
    <section className="grid gap-4 p-5">
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <label className="grid gap-2 text-sm">USER.md
        <Textarea className="min-h-32 font-mono" disabled={!snapshot.data || update.isPending}
          value={draft?.user ?? current.user} onChange={event => edit("user", event.target.value)} />
      </label>
      <label className="grid gap-2 text-sm">SOUL.md
        <Textarea className="min-h-32 font-mono" disabled={!snapshot.data || update.isPending}
          value={draft?.soul ?? current.soul} onChange={event => edit("soul", event.target.value)} />
      </label>
      <div className="flex justify-end gap-2">
        {draft && <Button type="button" variant="outline" disabled={update.isPending} onClick={() => {
          setDraft(undefined);
          update.reset();
          void snapshot.refetch();
        }}>放弃修改</Button>}
        <Button type="button" disabled={!draft || update.isPending} onClick={() => {
          if (draft) update.mutate(draft, { onSuccess: () => setDraft(undefined) });
        }}>保存</Button>
      </div>
    </section>
  );
}
