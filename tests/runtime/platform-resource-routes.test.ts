import {fixtureArtifact,fixtureOwnerUserId,fixtureUser} from "../helpers/platform-fixtures";
import {createArtifactAccessPolicy} from "@/server/artifact-access-policy";
import {createDashboardArtifactSigner} from "@/dashboard-api/local-paths";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Hono} from "hono";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {SessionStore} from "@/sessions/session-store";
import {TaskResolver} from "@/tasks/task-resolver";
import {createSessionsRoutes} from "@/server/routes/sessions";
import {createTasksRoutes} from "@/server/routes/tasks";
import {fixtureScope} from "../helpers/platform-fixtures";
let home:string,db:DataConnection<typeof schema>,scope:ReturnType<typeof fixtureScope>;
let first:string,second:string,taskA:string,taskB:string;
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-resource-routes-"));setLunaHome(home);db=new DataConnection(schema);
 scope=fixtureScope(db.db,"owner");fixtureScope(db.db,"alice");fixtureScope(db.db,"bob");fixtureUser(db.db,scope.agentId,"alice");fixtureUser(db.db,scope.agentId,"bob");
 const sessions=new SessionStore(db.db);first=sessions.createLocalSession("alice",scope).id;second=sessions.createLocalSession("bob",scope).id;
 const tasks=new TaskResolver(db.db),base={scope,title:"private",text:"private",workflow:"task" as const};
 taskA=tasks.resolvePersistentTask({...base,creatorUserId:"alice"}).persistentTask.id;
 taskB=tasks.resolvePersistentTask({...base,creatorUserId:"bob"}).persistentTask.id;
});
afterEach(()=>{db.close();rmSync(home,{recursive:true,force:true});});
function app(userId?:string,runner?:{sessionId:string;taskId?:string}){
 return new Hono().use("*",async(c,next)=>{
  if(userId){
   // A runner token has no account and acts as the account's user in the Agent.
   c.set("dashboardAuthSession" as never,{authenticated: true, account: runner?null:{id:userId,name:userId,provider:"local"}} as never);
   c.set("lunaRequestAuthKind" as never,(runner?"luna-access-token":"dashboard-cookie") as never);
   if(runner)c.set("lunaAccessTokenClaims" as never,{agentId:scope.agentId,actorUserId:fixtureOwnerUserId(userId),source:"runner",role:"runner",...runner} as never);
  }await next();
 }).route("/sessions",createSessionsRoutes({db:db.db})).route("/tasks",createTasksRoutes({db:db.db}));
}
test("lists require authentication and explicit Agent scope and reject non-owners",async()=>{
 expect((await app().request("/sessions")).status).toBe(401);
 expect((await app("alice").request("/sessions")).status).toBe(400);
 expect((await app("alice").request("/tasks")).status).toBe(400);
 const sessions=await app("alice").request(`/sessions?agentId=${scope.agentId}`);
 expect(sessions.status).toBe(403);
 const tasks=await app("alice").request(`/tasks?agentId=${scope.agentId}`);
 expect(tasks.status).toBe(403);
 const owner=await app("owner").request(`/sessions?agentId=${scope.agentId}`);
 expect((await owner.json() as {id:string}[]).map(row=>row.id).sort()).toEqual([first,second].sort());
});
test("ID and nested routes reject private records even for participants",async()=>{
 for(const path of [`/sessions/${second}/messages`,`/sessions/${second}/turns`,`/sessions/${second}/timeline`,`/sessions/${second}/timeline/read`,
 `/tasks/${taskB}`,`/tasks/${taskB}/timeline`,`/tasks/${taskB}/runs`,`/tasks/${taskB}/artifacts`]){
  expect((await app("alice").request(path)).status).toBe(403);
 }
 expect((await app("alice").request(`/tasks/${taskA}`)).status).toBe(403);
 expect((await app("owner").request(`/tasks/${taskB}`)).status).toBe(200);
 expect((await app("alice").request(`/sessions/${first}`,{method:"DELETE"})).status).toBe(403);
});
test("another Agent and non-owners cannot read known resource IDs",async()=>{
 const foreign=fixtureScope(db.db,"outsider");
 expect((await app("outsider").request(`/sessions/${first}/messages`)).status).toBe(403);
 expect((await app("owner").request(`/tasks?agentId=${foreign.agentId}`)).status).toBe(403);
 expect((await app("alice").request(`/tasks/${taskA}`)).status).toBe(403);
});
test("Runner owner's broad visibility does not widen the claimed resource",async()=>{
 const runner=app("owner",{sessionId:first,taskId:taskA});
 expect((await runner.request(`/sessions/${second}/messages`)).status).toBe(403);
 expect((await runner.request(`/tasks/${taskB}`)).status).toBe(403);
 const response=await runner.request(`/sessions?agentId=${scope.agentId}`);
 expect(response.status).toBe(200);expect((await response.json() as {id:string}[]).map(row=>row.id)).toEqual([first]);
});

test("related users need an explicit signed link to read another owner’s artifact",()=>{
 db.db.insert(schema.managedArtifacts).values(fixtureArtifact(db.db, {id:"bob-artifact",scope_type:"task",scope_id:taskB,related_user_id:null,producer:"test",kind:"file",name:"private.txt",storage_key:"private",created_at:Date.now()})).run();
 const artifact=db.db.select().from(schema.managedArtifacts).get()!;
 const alice=createArtifactAccessPolicy({db:db.db,requesterAccountId:"alice"});
 expect(alice.canReadMetadata(artifact)).toBe(false);expect(alice.canCreateSignedUrl(artifact)).toBe(false);
 expect(createDashboardArtifactSigner({db:db.db,requesterAccountId:"alice"}).contentUrl(artifact.id)).toBeUndefined();
 const mcp=createArtifactAccessPolicy({db:db.db,requesterAccountId:"alice",accessTokenClaims:{tokenId:"mcp",accountId:"alice",source:"mcp",role:"user",issuedAt:1,expiresAt:Date.now()+10000}});
 expect(mcp.canReadMetadata(artifact)).toBe(false);
 const related = {...artifact, related_user_id: "alice"};

 expect(alice.canReadMetadata(related)).toBe(false);
 expect(createArtifactAccessPolicy({db:db.db,requesterAccountId:"owner"}).canReadMetadata(artifact)).toBe(true);
 expect(alice.canReadContent(artifact,{hasValidSignature:true})).toBe(true);
});
test("Runner artifact allowlists cannot cross Shadow scope even for the Agent owner",()=>{
 const shadow=new AgentStore(db.db).createShadow("owner",scope.agentId,{name:"Other"},"other");
 const foreign=new SessionStore(db.db).createLocalSession("user:owner",{agentId:scope.agentId,shadowId:shadow.id});
 db.db.insert(schema.managedArtifacts).values(fixtureArtifact(db.db, {id:"shadow-artifact",scope_type:"session",scope_id:foreign.id,related_user_id:fixtureOwnerUserId("owner"),producer:"test",kind:"file",name:"private.txt",storage_key:"private",created_at:Date.now()})).run();
 const artifact=db.db.select().from(schema.managedArtifacts).get()!;
 const runner=createArtifactAccessPolicy({db:db.db,runArtifactAllowlist:[artifact.id],accessTokenClaims:{tokenId:"runner",actorUserId:fixtureOwnerUserId("owner"),source:"runner",role:"runner",sessionId:first,issuedAt:1,expiresAt:Date.now()+10000}});
 expect(runner.canReadMetadata(artifact)).toBe(false);expect(runner.canCreateSignedUrl(artifact)).toBe(false);
});
