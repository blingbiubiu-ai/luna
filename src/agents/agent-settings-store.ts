import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { agentSettings } from "@/data/schema";
import { AgentStore } from "./agent-store";

const ProgressCardStyle = z.enum(["card", "native"]);

/**
 * An Agent's own settings. Each group fills in its defaults, so a stored value may omit
 * groups or fields added later; the defaults are today's behaviour.
 */
export const AgentSettings = z.object({
  /** Incoming messages: the reaction a channel adds while a message addressed to the Agent waits for its reply. */
  inbound: z.object({
    processingReaction: z.boolean().default(true),
  }).strict().default({ processingReaction: true }),
  /** Work sessions: the progress card Runtime keeps while a turn runs. */
  work: z.object({
    progressCard: z.object({
      show: z.boolean().default(true),
      style: ProgressCardStyle.default("card"),
    }).strict().default({ show: true, style: "card" }),
  }).strict().default({ progressCard: { show: true, style: "card" } }),
  /** Main: the progress card of a Task it starts, unless the Runner chooses otherwise. */
  main: z.object({
    taskProgressCard: z.object({
      send: z.boolean().default(true),
      style: ProgressCardStyle.default("native"),
    }).strict().default({ send: true, style: "native" }),
  }).strict().default({ taskProgressCard: { send: true, style: "native" } }),
  /** Tasks: how long one run may take before Runtime stops it. A stopped run fails and can be restarted. */
  task: z.object({
    runLimitHours: z.number().int().min(1).max(168).default(10),
  }).strict().default({ runLimitHours: 10 }),
}).strict();
export type AgentSettings = z.infer<typeof AgentSettings>;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = AgentSettings.parse({});

/** Read by runtime code for any Agent; read and changed by the Agent's owner. */
export class AgentSettingsStore {
  constructor(private readonly db: DrizzleDB) {}

  get(agentId: string): AgentSettings {
    const row = this.db.select().from(agentSettings).where(eq(agentSettings.agentId, agentId)).get();
    const parsed = row ? AgentSettings.safeParse(row.settings) : undefined;
    return parsed?.success ? parsed.data : DEFAULT_AGENT_SETTINGS;
  }

  read(accountId: string, agentId: string): AgentSettings {
    new AgentStore(this.db).requireOwner(accountId, agentId);
    return this.get(agentId);
  }

  save(accountId: string, agentId: string, input: unknown): AgentSettings {
    const settings = AgentSettings.parse(input);
    return this.db.transaction(() => {
      new AgentStore(this.db).requireOwner(accountId, agentId);
      const values = { agentId, settings, updatedByAccountId: accountId, updatedAt: Date.now() };
      this.db.insert(agentSettings).values(values).onConflictDoUpdate({ target: agentSettings.agentId, set: values }).run();
      return this.get(agentId);
    });
  }
}
