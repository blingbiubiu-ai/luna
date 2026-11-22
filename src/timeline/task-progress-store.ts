import {createHash} from "node:crypto";
import {and,desc,eq,inArray,isNull,lt,or,sql} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {tasks,taskRuns,timelineEvents,runnerJobs,runnerInvocations} from "@/data/schema";
import {ExecutorEvent,type RuntimeEvent} from "@luna/runner-protocol";
import {normalizeRunnerProgressStep} from "@/runners/runner-progress-step";
import {progressEntry,type ProgressUpdate} from "@/messaging/notifications/progress-update";
import {GatewayError} from "@/server/gateway-error";

type Job=typeof runnerJobs.$inferSelect;
const types=["runner.step","runner.tool","runner.started","runner.failed","runner.cancelled","runner.report_submitted","context.updated","task.created"];
export const runPredicate=(id:string)=>or(eq(timelineEvents.task_run_id,id),and(isNull(timelineEvents.task_run_id),sql`json_extract(CASE WHEN json_valid(${timelineEvents.data}) THEN CASE WHEN json_type(${timelineEvents.data})='text' AND json_valid(json_extract(${timelineEvents.data},'$')) THEN json_extract(${timelineEvents.data},'$') ELSE ${timelineEvents.data} END ELSE '{}' END,'$.taskRunId')=${id}`));
const toolId=(jobId:string,attempt:number,callId:string)=>`tool-${createHash("sha256").update(JSON.stringify([jobId,attempt,callId])).digest("hex")}`;

export class TaskProgressStore {
  constructor(private readonly db:DrizzleDB) {}

  /** Called inside InvocationStore.consume's cursor transaction, never after publication. */
  consume(job:Job,event:RuntimeEvent,attempt:number):void {
    if(job.request.runnerKind!=="task"||!job.request.taskId||!job.request.taskRunId||event.kind!=="execution")return;
    const inv=this.db.select().from(runnerInvocations).where(eq(runnerInvocations.id,job.invocationId)).get();
    const run=this.db.select().from(taskRuns).where(eq(taskRuns.id,job.request.taskRunId)).get();
    if(inv?.state!=="active"||run?.status!=="running")return;
    const e=ExecutorEvent.parse((event.data as {event:unknown}).event);
    const last=this.db.select({n:timelineEvents.updated_at}).from(timelineEvents).where(and(eq(timelineEvents.task_id,run.task_id),eq(timelineEvents.task_run_id,run.id))).orderBy(desc(timelineEvents.updated_at)).limit(1).get()?.n ?? 0;
    const now=Math.max(Date.now(),last+1);
    if(e.kind==="terminal") {this.interrupt(run.id,now);return;}
    if(e.kind!=="provider")return;
    const output=e.data;
    const base={taskRunId:run.id,runIndex:run.run_index,runReason:run.reason,runnerType:job.request.input.runnerType,jobId:job.id,attempt,publicProgress:true,sourceSeq:event.seq};
    if(output.status==="stream") {
      const summary=normalizeRunnerProgressStep(output.text);
      if(!summary||summary==="LUNA_NOTHING_TO_SEND")return;
      this.db.insert(timelineEvents).values({id:`text-${job.id}-${event.seq}`,task_id:run.task_id,task_run_id:run.id,type:"runner.step",summary,
        data:{...base,text:output.text,nativeText:summary},visibility:"full",created_at:now,updated_at:now}).onConflictDoNothing().run();
      return;
    }
    if(output.status!=="tool_start"&&output.status!=="tool_result")return;
    const id=toolId(job.id,attempt,output.id);
    const previous=this.db.select().from(timelineEvents).where(eq(timelineEvents.id,id)).get();
    const data=(previous?.data ?? {}) as Record<string,unknown>;
    if(output.status==="tool_start") {
      this.db.insert(timelineEvents).values({id,task_id:run.task_id,task_run_id:run.id,type:"runner.tool",summary:output.title.slice(0,120)||output.name,
        data:{...base,toolCallId:output.id,nativeCallId:id,toolName:output.name.slice(0,80),status:"running",startedAt:now,finishedAt:null},
        visibility:"full",created_at:now,updated_at:now}).onConflictDoNothing().run();
    } else {
      const next={...base,...data,sourceSeq:event.seq,status:output.text==="工具执行失败"?"failed":"ended",finishedAt:now,updatedAt:now};
      if(previous)this.db.update(timelineEvents).set({data:next,updated_at:now}).where(eq(timelineEvents.id,id)).run();
      else this.db.insert(timelineEvents).values({id,task_id:run.task_id,task_run_id:run.id,type:"runner.tool",summary:"工具调用（开始发生于记录启用前）",
        data:{...next,toolCallId:output.id,nativeCallId:output.id,toolName:"tool",startedAt:null},visibility:"full",created_at:now,updated_at:now}).run();
    }
  }

  interrupt(runId:string,now=Date.now()):void {
    this.db.run(sql`UPDATE timeline_events SET data=json_set(data,'$.status','interrupted','$.updatedAt',${now}),updated_at=${now}
      WHERE task_run_id=${runId} AND type='runner.tool' AND json_extract(data,'$.status')='running'`);
  }
  tool(job:Job,callId:string) {
    return this.db.select().from(timelineEvents).where(eq(timelineEvents.id,toolId(job.id,job.providerState?.progressAttempt ?? 1,callId))).get();
  }
  text(runId:string,summary:string) {
    return this.db.select().from(timelineEvents).where(and(runPredicate(runId),eq(timelineEvents.type,"runner.step"),eq(timelineEvents.summary,summary))).orderBy(desc(timelineEvents.updated_at),desc(timelineEvents.id)).limit(1).get();
  }
  snapshot(taskId:string,runId:string):ProgressUpdate {
    const rows=this.page(taskId,{runId,limit:200}).rows.reverse();
    const position=this.db.select({n:sql<number>`coalesce(max(max(${timelineEvents.updated_at},${timelineEvents.created_at})),0)`}).from(timelineEvents).where(and(eq(timelineEvents.task_id,taskId),runPredicate(runId))).get()?.n ?? 0;
    return {streamKey:`task:${runId}`,mode:"snapshot",position,entries:rows.map(progressEntry)};
  }
  page(taskId:string,options:{runId?:string|undefined;limit?:number|undefined;cursor?:string|undefined;allEvents?:boolean}={}) {
    const limit=Math.max(1,Math.min(200,options.limit??20));
    let cursor:{at:number;id:string;taskId:string;runId?:string;allEvents?:boolean}|undefined;
    if(options.cursor) {try {cursor=JSON.parse(Buffer.from(options.cursor,"base64url").toString());}catch {throw new GatewayError("invalid_progress_cursor","Invalid progress cursor",400);}
      if(!cursor||cursor.taskId!==taskId||cursor.runId!==options.runId||Boolean(cursor.allEvents)!==Boolean(options.allEvents)||!Number.isSafeInteger(cursor.at)||typeof cursor.id!=="string")throw new GatewayError("invalid_progress_cursor","Cursor scope mismatch",400);}
    const rows=this.db.select().from(timelineEvents).where(and(eq(timelineEvents.task_id,taskId),options.allEvents?undefined:inArray(timelineEvents.type,types),
      options.runId?runPredicate(options.runId):undefined,cursor?or(lt(timelineEvents.created_at,cursor.at),and(eq(timelineEvents.created_at,cursor.at),lt(timelineEvents.id,cursor.id))):undefined))
      .orderBy(desc(timelineEvents.created_at),desc(timelineEvents.id)).limit(limit+1).all();
    const more=rows.length>limit;const page=rows.slice(0,limit);const last=page.at(-1);
    return {rows:page,nextCursor:more&&last?Buffer.from(JSON.stringify({taskId,runId:options.runId,allEvents:Boolean(options.allEvents),at:last.created_at,id:last.id})).toString("base64url"):null};
  }
  query(taskId:string,options:{runId?:string|undefined;limit?:number|undefined;cursor?:string|undefined;allEvents?:boolean}={}) {
    const task=this.db.select().from(tasks).where(eq(tasks.id,taskId)).get();
    if(!task)throw new GatewayError("task_not_found","Task not found",404);
    const run=options.runId&&options.runId!=="all"?this.db.select().from(taskRuns).where(and(eq(taskRuns.task_id,taskId),eq(taskRuns.id,options.runId))).get():this.db.select().from(taskRuns).where(eq(taskRuns.task_id,taskId)).orderBy(desc(taskRuns.run_index)).limit(1).get();
    if(options.runId&&options.runId!=="all"&&!run)throw new GatewayError("task_run_not_found","Run does not belong to Task",404);
    const runId=options.runId==="all"?undefined:run?.id;
    const page=this.page(taskId,{...options,runId,limit:Math.min(100,options.limit??20)});
    const scope=and(eq(timelineEvents.task_id,taskId),runId?runPredicate(runId):undefined);
    const latestText=this.db.select().from(timelineEvents).where(and(scope,eq(timelineEvents.type,"runner.step"),sql`json_extract(${timelineEvents.data},'$.toolPhase') IS NULL`,sql`${timelineEvents.summary} NOT LIKE '工具进度：%'`)).orderBy(desc(timelineEvents.updated_at),desc(timelineEvents.id)).limit(1).get();
    const running=this.db.select().from(timelineEvents).where(and(scope,eq(timelineEvents.type,"runner.tool"),sql`json_extract(${timelineEvents.data},'$.status')='running'`)).orderBy(desc(timelineEvents.created_at)).limit(100).all();
    const lastActivity=this.db.select({n:sql<number>`coalesce(max(max(${timelineEvents.updated_at},${timelineEvents.created_at})),0)`}).from(timelineEvents).where(and(scope,inArray(timelineEvents.type,["runner.tool","runner.step"]))).get()?.n??0;
    return {taskId,runId:run?.id??null,status:task.status,lastActivityAt:lastActivity||null,latestText:latestText?progressEntry(latestText):null,
      runningTools:running.map(progressEntry),items:page.rows.map(progressEntry).reverse(),nextCursor:page.nextCursor};
  }
}
