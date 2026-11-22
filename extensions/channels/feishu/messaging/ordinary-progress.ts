import {and,desc,eq,sql} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {sessionChannelDeliveries,messages} from "@/data/schema";
import type {OutboundChannelOperation} from "@/channels/outbound";
import {projection,nativeEntries} from "@/messaging/notifications/progress-update";
type Operation=Omit<OutboundChannelOperation,"id"|"channelId">;
type State=NonNullable<OutboundChannelOperation["progressSnapshot"]>;

/** Ordinary cards own their projection; callers provide only delta or initialization snapshot. */
export class OrdinaryProgress {
  private states=new Map<string,State>();
  constructor(private readonly db:DrizzleDB|undefined,private readonly channelId:string) {}
  prepare(operation:Operation,limit:number):Operation {
    const update=operation.progressUpdate;
    if(!update)return operation;
    if(operation.statusCardStyle==="native")return {...operation,nativeProgress:nativeEntries(update)};
    const key=operation.replyMode==="update_status_card"?operation.targetMessageId!:`create:${operation.idempotencyKey}`;
    let previous=this.states.get(key);
    if(!previous&&this.db&&operation.replyMode==="update_status_card") {
      previous=this.db.select({receipt:sessionChannelDeliveries.receipt}).from(sessionChannelDeliveries)
        .where(and(eq(sessionChannelDeliveries.channelId,this.channelId),sql`json_extract(${sessionChannelDeliveries.receipt},'$.id')=${key}`))
        .orderBy(desc(sessionChannelDeliveries.updatedAt)).limit(1).get()?.receipt?.progressSnapshot;
    }
    if(!previous&&this.db&&operation.replyMode==="update_status_card") {
      const message=this.db.select({raw:messages.rawPayloadJson,content:messages.contentJson}).from(messages)
        .where(and(eq(messages.channelId,this.channelId),eq(messages.externalMessageId,key),eq(messages.role,"assistant")))
        .orderBy(desc(messages.createdAt)).limit(1).get();
      const raw=message?.raw as {outbound?:{progressSnapshot?:State}}|undefined;
      const content=message?.content as {payload?:{progressSnapshot?:State}}[]|undefined;
      previous=raw?.outbound?.progressSnapshot ?? (Array.isArray(content)?content[0]?.payload?.progressSnapshot:undefined);
    }
    if(previous&&previous.streamKey!==update.streamKey)throw new Error("Progress stream does not belong to this card");
    if(previous?.terminal&&operation.statusCardState!=="terminal")throw new Error("Progress card is already terminal");
    const stale=previous&&update.mode==="snapshot"&&update.position<previous.position;
    let entries=stale?previous!.entries:projection(previous?.entries??[],update,limit);
    if(operation.statusCardState === "terminal") entries=entries.map(e=>e.kind === "tool" && e.status === "running" ? {...e,status:"interrupted" as const,updatedAt:Math.max(e.updatedAt,update.position)} : e);
    const state:State={streamKey:update.streamKey,position:Math.max(previous?.position??0,update.position),
      terminal:operation.statusCardState==="terminal"||previous?.terminal===true,entries};
    this.states.set(key,state);
    if(this.states.size>256)this.states.delete(this.states.keys().next().value!);
    return {...operation,progressSnapshot:state,statusCardSteps:entries.map(e=>e.text+(e.kind==="tool"?(e.status==="failed"?"（失败）":e.status==="interrupted"?"（未确认结果）":e.status==="ended"?"（已结束）":""):""))};
  }
  remember(outbound:OutboundChannelOperation):OutboundChannelOperation {
    if(outbound.progressSnapshot)this.states.set(outbound.id,outbound.progressSnapshot);
    if(this.states.size>256)this.states.delete(this.states.keys().next().value!);
    return outbound;
  }
}
