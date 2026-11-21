import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DataConnection} from "../../src/data";
import * as schema from "../../src/data/schema";
import {setLunaHome} from "../../src/shared";
import {NativeTaskProgress, type CotRequest} from "../../extensions/channels/feishu/messaging/native-task-progress";
import {nativeProgressEntries} from "../../src/messaging/notifications/feishu-task-updater";
import type {NormalizedInboundMessage} from "../../src/channels";
import type {OutboundChannelOperation} from "../../src/channels/outbound";
let home: string;
let connection: DataConnection<typeof schema>;
let calls: CotRequest[];
beforeEach(() => {home=mkdtempSync(join(tmpdir(),"native-progress-"));setLunaHome(home);connection=new DataConnection(schema);calls=[];});
afterEach(() => {connection.close();rmSync(home,{recursive:true,force:true});});
const inbound: NormalizedInboundMessage = {id:"om_anchor",channel:{type:"feishu",id:"test"},surface:{externalId:"oc_chat",kind:"group"},thread:{externalId:"om_anchor",rootMessageExternalId:"om_anchor"},sender:{externalId:"user",kind:"user"},text:"",mentions:[],addressing:{addressedToBot:true,reason:"p2p"}};
const operation: Omit<OutboundChannelOperation,"id"|"channelId"> = {replyMode:"reply_in_thread",sessionId:"session",targetMessageId:"om_anchor",idempotencyKey:"create",statusCardStyle:"native",statusCardState:"active",statusCard:{taskId:"task",title:"调查问题",status:"running"},nativeProgress:[{id:"one",text:"查看代码"},{id:"tool",text:"调用工具",toolName:"Read"}],content:""};
const request = async (req: CotRequest) => {calls.push(req);return {code:0,data:{cot_id:"cot",message_id:"om_progress"}};};
const adapter = () => new NativeTaskProgress(connection.db,"test",request);
const events = () => calls.flatMap(call => (call.data?.events ?? []) as {event_type:string;content:string}[]);
test("large Native histories are batched and bounded while terminal delivery retains room", async () => {
  const entries = Array.from({length: 1_000}, (_, i) => ({id:`large-${i}`,text:`步骤 ${i}：${"正文".repeat(200)}`}));
  await adapter().send(inbound,{...operation,nativeProgress:entries});
  const before = calls.length;
  expect(events().filter(e => e.content.includes("详细进度已合并"))).toHaveLength(1);
  const visible = events().filter(e => e.event_type === "REASONING_MESSAGE_CONTENT").length;
  expect(visible).toBeGreaterThan(94);
  expect(visible).toBeLessThan(300);
  for (const req of calls.filter(c => c.method === "PUT")) expect(Buffer.byteLength(JSON.stringify(req.data))).toBeLessThanOrEqual(8 * 1024);
  await adapter().send(inbound,{...operation,replyMode:"update_status_card",targetMessageId:"om_progress",nativeProgress:entries});
  expect(calls.length).toBe(before);
  await adapter().send(inbound,{...operation,replyMode:"update_status_card",targetMessageId:"om_progress",nativeProgress:entries,
    statusCardState:"terminal",statusCard:{taskId:"task",status:"completed"},content:"最终结果正常完成"});
  expect(events().some(e => e.content.includes("最终结果正常完成"))).toBe(true);
  expect(events().filter(e => e.event_type === "RUN_FINISHED")).toHaveLength(1);
  const total = calls.filter(c => c.method === "PUT").reduce((n,c) => n + Buffer.byteLength(JSON.stringify(c.data!.events)),0);
  expect(total).toBeLessThanOrEqual(256 * 1024);
});
test("short Native progress retains 300 ordinary entries and one budget notice", async () => {
  await adapter().send(inbound,{...operation,nativeProgress:Array.from({length:400},(_,i)=>({id:`short-${i}`,text:`步骤 ${i}`}))});
  expect(events().filter(e=>e.event_type === "REASONING_MESSAGE_CONTENT")).toHaveLength(301);
  expect(events().filter(e=>e.content.includes("详细进度已合并"))).toHaveLength(1);
  const checkpoint = connection.db.select().from(schema.nativeProgressDeliveries).get()!;
  expect(checkpoint.state.progressBudget).toMatchObject({entries:300,exhausted:true});
});
test("native thread snapshots append only new public entries across adapter restart and complete once",async()=>{
  const first = await adapter().send(inbound,operation);
  expect(first).toMatchObject({id:"om_progress",threadId:"om_anchor",rootMessageId:"om_anchor"});
  expect(calls[0]?.data).toEqual({receive_id:"oc_chat",origin_message_id:"om_anchor",reply_in_thread:true});
  await adapter().send(inbound,operation);
  expect(calls.filter(c=>c.method==="POST")).toHaveLength(1);
  const update={...operation,replyMode:"update_status_card" as const,targetMessageId:first.id,idempotencyKey:"update",nativeProgress:[...operation.nativeProgress!,{id:"two",text:"找到原因"}]};
  await adapter().send(inbound,update);
  expect(events().filter(e=>e.event_type==="TOOL_CALL_START")).toHaveLength(1);
  expect(events().filter(e=>e.content.includes("找到原因"))).toHaveLength(1);
  expect(events().filter(e=>e.content.includes("调查问题"))).toHaveLength(1);
  const terminal={...update,statusCardState:"terminal" as const,statusCard:{...operation.statusCard!,status:"completed"},content:"修复完成"};
  await adapter().send(inbound,terminal);
  await adapter().send(inbound,terminal);
  expect(events().filter(e=>e.event_type==="RUN_FINISHED")).toHaveLength(1);
  expect(events().filter(e=>e.event_type==="REASONING_END")).toHaveLength(1);
  expect(calls.filter(c=>c.url.includes("/complete/"))).toHaveLength(0);
  expect(events().some(e=>e.content.includes("修复完成"))).toBe(true);
});
test("ambiguous create is quarantined across restart instead of duplicating messages",async()=>{
  let count=0;
  const lost=new NativeTaskProgress(connection.db,"test",async()=>{count++;throw Error("timeout");});
  await expect(lost.send(inbound,operation)).rejects.toThrow("timeout");
  await expect(adapter().send(inbound,operation)).rejects.toThrow("outcome is unknown");
  expect(count).toBe(1);expect(calls).toHaveLength(0);
  await adapter().send(inbound,{...operation,idempotencyKey:"replacement"});
  expect(calls[0]?.method).toBe("POST");
});
test("known provider rejection retries; ambiguous append can still close with error",async()=>{
  const rejected=new NativeTaskProgress(connection.db,"test",async()=>({code:999,msg:"denied"}));
  await expect(rejected.send(inbound,operation)).rejects.toThrow("denied");
  await adapter().send(inbound,operation);
  const update={...operation,replyMode:"update_status_card" as const,targetMessageId:"om_progress",idempotencyKey:"append",nativeProgress:[{id:"next",text:"进度"}]};
  const lost=new NativeTaskProgress(connection.db,"test",async()=>{throw Error("timeout");});
  await expect(lost.send(inbound,update)).rejects.toThrow("timeout");
  await expect(adapter().send(inbound,update)).rejects.toThrow("outcome is unknown");
  await adapter().send(inbound,{...update,statusCardState:"terminal",statusCard:{taskId:"task",status:"cancelled"}});
  expect(calls.at(-1)?.params?.reason).toBe("error");
});
test("native projection excludes historical thinking and arguments; tool IDs remain stable",()=>{
  const entries=nativeProgressEntries([
    {id:"old",type:"runner.step",summary:"private reasoning",data:{}},
    {id:"public",type:"runner.step",summary:"公开进度",data:{publicProgress:true}},
    {id:"tool-event",type:"runner.step",summary:"调用工具",data:{publicProgress:true,toolName:"Read",toolCallId:"call-1",input:{secret:"hidden"}}},
  ] as never);
  expect(entries).toEqual([{id:"public",text:"公开进度"},{id:"call-1:start",text:"调用工具",toolName:"Read",toolCallId:"call-1"}]);
});


test("tool results retain their parent across restart, are not counted twice, and failure never emits RUN_FINISHED",async()=>{
  await adapter().send(inbound,operation);
  const started=JSON.parse(events().find(e=>e.event_type==="TOOL_CALL_START")!.content);
  expect(started).toMatchObject({title:"读取文件",icon:"read"});
  expect(started.parentMessageId).toContain("one");
  const result={id:"tool:result",toolCallId:"tool",toolPhase:"result" as const,text:"工具执行失败"};
  const update={...operation,replyMode:"update_status_card" as const,targetMessageId:"om_progress",idempotencyKey:"result",nativeProgress:[...operation.nativeProgress!,result]};
  await adapter().send(inbound,update);
  await adapter().send(inbound,update);
  expect(events().filter(e=>e.event_type==="TOOL_CALL_START")).toHaveLength(1);
  const results=events().filter(e=>e.event_type==="TOOL_CALL_RESULT");
  expect(results).toHaveLength(1);
  expect(JSON.parse(results[0]!.content).toolCallId).toBe(started.toolCallId);
  expect(results[0]!.content).toContain("工具执行失败");
  await adapter().send(inbound,{...update,statusCardState:"terminal",statusCard:{taskId:"task",status:"failed"}});
  expect(events().some(e=>e.event_type==="RUN_FINISHED")).toBe(false);
  expect(calls.at(-1)?.params?.reason).toBe("error");
});
