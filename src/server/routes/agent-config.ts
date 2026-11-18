import {AgentError, AgentStore} from "@/agents/agent-store";
import { Hono, type Context } from "hono";

import {
  ActiveAgentConfigService,
  AgentProfileConnectionTester,
  AgentProfileStore,
  agentTypeDescriptors,
  type AgentConnectionTestExecutor,
  type AgentSecretCipher,
} from "@/agent-config";
import type { DrizzleDB } from "@/data";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";

export interface AgentConfigRouteOptions {
  readonly db: DrizzleDB;
  readonly cipher: AgentSecretCipher | undefined;
  readonly connectionExecutor?: AgentConnectionTestExecutor;
}

export function createAgentConfigRoutes(options: AgentConfigRouteOptions) {
  const profiles = (c: Context) => new AgentProfileStore(options.db, options.cipher, (c as any).get("agentConfigAgentId") as string);
  const active = new ActiveAgentConfigService(options.db, options.cipher);
  const tester = new AgentProfileConnectionTester(options.connectionExecutor);

  return new Hono()
    .use("*", async (c, next) => {
      const admin = requireDashboardOnly(c);
      if (isGuardResponse(admin)) return admin;
      const agentId = c.req.query("agentId");
      if (!agentId) return c.json({status:"error",code:"agent_scope_required"},400);
      new AgentStore(options.db).requireOwner(admin.account.id,agentId);
      (c as any).set("agentConfigAgentId",agentId);
      (c as any).set("agentConfigActorId", admin.account.id);
      await next();
    })
    .onError((error,c) => {
      if (error instanceof AgentError) return c.json({status:"error",code:error.code},error.status);
      throw error;
    })
    .get("/status", (c) => {
      const status = profiles(c).status();
      if (status.status === "setup_required") return c.json(status);
      return c.json({
        status: "ready",
        active: {
          profileId: status.active.id,
          revisionId: status.revision.id,
          name: status.active.name,
          agentType: status.active.agentType,
          model: status.revision.model,
          resumeOnModelChange: status.revision.resumeOnModelChange,
        },
      });
    })
    .get("/types", (c) => c.json({ types: agentTypeDescriptors }))
    .get("/profiles", (c) => c.json({ profiles: profiles(c).listProfiles() }))
    .post("/profiles", async (c) => {
      try {
        const body = await c.req.json<Record<string, unknown>>();
        const profile = profiles(c).createProfile({
          ...body,
          actorId: (c as any).get("agentConfigActorId") as string,
        } as never);
        return c.json({ profile }, 201);
      } catch (error) {
        return domainError(c, error);
      }
    })
    .get("/profiles/:id", (c) => {
      const profile = profiles(c).getProfile(c.req.param("id"));
      return profile === undefined
        ? c.json({ status: "error", code: "not_found", message: "Agent profile not found" }, 404)
        : c.json({ profile });
    })
    .post("/profiles/:id/revisions", async (c) => {
      try {
        const body = await c.req.json<Record<string, unknown>>();
        const revision = profiles(c).createRevision(c.req.param("id"), {
          ...body,
          actorId: (c as any).get("agentConfigActorId") as string,
        } as never);
        return c.json({ revision }, 201);
      } catch (error) {
        return domainError(c, error);
      }
    })
    .post("/revisions/:id/test", async (c) => {
      try {
        const revisionId = c.req.param("id");
        if (!profiles(c).getRevision(revisionId)) return c.json({status:"error",code:"not_found"},404);
        const snapshot = active.resolveRevisionSnapshot(profiles(c).agentId, revisionId);
        const result = await tester.testSnapshot(snapshot);
        new AgentStore(options.db).requireOwner((c as any).get("agentConfigActorId"),(c as any).get("agentConfigAgentId"));
        const revision = profiles(c).recordValidation(revisionId, result);
        return c.json({ result, revision }, result.success ? 200 : 422);
      } catch (error) {
        return domainError(c, error);
      }
    })
    .post("/revisions/:id/activate", (c) => {
      try {
        if (!profiles(c).getRevision(c.req.param("id"))) return c.json({status:"error",code:"not_found"},404);
        const snapshot = active.activate(
          profiles(c).agentId,
          c.req.param("id"),
          (c as any).get("agentConfigActorId") as string,
        );
        return c.json({ status: "ok", active: publicSnapshot(snapshot) });
      } catch (error) {
        return domainError(c, error);
      }
    })
    .delete("/profiles/:id", (c) => {
      try {
        profiles(c).deleteProfile(
          c.req.param("id"),
          (c as any).get("agentConfigActorId") as string,
        );
        return c.json({ status: "ok" });
      } catch (error) {
        return domainError(c, error);
      }
    });
}

function publicSnapshot(snapshot: ReturnType<ActiveAgentConfigService["resolveExecutionSnapshot"]>) {
  return {
    agentId: snapshot.agentId,
    profileId: snapshot.profileId,
    revisionId: snapshot.revisionId,
    agentType: snapshot.agentType,
    model: snapshot.model,
    resumeOnModelChange: snapshot.resumeOnModelChange,
    activationSequence: snapshot.activationSequence,
  };
}

function domainError(c: Parameters<Parameters<Hono["onError"]>[0]>[1], error: unknown) {
  if(error instanceof AgentError && error.code==="agent_profile_in_use")return c.json({status:"error",code:error.code,message:"该模型配置正在被分身使用，请先在分身设置中改为跟随激活配置或选择其他模型。"},409);
  if (error instanceof AgentError) return c.json({status:"error",code:error.code},error.status);
  const message = error instanceof Error ? error.message : String(error);
  const conflict = /validated before activation|active Agent profile/i.test(message);
  return c.json({
    status: "error",
    code: conflict ? "agent_profile_not_validated" : "agent_profile_invalid",
    message,
  }, conflict ? 409 : 400);
}
