import {ExecutionScope,ResourceSelection} from "@luna/runner-protocol";
import {ExecutionError} from "@luna/execution-store";
import {validateScopedResources} from "@luna/host-runtime/scoped-runner-resources";
import {ScopedResourceStore} from "@luna/host-runtime/scoped-resource-store";
import {WorkerConfig} from "./config";

/** Authenticated scoped download; stores immutable bytes without switching a running container. */
export class WorkerResourceDownload {
 private readonly origin:string;
 private readonly store:ScopedResourceStore;
 constructor(home:string,origin:string,private readonly token:string){
  this.origin=WorkerConfig.shape.serviceUrl.unwrap().parse(origin);
  WorkerConfig.shape.controlToken.parse(token);
  this.store=new ScopedResourceStore(home);
 }
 async sync(rawScope:ExecutionScope,rawSelection:import("@luna/host-runtime/scoped-runner-resources").ResourceSelection,signal?:AbortSignal):Promise<string>{
  const scope=ExecutionScope.parse(rawScope),selection=ResourceSelection.parse(rawSelection);
  const url=new URL(`/api/worker/resources/${selection.digest}`,this.origin);
  url.search=new URLSearchParams({agentId:scope.agentId,shadowId:scope.shadowId,placementGeneration:String(scope.placementGeneration)}).toString();
  const response=await fetch(url,{headers:{authorization:`Bearer ${this.token}`},redirect:"error",
   signal:AbortSignal.any([AbortSignal.timeout(60000),...(signal ? [signal] : [])])});
  if(!response.ok)throw new ExecutionError(response.status,"scoped_resource_download_failed");
  // Bound the wire body as well as decoded files, before parsing attacker-controlled JSON.
  if(!response.body)throw new ExecutionError(422,"resource_body_missing");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let size=0;
  try{
   for(;;){const {done,value}=await reader.read();if(done)break;
    size+=value.length;if(size>192*1024*1024)throw new ExecutionError(413,"resource_body_too_large");chunks.push(value);
   }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  signal?.throwIfAborted();
  const bundle=validateScopedResources(JSON.parse(Buffer.concat(chunks).toString("utf8")),scope,selection);
  return this.store.publish(bundle,scope,selection);
 }
}
