import {expect,test} from "bun:test";
import {LiveProgress,MAX_PENDING_PROGRESS} from "../../src/messaging/notifications/live-progress";
import {updateProgressProjection} from "../../src/messaging/notifications/feishu-task-updater";
import type {NativeProgressEntry} from "../../src/channels/outbound";
const tick = () => new Promise(resolve => setTimeout(resolve,0));

test("tools send immediately without public text, a timer, aggregation or timeline writes", async () => {
  const saved: string[] = [], native: NativeProgressEntry[][] = [];
  const progress = new LiveProgress({persist:text=>{saved.push(text);return text;},transient:e=>e.text,
    send:async(_,entries)=>{native.push([...entries]);},onError:error=>{throw error;}});
  progress.toolStart("call","Bash","检查远程编译");
  await tick();
  expect(native).toHaveLength(1);
  expect(saved).toEqual([]);
  progress.toolResult("call",false);
  progress.summary("编译通过。");
  await progress.close();
  expect(native.map(entries=>entries[0]!.id).slice(0,2)).toEqual(["call:start","call:result"]);
  expect(native.every(entries=>entries.length===1)).toBe(true);
  expect(native.at(-1)?.[0]?.text).toBe("编译通过。");
  expect(saved).toEqual(["编译通过。"]);
});

test("slow sending leaves producers unblocked and retains a bounded ordered queue", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const sent: string[] = [];
  let saved=0;
  const progress = new LiveProgress({persist:text=>{saved++;return text;},transient:e=>e.text,
    send:async entries=>{sent.push(entries[0]!);if(sent.length===1)await gate;},onError:error=>{throw error;}});
  progress.summary("first"); await tick();
  for(let i=0;i<1000;i++)progress.summary(`阶段 ${i}`);
  expect(saved).toBe(1001);expect(sent).toEqual(["first"]);
  release(); await progress.close();
  expect(sent).toHaveLength(MAX_PENDING_PROGRESS+1);
  expect(sent[1]).toBe(`阶段 ${1000-MAX_PENDING_PROGRESS}`);
  expect(sent.at(-1)).toBe("阶段 999");
  progress.summary("closed");expect(saved).toBe(1001);
});

test("many tool events produce zero business writes while explicit failure is preserved", async () => {
  const saved: string[] = [], sent: NativeProgressEntry[] = [];
  const progress = new LiveProgress({persist:text=>{saved.push(text);return text;},transient:e=>e.text,
    send:async(_,entries)=>{sent.push(...entries);},onError:error=>{throw error;}});
  for(let i=0;i<10000;i++){progress.toolStart(`call-${i}`,"Read");progress.toolResult(`call-${i}`,i===9999);}
  await progress.close();
  expect(saved).toEqual([]);
  expect(sent.length).toBeLessThanOrEqual(MAX_PENDING_PROGRESS+1);
  expect(sent.at(-1)?.text).toBe("工具执行失败");
});

test("a result replaces its in-memory tool step without duplicating the status-card projection",()=>{
  const start={id:"call:start",type:"runner.step",summary:"检查编译",data:{toolCallId:"call"}};
  const result={...start,id:"call:result"};
  expect(updateProgressProjection([start],[result])).toEqual([result]);
});
