import type {NativeProgressEntry} from "@/channels/outbound";

export interface ProgressEntry {
  id: string;
  kind: "text" | "tool" | "state";
  text: string;
  createdAt: number;
  updatedAt: number;
  toolName?: string;
  nativeCallId?: string;
  status?: "running" | "ended" | "failed" | "interrupted";
  finishedAt?: number | null;
}
export interface ProgressUpdate {
  streamKey: string;
  mode: "delta" | "snapshot";
  position: number;
  entries: readonly ProgressEntry[];
}

export function progressEntry(row: {id?: string;type:string;summary:string;created_at?:number;updated_at?:number;data?:unknown}): ProgressEntry {
  let data:any=row.data;
  for(let i=0;i<2&&typeof data==="string";i++) {try {data=JSON.parse(data);}catch {data={};}}
  if(!data||typeof data!=="object")data={};
  const createdAt=row.created_at ?? data.startedAt ?? 0;
  const updatedAt=row.updated_at || data.updatedAt || createdAt;
  return {id:row.id!,kind:row.type==="runner.tool"||data.toolPhase?"tool":row.type==="runner.step"&&!row.summary.startsWith("工具进度：")?"text":"state",
    text:row.summary,createdAt,updatedAt,...(row.type==="runner.tool"||data.toolPhase?{toolName:data.toolName,nativeCallId:data.nativeCallId ?? data.toolCallId ?? row.id,
      status:data.status ?? (data.toolPhase==="result"?(row.summary==="工具执行失败"?"failed":"ended"):"running"),finishedAt:data.finishedAt ?? null}: {})};
}

export function nativeEntries(update: ProgressUpdate): NativeProgressEntry[] {
  return update.entries.flatMap(entry=>{
    if(entry.kind==="state")return [];
    if(entry.kind==="text")return [{id:entry.id,text:entry.text}];
    const callId=entry.nativeCallId ?? entry.id;
    const start:NativeProgressEntry={id:`${callId}:start`,toolCallId:callId,toolName:entry.toolName ?? "tool",toolTitle:entry.text,text:entry.text,toolPhase:"start"};
    return entry.status==="running"?[start]:[start,{...start,id:`${callId}:result`,toolPhase:"result",
      toolOutcome:entry.status ?? "ended",text:entry.status==="failed"?"工具执行失败":entry.status==="interrupted"?"未确认工具结果":"工具调用已结束"}];
  });
}

export function projection(previous: readonly ProgressEntry[],update:ProgressUpdate,limit:number): ProgressEntry[] {
  const entries=new Map((update.mode==="snapshot"?[]:previous).map(e=>[e.id,e]));
  const oldest=previous[0]?.createdAt;
  for(const entry of update.entries) {
    const old=entries.get(entry.id);
    if(old&&(entry.updatedAt<old.updatedAt||(old.kind==="tool"&&old.status!=="running"&&entry.status==="running")))continue;
    if(!old&&update.mode==="delta"&&entry.kind==="tool"&&entry.status!=="running"&&previous.length>=limit&&oldest!==undefined&&entry.createdAt<oldest)continue;
    entries.set(entry.id,old?{...entry,createdAt:old.createdAt}:entry);
  }
  return [...entries.values()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)).slice(-limit);
}
