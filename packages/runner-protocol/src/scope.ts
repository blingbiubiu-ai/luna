import {z} from "zod";
const scopeId=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const AgentScope=z.object({agentId:scopeId,shadowId:scopeId}).strict();
export const ExecutionScope=AgentScope.extend({placementGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
export const ResourceSelection=z.object({publicRevision:digest,agentMemoryRevision:digest,shadowConfigRevision:digest,agentToolsRevision:digest,digest}).strict();
