import {Database} from "bun:sqlite";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,realpathSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,dirname,join} from "node:path";
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
test("three Shadow plans each mount their own version directory read-only and link the selected snapshot",()=>{
 for(const scope of [a,b,c]){
  const result=planner.prepare(scope,snapshot(scope));
  expect(result.mounts).toEqual([
   {source:result.layout.homeSource,destination:result.layout.home,readonly:false},
   {source:dirname(result.resourceSource),destination:join(result.layout.home,".luna-resource-versions"),readonly:true},
  ]);
  expect(result.resourceSource.startsWith(result.layout.resourceRoot+"/mounts/")).toBe(true);
  expect(readFileSync(join(result.resourceSource,"commands","whoami"),"utf8")).toBe(scope.shadowId);
  // Preparing a plan never switches the link; only the container owner activates it.
  expect(lstatSync(join(result.layout.homeSource,".luna-resources"),{throwIfNoEntry:false})).toBeUndefined();
  planner.activate(result);
  expect(readlinkSync(join(result.layout.homeSource,".luna-resources"))).toBe(`.luna-resource-versions/${basename(result.resourceSource)}`);
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
test("a new snapshot switches the link while the mounted version directory stays the same",()=>{
 const old=planner.prepare(a,snapshot(a)),next=planner.prepare(a,snapshot(a,"changed"));
 expect(next.mounts).toEqual(old.mounts);
 planner.activate(old);planner.activate(next);
 expect(readlinkSync(join(next.layout.homeSource,".luna-resources"))).toBe(`.luna-resource-versions/${basename(next.resourceSource)}`);
 expect(readFileSync(join(old.resourceSource,"prompts","note.md"),"utf8")).toBe("prompt");
});
test("Runner edits to the resource link are repaired, but real content there is refused",()=>{
 const first=planner.prepare(a,snapshot(a)),other=planner.prepare(b,snapshot(b));
 const link=join(first.layout.homeSource,".luna-resources");
 planner.activate(first);rmSync(link);symlinkSync(other.layout.homeSource,link);
 planner.activate(first);
 expect(readlinkSync(link)).toBe(`.luna-resource-versions/${basename(first.resourceSource)}`);
 rmSync(link);mkdirSync(link);writeFileSync(join(link,"fake"),"x");
 expect(()=>planner.activate(first)).toThrow("shadow_mount_target_invalid");
});
test("the empty mount point left by a per-version container is migrated to a link",()=>{
 const plan=planner.prepare(a,snapshot(a)),link=join(plan.layout.homeSource,".luna-resources");
 mkdirSync(link);
 planner.activate(plan);
 expect(lstatSync(link).isSymbolicLink()).toBe(true);
});
test("a Runner symlink cannot redirect the version mount target",()=>{
 const plan=planner.prepare(a,snapshot(a)),versions=join(plan.layout.homeSource,".luna-resource-versions");
 rmSync(versions,{recursive:true});symlinkSync(planner.prepare(b,snapshot(b)).layout.homeSource,versions);
 expect(()=>planner.prepare(a,snapshot(a))).toThrow("shadow_mount_target_invalid");
});
