import {expect,test} from "bun:test";
import {OrdinaryProgress} from "../../extensions/channels/feishu/messaging/ordinary-progress";
import {nativeEntries, type ProgressEntry} from "@/messaging/notifications/progress-update";
const tool:ProgressEntry={id:"tool",kind:"tool",text:"执行测试",toolName:"Bash",status:"running",createdAt:1,updatedAt:1};
const text:ProgressEntry={id:"text",kind:"text",text:"正在分析",createdAt:2,updatedAt:2};
const operation={replyMode:"update_status_card" as const,targetMessageId:"om",statusCardStyle:"card" as const,statusCardState:"active" as const,content:""};
const update=(position:number,entries:ProgressEntry[],mode:"delta"|"snapshot"="delta")=>({...operation,progressUpdate:{streamKey:"task:run",position,entries,mode}});
test("ordinary adapter accumulates only deltas, updates tool in place and clips locally",()=>{
  const adapter=new OrdinaryProgress(undefined,"channel");
  adapter.prepare(update(1,[tool],"snapshot"),2);
  expect(adapter.prepare(update(2,[text]),2).statusCardSteps).toEqual(["执行测试","正在分析"]);
  expect(adapter.prepare(update(3,[{...tool,status:"ended",updatedAt:3}]),2).statusCardSteps).toEqual(["执行测试（已结束）","正在分析"]);
  adapter.prepare(update(4,[{...text,id:"later",createdAt:4,updatedAt:4,text:"分析完成"}]),2);
  expect(adapter.prepare(update(5,[{...tool,status:"ended",updatedAt:5}]),2).statusCardSteps).toEqual(["正在分析","分析完成"]);
  expect(adapter.prepare(update(1,[tool],"snapshot"),2).statusCardSteps).toEqual(["正在分析","分析完成"]);
});
test("adapter restart recovers full projection from the existing delivery receipt",()=>{
  const initial=new OrdinaryProgress(undefined,"channel").prepare(update(2,[tool,text],"snapshot"),32);
  const db={select:()=>({from:()=>({where:()=>({orderBy:()=>({limit:()=>({get:()=>({receipt:{id:"om",progressSnapshot:initial.progressSnapshot}})})})})})})};
  const recovered=new OrdinaryProgress(db as any,"channel");
  expect(recovered.prepare(update(3,[{...tool,status:"failed",updatedAt:3}]),32).statusCardSteps).toEqual(["执行测试（失败）","正在分析"]);
  recovered.prepare({...update(4,[]),statusCardState:"terminal"},32);
  expect(()=>recovered.prepare(update(5,[text]),32)).toThrow("already terminal");
});
test("Native gets stable individual start/result IDs from the same envelope",()=>{
  const entries=nativeEntries(update(3,[{...tool,status:"interrupted",updatedAt:3}]).progressUpdate);
  expect(entries.map(e=>e.id)).toEqual(["tool:start","tool:result"]);
  expect(entries[1]).toMatchObject({toolPhase:"result",toolOutcome:"interrupted",text:"未确认工具结果"});
});
