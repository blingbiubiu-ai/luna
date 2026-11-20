import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";

interface Source {
  url: string; branch: string; status: "initializing" | "syncing" | "ready" | "error";
  initialized: boolean; commit: string | null; updatedAt: number; error: string | null;
}
const statusText = { initializing: "正在初始化…", syncing: "正在同步…", ready: "已就绪", error: "操作失败" };

export function KnowledgeSourceSettings({ agentId }: { agentId: string }) {
  const client = useQueryClient();
  const path = `/agents/${encodeURIComponent(agentId)}/knowledge/source`;
  const query = useQuery({
    queryKey: [path], queryFn: ({ signal }) => apiFetch<{ source: Source | null }>(path, { signal }),
    refetchInterval: query => ["initializing", "syncing"].includes(query.state.data?.source?.status ?? "") ? 1000 : false,
  });
  const source = query.data?.source;
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { setUrl(source?.url ?? ""); setBranch(source?.branch ?? ""); }, [source?.url, source?.branch]);
  useEffect(() => {
    if (source?.status === "ready") void client.invalidateQueries({ predicate: query => query.queryKey.includes(agentId) && query.queryKey[0] !== path });
  }, [source?.status, source?.updatedAt, agentId, client, path]);
  const save = useMutation({
    mutationFn: (sync: boolean) => apiFetch<{ source: Source }>(sync ? `${path}/sync` : path, {
      method: sync ? "POST" : "PUT", ...(!sync ? { body: JSON.stringify({ url, branch }) } : {}),
    }),
    onSuccess: data => { client.setQueryData([path], data); },
  });
  const busy = save.isPending || source?.status === "initializing" || source?.status === "syncing";
  const locked = busy || !!source?.initialized;
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-labelledby="knowledge-source-title">
      <div>
        <h2 id="knowledge-source-title" className="font-medium">知识库</h2>
        <p className="text-sm text-muted-foreground">填写 Git 地址，保存后自动初始化。仓库根目录应包含 wiki、notes、archive 或 policies 文件夹。</p>
      </div>
      {query.isLoading && <p role="status" className="text-sm">正在加载知识库配置…</p>}
      {query.error && <p role="alert" className="text-sm text-destructive">无法加载知识库配置：{query.error.message}</p>}
      {query.data && <form className="space-y-3" onSubmit={event => { event.preventDefault(); save.mutate(false); }}>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Git 仓库地址</span>
          <Input aria-label="知识库 Git 仓库地址" placeholder="git@example.com:team/knowledge.git" value={url} disabled={locked} onChange={event => setUrl(event.target.value)} autoComplete="off" />
        </label>
        <p className="text-xs text-muted-foreground">支持 HTTPS / SSH。私有仓库需要 Service 账户已具备访问权限，地址中不要填写密码或令牌。</p>
        <button type="button" className="text-xs text-muted-foreground underline underline-offset-4" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>可选分支{advanced ? "（收起）" : "（展开）"}</button>
        {advanced && <label className="block space-y-1 text-sm">
          <span>分支</span>
          <Input aria-label="知识库分支" placeholder="留空使用远端默认分支" value={branch} disabled={locked} onChange={event => setBranch(event.target.value)} />
        </label>}
        <div className="flex flex-wrap items-center gap-3">
          <button className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50" type={source?.initialized ? "button" : "submit"} disabled={busy || !url.trim()} onClick={() => { if (source?.initialized) save.mutate(true); }}>
            {busy ? "处理中…" : source?.initialized ? "同步远端" : source?.status === "error" ? "保存并重试" : "保存并初始化"}
          </button>
          <a className="text-sm underline underline-offset-4" href={`/agent/${encodeURIComponent(agentId)}/knowledge`}>查看知识库</a>
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground">{source ? statusText[source.status] : "尚未配置 Git 来源"}</span>
        </div>
        {source?.initialized && <p className="text-xs text-muted-foreground">已绑定此仓库，分支：{source.branch}。同步不会覆盖未提交修改。</p>}
        {source?.commit && <p className="text-xs text-muted-foreground">最近同步提交：<code>{source.commit.slice(0, 12)}</code> · {new Date(source.updatedAt).toLocaleString()}</p>}
        {(save.error || source?.error) && <p role="alert" className="text-sm text-destructive">{save.error?.message ?? source?.error}</p>}
      </form>}
    </section>
  );
}
