import {toolDisplay} from "@luna/runner-protocol/tool-display";
import {summarizeCommand} from "./command-summary";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { nativeProgressDeliveries } from "@/data/schema";
import type { NormalizedInboundMessage } from "@/channels";
import type { OutboundChannelOperation, NativeProgressEntry } from "@/channels/outbound";

type Operation = Omit<OutboundChannelOperation, "id" | "channelId">;
export interface CotRequest {
  method: "POST" | "PUT";
  url: string;
  params?: Record<string, string>;
  data?: Record<string, unknown>;
}
export interface CotResponse {code?: number; msg?: string; data?: {cot_id?: string; message_id?: string}}
type Request = (request: CotRequest) => Promise<CotResponse>;
type State = typeof nativeProgressDeliveries.$inferSelect.state;
const event = (event_type: string, content: object) => ({event_type, content: JSON.stringify(content), timestamp: Date.now()});
const MAX_ENTRIES = 306;
const MAX_TOOLS_PER_GROUP = 10;
const MAX_BYTES = 256 * 1024;
const TERMINAL_RESERVE_BYTES = 4 * 1024;
const eventBytes = (events: ReturnType<typeof event>[]) => Buffer.byteLength(JSON.stringify(events));

/** A snapshot-to-append stream adapter. Checkpoints survive adapter/service restarts.
 * The provider has no documented idempotency key for create/append: an unknown
 * outcome is quarantined rather than blindly duplicating a bubble or tool call.
 */
export class NativeTaskProgress {
  constructor(private readonly db: DrizzleDB, private readonly channelId: string, private readonly request: Request) {}

  async send(inbound: NormalizedInboundMessage, operation: Operation): Promise<OutboundChannelOperation> {
    const updating = operation.replyMode === "update_status_card";
    if (!operation.idempotencyKey) throw new Error("Native progress requires an idempotency key");
    const key = JSON.stringify([this.channelId, operation.idempotencyKey]);
    let row = this.db.select().from(nativeProgressDeliveries).where(updating
      ? and(eq(nativeProgressDeliveries.channelId, this.channelId), eq(nativeProgressDeliveries.messageId, operation.targetMessageId!))
      : eq(nativeProgressDeliveries.id, key)).get();
    if (!row && updating) throw new Error("Native progress receipt unavailable; use status-card --resend");
    if (!row) {
      this.db.insert(nativeProgressDeliveries).values({id:key, channelId:this.channelId, state:{sentEntries:[],progressBudget:{entries:0,bytes:0,exhausted:false}}, updatedAt:Date.now()}).run();
      row = this.db.select().from(nativeProgressDeliveries).where(eq(nativeProgressDeliveries.id,key)).get()!;
    }
    const id = row.id;
    let state: State = row.state;
    let messageId = row.messageId;
    const save = (next: State) => {
      this.db.update(nativeProgressDeliveries).set({state:next,messageId,updatedAt:Date.now()}).where(eq(nativeProgressDeliveries.id,id)).run();
      state = next;
    };
    const call = async (request: CotRequest, complete = false) => {
      const response = await this.request(request);
      if (response.code && !(complete && /^COT already in terminal state\.?$/i.test(response.msg?.trim() ?? ""))) {
        // A provider rejection is known not to have applied this request.
        save({...state, pending:undefined});
        throw new Error(`Feishu native progress rejected (${response.code}): ${response.msg ?? "unknown error"}`);
      }
      return response;
    };
    const terminal = operation.statusCardState === "terminal";
    if (state.pending && !(terminal && messageId && state.cotId))
      throw new Error("Native progress delivery outcome is unknown; use status-card --resend with a new request id");
    if (!messageId) {
      save({...state,pending:"create"});
      const anchor = inbound.thread?.rootMessageExternalId ?? operation.targetMessageId ?? inbound.id;
      const threaded = operation.replyMode === "reply_in_thread";
      if (threaded && !anchor.startsWith("om_")) {
        save({...state,pending:undefined});
        throw new Error("Native thread progress requires a real Feishu message anchor");
      }
      const response = await call({method:"POST",url:"/open-apis/im/v1/message_cot",params:{receive_id_type:"chat_id"},data:{
        receive_id:inbound.surface.externalId,
        ...(anchor.startsWith("om_") ? {origin_message_id:anchor,...(threaded ? {reply_in_thread:true} : {})} : {}),
      }});
      if (!response.data?.cot_id || !response.data.message_id) throw new Error("Native progress create receipt is incomplete; use --resend");
      messageId = response.data.message_id;
      save({...state,cotId:response.data.cot_id,pending:undefined});
    }
    if (!state.terminal) {
      const append = async (events: ReturnType<typeof event>[], next: State) => {
        const budget = state.progressBudget ?? {entries:state.sentEntries.length,bytes:0,exhausted:false};
        next = {...next, progressBudget:{...(next.progressBudget ?? budget),bytes:budget.bytes + eventBytes(events)}};
        save({...state,pending:"append"});
        await call({method:"PUT",url:"/open-apis/im/v1/message_cot",data:{cot_id:state.cotId,message_id:messageId,events}});
        save({...next,pending:undefined});
      };
      // A terminal transition can still close a bubble whose last append was ambiguous.
      if (!state.pending) {
        if (!state.started) await append([
          event("RUN_STARTED",{threadId:operation.sessionId ?? inbound.surface.externalId,runId:id}),
          event("REASONING_START",{messageId:`reason-${messageId}`}),
        ], {...state,started:true});
        const seen = new Set(state.sentEntries);
        let draft = state;
        let batch: ReturnType<typeof event>[] = [];
        const flush = async () => {
          if (!batch.length) return;
          await append(batch,draft); batch = []; draft = state;
        };
        const queue = async (events: ReturnType<typeof event>[], next: State) => {
          const requestBytes = (items: ReturnType<typeof event>[]) => Buffer.byteLength(JSON.stringify({cot_id:state.cotId,message_id:messageId,events:items}));
          if (requestBytes(events) > 8 * 1024) throw new Error("Native progress entry exceeds request budget");
          if (batch.length && requestBytes([...batch,...events]) > 8 * 1024) await flush();
          batch.push(...events); draft = next;
        };
        const showTerminalNote = terminal && operation.statusCard?.status !== "completed";
        const entries: NativeProgressEntry[] = [
          ...(operation.nativeProgress ?? []),
          ...(showTerminalNote ? [{id: "terminal-note", text: operation.content || "本轮执行已结束。"}] : []),
        ];
        for (const entry of entries) {
          if (seen.has(entry.id)) continue;
          const nodeId = `${messageId}-${entry.id}`;
          const budget = draft.progressBudget ?? {entries:draft.sentEntries.length,bytes:0,exhausted:false};
          const closesTool = entry.toolPhase === "result" && !!draft.openTools?.[entry.toolCallId ?? entry.id];
          const addedNodes = entry.id === "terminal-note" || closesTool ? 0 : 1;
          if (entry.id !== "terminal-note" && budget.exhausted && !closesTool) continue;
          let next = {...draft, sentEntries:[...draft.sentEntries,entry.id]};
          const events: ReturnType<typeof event>[] = [];
          if (entry.toolName || entry.toolPhase === "result") {
            const callId = entry.toolCallId ?? entry.id;
            const toolNodeId = `${messageId}-tool-${callId}`;
            const tools = {...draft.openTools};
            const parent = draft.lastReasoningId ?? `reason-${messageId}`;
            const groupCount = draft.toolGroupCount ?? 0;
            if (!closesTool && groupCount >= MAX_TOOLS_PER_GROUP) {
              if (draft.toolGroupEllipsisSent) {
                seen.add(entry.id);
                continue;
              }
              const ellipsisId = `${parent}-tool-ellipsis`;
              events.push(
                event("TOOL_CALL_START", {toolCallId: ellipsisId, toolCallName: "more", title: "任务处理中", icon: "default", parentMessageId: parent}),
                event("TOOL_CALL_END", {toolCallId: ellipsisId}),
                toolResult(ellipsisId, "任务处理中"),
              );
              next = {...next, toolGroupEllipsisSent: true};
            } else {
              if (entry.toolPhase !== "result" || !tools[callId]) {
                const name = entry.toolName ?? "tool";
                events.push(event("TOOL_CALL_START", {toolCallId:toolNodeId, toolCallName:name,
                  title:nativeToolTitle(name, entry.toolTitle), icon:toolIcon(name), parentMessageId:parent}),
                  event("TOOL_CALL_END", {toolCallId:toolNodeId}));
                tools[callId] = toolNodeId;
                next = {...next, toolGroupCount: groupCount + 1};
              }
              if (entry.toolPhase === "result") {
                events.push(toolResult(toolNodeId, entry.toolOutcome === "interrupted" ? "本轮已结束，未确认工具结果" : entry.text === "工具执行失败" ? "工具执行失败" : "工具调用已结束"));
                delete tools[callId];
              }
              next = {...next, openTools:tools};
            }
          } else {
            events.push(event("REASONING_MESSAGE_START",{messageId:nodeId,role:"reasoning"}),
              event("REASONING_MESSAGE_CONTENT",{messageId:nodeId,delta:entry.text.slice(0,800)}),
              event("REASONING_MESSAGE_END",{messageId:nodeId}));
            next = {...next, lastReasoningId:nodeId, toolGroupCount: 0, toolGroupEllipsisSent: false};
          }
          if (entry.id !== "terminal-note" && ((addedNodes > 0 && budget.entries >= MAX_ENTRIES - 6) || budget.bytes + eventBytes(events) > MAX_BYTES - TERMINAL_RESERVE_BYTES)) {
            if (budget.exhausted) continue;
            const noticeId = `${messageId}-progress-limit`;
            const notice = [event("REASONING_MESSAGE_START",{messageId:noticeId,role:"reasoning"}),
              event("REASONING_MESSAGE_CONTENT",{messageId:noticeId,delta:"进度已达到展示上限，后续仅汇报最终状态。可在 Dashboard 查看完整工具进度和结果。"}),
              event("REASONING_MESSAGE_END",{messageId:noticeId})];
            await queue(notice,{...draft,lastReasoningId:noticeId,sentEntries:[...draft.sentEntries,"progress-limit"],
              progressBudget:{...budget,bytes:budget.bytes+eventBytes(notice),exhausted:true}});
            seen.add("progress-limit");
            continue;
          }
          next = {...next,progressBudget:{...budget,entries:budget.entries+addedNodes,bytes:budget.bytes+eventBytes(events)}};
          await queue(events,next);
          seen.add(entry.id);
        }
        await flush();
      }
      if (terminal) {
        if (!state.pending && !state.ended) {
          // Close unfinished nodes honestly; a missing result does not imply success.
          for (const [callId, toolNodeId] of Object.entries(state.openTools ?? {})) {
            const remaining = {...state.openTools}; delete remaining[callId];
            const events = [toolResult(toolNodeId, "本轮已结束，未收到工具结果")];
            if ((state.progressBudget?.bytes ?? 0) + eventBytes(events) > MAX_BYTES - 512) break;
            await append(events, {...state, openTools:remaining});
          }
          const done = operation.statusCard?.status === "completed" || operation.statusCard?.status === "waiting";
          await append([
            event("REASONING_END", {messageId:state.lastReasoningId ?? `reason-${messageId}`}),
            ...(done ? [event("RUN_FINISHED", {threadId:operation.sessionId ?? inbound.surface.externalId,runId:id,status:"done"})] : []),
          ], {...state, openTools:{}, ended:true, ...(done ? {terminal:true} : {})});
        }
        if (!state.terminal) await call({method:"POST",url:`/open-apis/im/v1/message_cot/complete/${encodeURIComponent(state.cotId!)}`,
          params:{message_id:messageId,reason:operation.statusCard?.status === "completed" || operation.statusCard?.status === "waiting" ? "done" : "error"}},true);
        save({...state,terminal:true,pending:undefined});
      }
    }
    const root = inbound.thread?.rootMessageExternalId;
    return {...operation,id:messageId,channelId:this.channelId,
      ...(root ? {threadId:root,rootMessageId:root} : {})};
  }
}

function nativeToolTitle(name: string, rawTitle?: string): string {
  const title = rawTitle ?? toolLabel(name);
  if (toolIcon(name) === "bash" && title.startsWith("执行 ") && title !== "执行命令") {
    return summarizeCommand(title.slice(3));
  }
  return title;
}
function toolIcon(name: string): string { return toolDisplay(name).icon; }
function toolLabel(name: string): string { return toolDisplay(name).label; }
function toolResult(id: string, text: string) {
  return event("TOOL_CALL_RESULT", {messageId:`result-${id}`,toolCallId:id,role:"tool",content:JSON.stringify({type:"text",text})});
}
