import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccountLinks, type AccountLinkPreview } from "@/lib/api";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The owner links their chat identity to their account in this Agent: send
 * `#link` to a Shadow bot in a direct chat, paste the token here, check whose
 * identity it is, then confirm.
 */
export function AccountLinks({ agentId }: { readonly agentId: string }) {
  const links = useAccountLinks(agentId);
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<AccountLinkPreview | null>(null);
  const error = links.preview.error ?? links.link.error ?? links.unlink.error ?? links.list.error;
  const reset = () => { setToken(""); setPreview(null); links.preview.reset(); links.link.reset(); };

  return (
    <section className="space-y-3 border-b px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">我的聊天身份</h2>
        <span className="text-xs text-muted-foreground">
          在飞书里私聊本 Agent 的任一分身机器人发送 <code>#link</code>，把收到的令牌粘贴到这里。绑定后，你在飞书里的消息按所有者处理。
        </span>
      </div>
      {links.list.data && links.list.data.length > 0 ? (
        <ul className="space-y-1">
          {links.list.data.map(link => (
            <li key={link.channelIdentityId} className="flex items-center gap-2">
              <span className="truncate">{link.displayName ?? link.channelIdentityId}</span>
              <span className="text-xs text-muted-foreground">{link.channelName}</span>
              <Button variant="ghost" size="sm" className="ml-auto" disabled={links.unlink.isPending}
                onClick={() => { if (window.confirm("解绑这个聊天身份？之后它的消息不再按所有者处理。")) links.unlink.mutate(link.channelIdentityId); }}>
                解绑
              </Button>
            </li>
          ))}
        </ul>
      ) : links.list.isLoading ? null : <p className="text-xs text-muted-foreground">还没有绑定聊天身份。</p>}
      {preview ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
          {preview.avatarUrl ? <img alt="" src={preview.avatarUrl} className="size-6 rounded-full" /> : null}
          <span>将绑定 <strong>{preview.displayName}</strong></span>
          <span className="text-xs text-muted-foreground">{preview.channelName}{preview.shadowName ? ` · ${preview.shadowName}` : ""}</span>
          <span className="text-xs text-muted-foreground">请确认这是你自己。</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" disabled={links.link.isPending} onClick={reset}>取消</Button>
            <Button size="sm" disabled={links.link.isPending} onClick={() => links.link.mutate(token.trim(), { onSuccess: reset })}>确认绑定</Button>
          </div>
        </div>
      ) : (
        <form className="flex gap-2" onSubmit={event => {
          event.preventDefault();
          if (token.trim()) links.preview.mutate(token.trim(), { onSuccess: setPreview });
        }}>
          <Input value={token} onChange={event => setToken(event.target.value)} placeholder="粘贴 #link 返回的令牌" className="h-8 max-w-sm" />
          <Button size="sm" type="submit" disabled={!token.trim() || links.preview.isPending}>查看</Button>
        </form>
      )}
      {error ? <p role="alert" className="text-xs text-destructive">{errorText(error)}</p> : null}
    </section>
  );
}
