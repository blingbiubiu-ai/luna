import { Hono } from "hono";
import { z } from "zod";
import { Id, ModelProviderReference } from "@luna/runner-protocol";
import { ExecutionError } from "@luna/execution-store";
import { AgentError } from "@/agents/agent-store";
import type { ModelProviderService } from "@/model-providers/service";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";

const target = z.object({ workerId: Id, pluginId: Id, providerId: Id }).strict();
export function createModelProviderCallbackRoutes(service: ModelProviderService) {
  const routes=new Hono().onError((error,c)=>{
    const code=error instanceof AgentError || error instanceof ExecutionError ? error.code : "model_provider_request_invalid";
    c.header("Referrer-Policy","no-referrer");c.header("Cache-Control","no-store");
    return c.redirect(`/?modelLoginError=${encodeURIComponent(code)}`,303);
  });
  for(const path of service.callbackPaths())routes.get(path,async c=>{
    c.header("Cache-Control","no-store");c.header("Referrer-Policy","no-referrer");
    const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return c.redirect("/login?next=%2F",303);
    const url=new URL(c.req.url);if(url.search.length>65536)return c.text("授权回调过大",413);
    if(url.searchParams.getAll("flowId").length!==1)return c.text("授权回调无效",400);
    const flowId=Id.parse(url.searchParams.get("flowId"));const params:Record<string,string>={};
    for(const [key,value] of url.searchParams){if(key==="flowId")continue;if(Object.hasOwn(params,key))return c.text("授权回调无效",400);params[key]=value;}
    const result=await service.loginCallback(auth.account.id,flowId,params,c.req.path);
    const query=new URLSearchParams({modelLogin:flowId,modelPlugin:result.pluginId,modelProvider:result.providerId,modelWorker:result.workerId});
    return c.redirect(`/agent/${encodeURIComponent(result.agentId)}/settings/agents?${query}`,303);
  });
  return routes;
}
export function createModelProviderRoutes(service: ModelProviderService) {
  return new Hono().onError((error, c) => {
    const status = error instanceof AgentError || error instanceof ExecutionError ? error.status : 422;
    const code = error instanceof AgentError || error instanceof ExecutionError ? error.code : "model_provider_request_invalid";
    return c.json({ status: "error", code, message: code }, status as 400);
  }).use("*", async (c, next) => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    if (!c.req.query("agentId")) return c.json({ code: "agent_scope_required" }, 400);
    await next();
  }).get("/providers", c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    return c.json({ providers: service.providers(auth.account.id, c.req.query("agentId")!), workers: service.workers(auth.account.id, c.req.query("agentId")!) });
  }).post("/account", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const input = target.parse(await c.req.json());
    return c.json({ account: await service.account(auth.account.id, c.req.query("agentId")!, input.workerId, input.pluginId, input.providerId) });
  }).post("/import", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    if (Number(c.req.header("content-length")) > 65536) return c.json({ code: "request_too_large" }, 413);
    const text = await c.req.text(); if (text.length > 65536) return c.json({ code: "request_too_large" }, 413);
    const input = target.extend({ requestId: Id, expectedRevision: Id.nullable(), credential: z.unknown() }).strict().parse(JSON.parse(text));
    return c.json({ account: await service.importAccount(auth.account.id, c.req.query("agentId")!, input) });
  }).post("/refresh", async c => {
    const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
    const input = z.object({ reference: ModelProviderReference }).strict().parse(await c.req.json());
    return c.json({ models: await service.refresh(auth.account.id, c.req.query("agentId")!, input.reference) });
  }).post("/login/start",async c=>{
    const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
    const input=target.extend({expectedRevision:Id.nullable()}).strict().parse(await c.req.json());
    return c.json(await service.startLogin(auth.account.id,c.req.query("agentId")!,input,new URL(c.req.url).origin));
  }).post("/login/poll",async c=>{
    const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;const {flowId}=z.object({flowId:Id}).strict().parse(await c.req.json());
    return c.json(await service.pollLogin(auth.account.id,c.req.query("agentId")!,flowId));
  }).post("/login/cancel",async c=>{
    const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;const {flowId}=z.object({flowId:Id}).strict().parse(await c.req.json());
    return c.json(await service.cancelLogin(auth.account.id,c.req.query("agentId")!,flowId));
  }).post("/info",async c=>{
    const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;const {reference}=z.object({reference:ModelProviderReference}).strict().parse(await c.req.json());
    return c.json(await service.info(auth.account.id,c.req.query("agentId")!,reference));
  });
}
