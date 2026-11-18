import {z} from "zod";
import {Id,RunnerKind} from "./job.js";
import {absoluteRunnerPath} from "./runner-assets.js";

import {AgentScope,ExecutionScope,ResourceSelection} from "./scope.js";
export {AgentScope,ExecutionScope,ResourceSelection} from "./scope.js";
export const ContextPreparation=z.object({
 protocolVersion:z.literal(2),scope:AgentScope,resources:ResourceSelection,
 invocationId:Id,contextId:Id,runnerId:Id,scopeKey:z.string().min(1).max(512),runnerKind:RunnerKind,
 context:z.record(z.string(),z.unknown()).optional(),projectId:Id.optional(),
 git:z.object({authorName:z.string(),authorEmail:z.string()}).strict().optional(),
 /** The Shadow's root switch: Worker adds the Root Access rules to Runner instructions. */
 rootAccess:z.boolean().optional(),
 /** Who the Shadow is, rendered at the top of Runner instructions. */
 soul:z.object({
  name:z.string().max(256),agent:z.string().max(256),
  owner:z.object({id:Id,name:z.string().max(256)}).strict(),
  persona:z.array(z.string().max(64*1024)).max(32),
 }).strict().optional(),
}).strict();
export const WorkerContextPreparation=ContextPreparation.extend({scope:ExecutionScope}).strict();
export const WorkerPreparedContext=z.object({
 protocolVersion:z.literal(2),scope:ExecutionScope,workerId:Id,home:absoluteRunnerPath,cwd:absoluteRunnerPath,
 instructionFingerprint:z.string().min(1),resources:ResourceSelection,resourceRevision:ResourceSelection.shape.digest,env:z.record(z.string(),z.string()),
}).strict().refine(value=>value.resourceRevision===value.resources.digest,"Resource revision mismatch");
export const PreparedContext=WorkerPreparedContext.safeExtend({local:z.boolean()});
export type ContextPreparation=z.infer<typeof ContextPreparation>;
export type WorkerContextPreparation=z.infer<typeof WorkerContextPreparation>;
export type PreparedContext=z.infer<typeof PreparedContext>;
export type ExecutionScope=z.infer<typeof ExecutionScope>;

export const ContextPreparationRelease=z.object({invocationId:Id,contextId:Id,scope:ExecutionScope,resourceRevision:ResourceSelection.shape.digest}).strict();
