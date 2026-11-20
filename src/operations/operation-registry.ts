import type { DrizzleDB } from "@/data";
import type { OperationDefinition, PluginRegistry } from "@/plugins";
import { KNOWLEDGE_WORKSPACE_OPERATIONS } from "../../extensions/workspace/knowledge/definition";
import { isOperationPattern, matchesOperation } from "./operation-pattern";
/** Display/default metadata, never a database-backed prerequisite for invocation. */
export interface OperationPolicy {
    readonly id: string;
    readonly namespace: string;
    readonly operationKind: string;
    readonly riskLevel: "low" | "medium" | "high";
    readonly defaultDecision: "allow" | "deny";
    readonly providerType?: "core" | "plugin";
    readonly pluginId?: string;
    readonly title?: string;
    readonly description?: string;
    readonly status?: "active" | "disabled";
    readonly allowedSubjectTypes: readonly ("user" | "group")[];
    readonly metadata?: Record<string, unknown>;
}
export const DEFAULT_OPERATION_POLICIES: readonly OperationPolicy[] = [
    // Switching listening in a group chat (`#listen on|off`): the Agent owner, or a member allowed here.
    {id:"chat.listen",namespace:"chat",operationKind:"write",riskLevel:"medium",defaultDecision:"deny",providerType:"core",allowedSubjectTypes:["user","group"]},
    ...(["read","write"] as const).map(verb=>({id:`memory.${verb}`,namespace:"memory",operationKind:verb,riskLevel:verb==="read" ? "low" as const : "medium" as const,defaultDecision:"deny" as const,providerType:"core" as const,allowedSubjectTypes:["user","group"] as const})),
    ...([
        [KNOWLEDGE_WORKSPACE_OPERATIONS.read, "read", "low"],
        [KNOWLEDGE_WORKSPACE_OPERATIONS.write, "write", "medium"],
        [KNOWLEDGE_WORKSPACE_OPERATIONS.gitCommit, "commit", "medium"],
    ] as const).map(([id, operationKind, riskLevel]) => ({
        id, namespace: "workspace", operationKind, riskLevel, defaultDecision: "deny" as const,
        providerType: "core" as const, allowedSubjectTypes: ["user", "group"] as const,
    })),
    { id: "system.admin", namespace: "system", operationKind: "admin", riskLevel: "high", defaultDecision: "deny", providerType: "core", allowedSubjectTypes: ["user"] },
    // Trust for root on this Agent's Shadows whose root switch is on (see shadow-root-access-store).
    { id: "agent.root", namespace: "agent", operationKind: "root", riskLevel: "high", defaultDecision: "deny", providerType: "core",
      title: "Root 权限", description: "开启 root 的分身会为此人想做或同意的事使用 sudo", allowedSubjectTypes: ["user", "group"] },
];
// Per-runtime registration: database identity only scopes independent kernels/tests.
// No operation definitions or namespace ownership are persisted in the database.
const catalogs = new WeakMap<object, {
    definitions: readonly OperationDefinition[];
    registry?: PluginRegistry;
}>();
export function registerPluginOperations(db: DrizzleDB, definitions: readonly OperationDefinition[], pluginIds: readonly string[], registry?: PluginRegistry): void {
    if (definitions.some(d => !d.pluginId || !pluginIds.includes(d.pluginId)))
        throw new Error("Operation owner is not loaded");
    catalogs.set(db, { definitions, ...(registry ? { registry } : {}) });
}
export function operationPolicy(definition: OperationDefinition): OperationPolicy {
    return { id: definition.id, title: definition.title, ...(definition.description ? { description: definition.description } : {}), ...(definition.pluginId ? { pluginId: definition.pluginId } : {}), namespace: definition.id.split(".")[0]!, operationKind: "execute", riskLevel: definition.riskLevel === "sensitive" ? "high" : definition.riskLevel,
        defaultDecision: definition.defaultDecision ?? "deny", providerType: "plugin", allowedSubjectTypes: ["user", "group"] };
}
export function listOperationSuggestions(db: DrizzleDB, namespace?: string): OperationPolicy[] {
    const catalog = catalogs.get(db);
    const definitions = catalog?.registry?.listOperations() ?? catalog?.definitions ?? [];
    const scopes = catalog?.registry?.listDynamicNamespaces().map(n => ({ id: `${n}.*`, namespace: n, operationKind: "execute", riskLevel: "medium" as const, defaultDecision: "deny" as const, allowedSubjectTypes: ["user", "group"] as const })) ?? [];
    return [...DEFAULT_OPERATION_POLICIES, ...definitions.map(operationPolicy), ...scopes].filter(p => namespace === undefined || p.namespace === namespace);
}
export function resolveOperationPolicy(db: DrizzleDB, id: string): OperationPolicy | undefined {
    const builtin = DEFAULT_OPERATION_POLICIES.find(p => p.id === id);
    if (builtin)
        return builtin;
    const catalog = catalogs.get(db);
    const definition = catalog?.registry?.getOperation(id) ?? catalog?.definitions.find(d => d.id === id);
    return definition ? operationPolicy(definition) : undefined;
}
export function resolveGrantTarget(db: DrizzleDB, target: string): OperationPolicy | undefined {
    const id = isOperationPattern(target) ? target.slice(0, -2) : target;
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(id))
        return undefined;
    const namespace = id.split(".")[0]!;
    const registry = catalogs.get(db)?.registry;
    if (registry?.listDynamicNamespaces().includes(namespace))
        return { id: target, namespace, operationKind: "execute", riskLevel: "medium", defaultDecision: "deny", allowedSubjectTypes: ["user", "group"] };
    if (!isOperationPattern(target))
        return resolveOperationPolicy(db, target);
    const matches = listOperationSuggestions(db).filter(p => matchesOperation(target, p.id));
    const first = matches[0];
    return first ? { ...first, id: target, allowedSubjectTypes: first.allowedSubjectTypes.filter(t => matches.every(p => p.allowedSubjectTypes.includes(t))) } : undefined;
}
