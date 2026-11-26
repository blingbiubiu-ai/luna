import {expect,test} from "bun:test";
import {WorkerModelLogins} from "../../apps/worker/src/model-providers/logins";
const input={agentId:"agent",pluginId:"plugin",providerId:"provider",releaseSha256:"a".repeat(64),flowId:"flow",expectedRevision:null,callbackUrl:"https://luna.example/callback"};
test("Worker login owns flow scope, imports exactly once and never returns the credential to Service",async()=>{
 let accepted=false,saves=0,cancelled=false;
 const account:any={name:"account",credentialRevision:"revision"};
 const logins=new WorkerModelLogins(async(_input,path,body:any)=>{
  if(path==="/login/start")return Response.json({id:"plugin-flow",authorizationUrl:"https://sso.example/authorize"});
  if(path==="/login/callback"){accepted=true;return Response.json({accepted:true});}
  if(path==="/login/cancel"){cancelled=true;return Response.json({cancelled:true});}
  return Response.json(accepted?{state:"ready",credential:{access:"private-token"}}:{state:"pending"});
 },async(_input,credential:any)=>{expect(credential.access).toBe("private-token");saves++;return account;});
 const started=await logins.start(input);expect(started.flowId).toBe("flow");
 expect(await logins.poll("flow","agent")).toEqual({state:"pending"});
 await expect(logins.callback("flow","other",{})).rejects.toThrow("model_login_inactive");
 await logins.callback("flow","agent",{});const [a,b]=await Promise.all([logins.poll("flow","agent"),logins.poll("flow","agent")]);
 expect(a).toEqual({state:"ready",account});expect(b).toEqual(a);expect(JSON.stringify(a)).not.toContain("private-token");expect(saves).toBe(1);expect(cancelled).toBe(true);
 await expect(logins.start({...input,agentId:"other"})).rejects.toThrow("model_login_conflict");
 await logins.cancel("flow","agent");await expect(logins.poll("flow","agent")).rejects.toThrow("model_login_inactive");
});
