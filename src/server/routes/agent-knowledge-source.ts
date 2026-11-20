import { Hono, type Context } from "hono";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { config } from "@/shared";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { AgentKnowledgeSource } from "@/agents/agent-knowledge-source";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";

const errors: Record<string, string> = {
  knowledge_busy: "知识库正在初始化或同步，请稍后再试。",
  knowledge_not_empty: "当前知识库已有文件或提交记录，不能自动覆盖。",
  knowledge_source_already_initialized: "知识库已初始化，暂不支持更换仓库或分支。",
  knowledge_source_not_configured: "请先配置知识库 Git 地址。",
};

/** Source setup uses owner management access, never Runner business grants. */
export function createAgentKnowledgeSourceRoutes(db: DrizzleDB, home?: string) {
  const service = () => new AgentKnowledgeSource(home ?? config.paths.home);
  const owner = (c: Context) => {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) return auth;
    const agent = new AgentStore(db).requireOwner(auth.account.id, c.req.param("agentId")!);
    new AgentStore(db).requireAccess(new AgentStore(db).ownerUserId(agent.id), agent.id);
    return agent.id;
  };
  return new Hono().onError((error, c) => {
    if (error instanceof AgentError) return c.json({ status: "error", code: error.code, message: errors[error.code] ?? error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ status: "error", code: "invalid_request", message: "请输入有效的 Git 地址和分支，不要在地址中填写密码或访问令牌。" }, 400);
    throw error;
  })
    .get("/:agentId/knowledge/source", c => {
      const id = owner(c); if (typeof id !== "string") return id;
      return c.json({ source: service().read(id) });
    })
    .put("/:agentId/knowledge/source", async c => {
      const id = owner(c); if (typeof id !== "string") return id;
      return c.json({ source: service().initialize(id, await c.req.json()) }, 202);
    })
    .post("/:agentId/knowledge/source/sync", c => {
      const id = owner(c); if (typeof id !== "string") return id;
      return c.json({ source: service().sync(id) }, 202);
    });
}
