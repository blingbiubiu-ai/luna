import {Database} from "bun:sqlite";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkerShadowMounts} from "../../apps/worker/src/shadow-mounts";
import {createScopedResources,type ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import {ScopedResourceStore} from "@luna/host-runtime/scoped-resource-store";
let root:string,db:Database,planner:WorkerShadowMounts;
const a={agentId:"agent-a",shadowId:"shadow-a"},b={agentId:"agent-a",shadowId:"shadow-b"},c={agentId:"agent-c",shadowId:"shadow-c"};
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),"worker-shadow-mounts-")));db=new Database(join(root,"worker.sqlite"));planner=new WorkerShadowMounts(db,root);});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
function snapshot(scope:ResourceScope,prompt="prompt"){
 const bundle=createScopedResources(scope,[{path:"public/prompts/note.md",content:Buffer.from(prompt).toString("base64"),mode:0o644},
 {path:"agent/tools/commands/whoami",content:Buffer.from(scope.shadowId).toString("base64"),mode:0o644}]);
 new ScopedResourceStore(root).publish(bundle,scope,bundle.selection);return bundle.selection;
}
test("three Shadow plans each mount one fixed resource snapshot read-only",()=>{
 for(const scope of [a,b,c]){
  const result=planner.prepare(scope,snapshot(scope));
  expect(result.mounts).toEqual([
   {source:result.layout.home,destination:result.layout.home,readonly:false},
   {source:result.resourceSource,destination:join(result.layout.home,".luna-resources"),readonly:true},
  ]);
  expect(result.resourceSource.startsWith(result.layout.resourceRoot+"/mounts/")).toBe(true);
  expect(readFileSync(join(result.resourceSource,"commands","whoami"),"utf8")).toBe(scope.shadowId);

 }
});
test("scope substitution fails before HOME creation; resource revisions never change writable HOME",()=>{
 const selection=snapshot(a);
 expect(()=>planner.prepare(b,selection)).toThrow();
 expect(existsSync(join(root,"agents/agent-a/shadows/shadow-b"))).toBe(false);
 const old=planner.prepare(a,selection),next=planner.prepare(a,snapshot(a,"changed"));
 expect(old.layout).toEqual(next.layout);
 expect(old.resourceSource).not.toBe(next.resourceSource);
 expect(readFileSync(join(old.resourceSource,"prompts","note.md"),"utf8")).toBe("prompt");
 expect(readFileSync(join(next.resourceSource,"prompts","note.md"),"utf8")).toBe("changed");
});
test("Runner-created symlinks cannot redirect the resource mount to another Shadow",()=>{
 const selection=snapshot(a),first=planner.prepare(a,selection),other=planner.prepare(b,snapshot(b));
 rmSync(join(first.layout.home,".luna-resources"),{recursive:true});
 symlinkSync(other.layout.home,join(first.layout.home,".luna-resources"));
 expect(()=>planner.prepare(a,selection)).toThrow("shadow_mount_target_invalid");
});
