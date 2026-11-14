import { useState, type ComponentProps } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";

export function DeleteRecordButton({ kind, id, name, onDeleted, path, variant = "ghost", size = "sm" }: {
  kind: "users" | "sessions" | "tasks" | "schedules"; id: string; name: string; onDeleted: () => void;
  path?: string;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const label = { users: "用户", sessions: "会话", tasks: "任务", schedules: "定时任务" }[kind];
  const mutation = useMutation({
    mutationFn: () => apiFetch(path ?? `/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      setOpen(false);
      onDeleted();
      void queryClient.invalidateQueries({ queryKey: ["luna"] });
    },
  });
  return <AlertDialog open={open} onOpenChange={value => { if (!mutation.isPending) { setOpen(value); mutation.reset(); } }}>
    <AlertDialogTrigger asChild><Button variant={variant} size={size} className="text-destructive hover:text-destructive"><Trash2 className="size-4" />删除</Button></AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>删除{label}？</AlertDialogTitle>
        <AlertDialogDescription>
          {kind === "tasks"
            ? `“${name}”及其执行记录、AI 上下文和独占产物将永久删除，无法恢复。会话历史消息和被其他会话或任务引用的产物保留。`
            : kind === "schedules"
            ? `“${name}”及其执行历史将永久删除，尚未开始的执行将取消，之后不再触发。已发送的消息和已创建的独立任务保留，无法恢复此定时任务。`
            : kind === "sessions"
            ? `“${name}”及其聊天记录、AI 上下文和专属附件将永久删除，无法恢复。其他会话中的引用将显示“该消息已删除”。独立任务及飞书聊天记录不受影响。`
            : `“${name}”将从列表移除，清理身份绑定、群组关系和权限，并撤销访问令牌。历史消息保留，后续来信可重新创建用户。此操作无法在页面恢复。`}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {mutation.error ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : null}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={mutation.isPending}>取消</AlertDialogCancel>
        <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "删除中…" : "确认删除"}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
