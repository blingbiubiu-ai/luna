import { listOperationSuggestions, registerPluginOperations } from "../../src/operations/operation-registry";
import type { DrizzleDB } from "../../src/data";
/** Test-only bridge from old fixture shapes to in-memory operation declarations. */
export function registerFixtureOperations(db: DrizzleDB, values: any): void {
  const rows=Array.isArray(values)?values:[values];
  const definitions=[...listOperationSuggestions(db).filter(p=>p.pluginId && !rows.some(r=>r.id===p.id)).map(p=>({...p,title:p.title ?? p.id,inputSchema:{},artifactPolicy:"none" as const})),...rows.map(r=>({id:r.id,pluginId:r.pluginId ?? r.id.split('.')[0],title:r.title ?? r.id,inputSchema:{},riskLevel:r.riskLevel ?? "low",artifactPolicy:"none" as const,defaultDecision:r.defaultDecision ?? "deny"}))];
  registerPluginOperations(db,definitions,[...new Set<string>(definitions.map(d=>d.pluginId!))]);
}
