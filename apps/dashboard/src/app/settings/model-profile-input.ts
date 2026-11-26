import type { CreateAgentProfileInput, DashboardAgentType, DashboardAgentTypeDescriptor, DashboardExecutionDriver, DashboardModelProviderReference } from "@/lib/api/hooks";
export interface ProfileDraft {
  agentType: DashboardAgentType; model: string; executionDriver: DashboardExecutionDriver; resume: boolean; gateway: boolean; workerMode: boolean;
  source: DashboardModelProviderReference | null; envText: string; replacements: Record<string, string>; newSecrets: { key: string; value: string }[]; configuredKeys: string[]; descriptor?: DashboardAgentTypeDescriptor;
}
export function parsePairs(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").map(line => line.trim()).filter(Boolean).map(line => { const separator = line.indexOf("="); if (separator < 1) throw new Error("Enter one KEY=value pair per line."); return [line.slice(0, separator).trim(), line.slice(separator + 1)]; }));
}
export function formatPairs(values: Record<string, string>) { return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"); }
export function envValue(text: string, key: string) { const line = text.split("\n").find(line => line.slice(0, line.indexOf("=")).trim() === key); return line ? line.slice(line.indexOf("=") + 1) : ""; }
export function setEnvValue(text: string, key: string, value: string) { const lines = text.split("\n").filter(line => line.slice(0, line.indexOf("=")).trim() !== key && line.trim()); return [...lines, ...(value ? [`${key}=${value}`] : [])].join("\n"); }
export function buildProfileRevision(draft: ProfileDraft): Omit<CreateAgentProfileInput, "name" | "agentType"> {
  const env = parsePairs(draft.envText);
  if (!draft.model.trim()) throw new Error("请选择或填写模型。");
  if (draft.workerMode && (draft.agentType !== "codex" || !draft.source)) throw new Error("请选择已登录的 Worker 账号和模型。");
  if (draft.agentType === "codex") { if (draft.gateway && !draft.workerMode) env.CODEX_PROVIDER_MODE = "gateway"; else delete env.CODEX_PROVIDER_MODE; }
  if (draft.workerMode) delete env.OPENAI_BASE_URL;
  const values: Record<string, string> = { ...draft.replacements };
  for (const secret of draft.newSecrets) { const key = secret.key.trim(); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Each new secret needs a valid environment variable name."); if (draft.configuredKeys.includes(key) || Object.hasOwn(values, key)) throw new Error(`Secret ${key} already exists. Use Replace to update it.`); values[key] = secret.value; }
  if (Object.values(values).some(value => !value.trim())) throw new Error("Enter a value for each new or replacement secret, or cancel that change.");
  const secrets: CreateAgentProfileInput["secrets"] = Object.fromEntries(Object.entries(values).filter(([key]) => !draft.workerMode || key !== "OPENAI_API_KEY").map(([key, value]) => [key, { set: value }]));
  if (draft.workerMode && draft.configuredKeys.includes("OPENAI_API_KEY")) secrets.OPENAI_API_KEY = { clear: true };
  return { modelProvider: draft.workerMode ? draft.source : null, model: draft.model, executionDriver: draft.executionDriver, resumeOnModelChange: draft.resume, env, secrets,
    customSensitiveKeys: Object.keys(values).filter(key => !draft.descriptor?.envFields.some(field => field.key === key)), customNonSensitiveKeys: Object.keys(env).filter(key => !draft.descriptor?.envFields.some(field => field.key === key)) };
}
