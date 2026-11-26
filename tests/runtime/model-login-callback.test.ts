import {expect,test} from 'bun:test';
import {Hono} from 'hono';
import {createModelProviderCallbackRoutes,createModelProviderRoutes} from '../../src/server/routes/model-providers';
import type {ModelProviderService} from '../../src/model-providers/service';
import {PluginRegistry} from '../../src/plugins/registry';
import {fixtureModelRelease} from '../fixtures/worker-model-release';
import {AgentError} from '../../src/agents/agent-store';

function setup(authenticated=true){
 const calls:unknown[]=[];
 const service={callbackPaths:()=>['/authorize','/oauth/fixture/return','/api/model-providers/login/callback'],loginCallback:async(actor:string,flowId:string,params:unknown,callbackPath:string)=>{
  calls.push({actor,flowId,params,callbackPath});if(flowId==='expired')throw new AgentError('model_login_inactive',409);
  return {agentId:'agent',workerId:'worker',pluginId:'plugin',providerId:'provider'};
 }} as unknown as ModelProviderService;
 const app=new Hono().use('*',async(c,next)=>{
  if(authenticated){(c as any).set('lunaRequestAuthKind','dashboard-cookie');(c as any).set('dashboardAuthSession',{authenticated:true,account:{id:'owner',name:'Owner'}});}
  await next();
 }).route('/',createModelProviderCallbackRoutes(service)).route('/api/model-providers',createModelProviderRoutes(service));
 return {app,calls};
}
test('standard App callback relays the owner-bound flow and removes credentials from the redirect',async()=>{
 const {app,calls}=setup();
 for(const path of ['/authorize','/oauth/fixture/return','/api/model-providers/login/callback']){
  const response=await app.request(path+'?flowId=flow&client_state=state&IDEUserToken=private-token&userInfo=%7B%7D');
  expect(response.status).toBe(303);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('Location')).toBe('/agent/agent/settings/agents?modelLogin=flow&modelPlugin=plugin&modelProvider=provider&modelWorker=worker');
 }
 expect(calls).toHaveLength(3);expect(calls[0]).toEqual({actor:'owner',flowId:'flow',params:{client_state:'state',IDEUserToken:'private-token',userInfo:'{}'},callbackPath:'/authorize'});
});
test('callback requires a Dashboard session and rejects ambiguous or oversized parameters before relay',async()=>{
 const unsigned=setup(false);const denied=await unsigned.app.request('/authorize?flowId=flow&IDEUserToken=private-token');
 expect(denied.status).toBe(303);expect(denied.headers.get('Location')).toBe('/login?next=%2F');expect(denied.headers.get('Cache-Control')).toBe('no-store');expect(unsigned.calls).toHaveLength(0);
 const {app,calls}=setup();
 for(const query of ['flowId=flow&flowId=other','flowId=flow&IDEUserToken=a&IDEUserToken=b','IDEUserToken=a'])expect((await app.request('/authorize?'+query)).status).toBe(400);
 expect((await app.request('/authorize?flowId=flow&IDEUserToken='+'a'.repeat(65536))).status).toBe(413);expect(calls).toHaveLength(0);
});
test('inactive callback redirects with a fixed error and never includes the credential',async()=>{
 const {app}=setup();const response=await app.request('/authorize?flowId=expired&IDEUserToken=private-token');
 expect(response.status).toBe(303);expect(response.headers.get('Location')).toBe('/?modelLoginError=model_login_inactive');expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('only declared callback routes are registered',async()=>{
 const {app,calls}=setup();expect((await app.request('/not-declared?flowId=flow')).status).toBe(404);expect(calls).toHaveLength(0);
});
test('plugin callback paths are literal local paths outside built-in routes',()=>{
 const release=fixtureModelRelease();const original=JSON.parse(Buffer.from(release.files.find(f=>f.path==='manifest.json')!.content,'base64').toString());
 for(const callbackPath of ['/authorize','/oauth/fixture/return','https://evil.example/callback','//evil.example','/../callback','/callback?token=x','/callback/*','/callback/:flow','/api/auth/login','/auth/cli']){
  const manifest=structuredClone(original);manifest.workerModelProviders[0].login={type:'oauth',label:'Login',callbackPath};
  const register=()=>new PluginRegistry().registerPlugin(manifest,()=>({invoke:async()=>({status:'success',summary:'',artifacts:[]})}),{});
  if(callbackPath==='/authorize'||callbackPath==='/oauth/fixture/return')expect(register).not.toThrow();else expect(register).toThrow('Invalid Worker model login callback path');
 }
});
