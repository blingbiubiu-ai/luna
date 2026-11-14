import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CreateNameForm({ label, action, onCreate }: {
  label: string;
  action: string;
  onCreate: (name: string, key: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const request = useRef<{ name: string; key: string } | null>(null);
  const create = useMutation({
    mutationFn: ({ name, key }: { name: string; key: string }) => onCreate(name, key),
    onSuccess: () => {
      request.current = null;
      setName("");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value || create.isPending) return;
    if (request.current?.name !== value) {
      request.current = { name: value, key: crypto.getRandomValues(new Uint32Array(4)).join("-") };
    }
    create.mutate(request.current);
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-52 flex-1 space-y-1 text-sm">
          {label}
          <Input value={name} onChange={event => { setName(event.target.value); create.reset(); }}
            maxLength={100} disabled={create.isPending} required />
        </label>
        <Button type="submit" disabled={!name.trim() || create.isPending}>{create.isPending ? "正在创建…" : action}</Button>
      </div>
      {create.error && <p role="alert" className="text-sm text-destructive">{create.error.message}</p>}
      {create.isSuccess && <p role="status" className="text-sm text-muted-foreground">已创建。</p>}
    </form>
  );
}
