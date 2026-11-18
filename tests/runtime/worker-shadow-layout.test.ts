import {Database} from "bun:sqlite";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync,symlinkSync,realpathSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {WorkerShadowLayouts} from "../../apps/worker/src/shadow-layout";
let root:string,db:Database,layouts:WorkerShadowLayouts;
const a={agentId:"agent-a",shadowId:"shadow-a"},b={agentId:"agent-a",shadowId:"shadow-b"},c={agentId:"agent-b",shadowId:"shadow-c"};
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),"luna-shadow-layout-")));db=new Database(join(root,"worker.sqlite"));db.exec("PRAGMA foreign_keys=ON");layouts=new WorkerShadowLayouts(db,root);});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
test("three Shadows have separate HOME, nested runners and sibling protected resources",()=>{
 const results=[a,b,c].map(scope=>layouts.ensure(scope));
 for(const layout of results){
  expect(layout.homeSource).toBe(join(root,"agents",layout.agentId,"shadows",layout.shadowId));
  expect(layout.home).toBe("/home/luna");expect(layout.runners).toBe("/home/luna/runners");
  expect(layout.runnersSource).toBe(join(layout.homeSource,"runners"));
  expect(layout.credentials.startsWith(layout.homeSource+"/")).toBe(false);
  expect(layout.resourceRoot).toBe(join(root,"agents",layout.agentId,"shadow-resources",layout.shadowId));
  expect(layouts.executorDirectory(layout,"env_test")).toBe(join(layout.resourceRoot,"environments","env_test"));
 }
 expect(new Set(results.map(x=>x.homeSource)).size).toBe(3);
 expect(existsSync(join(results[0]!.homeSource,"runner-home"))).toBe(false);
});
test("persists fixed context ownership and refuses cross-Shadow reuse after restart",()=>{
 layouts.ensure(a);layouts.ensure(b);
 const first=layouts.context(a,"ctx-a");expect(first.cwd).toBe(join(first.layout.runnersSource,"ctx-a"));
 expect(first.containerCwd).toBe("/home/luna/runners/ctx-a");
 expect(layouts.context(a,"ctx-b").cwd).not.toBe(first.cwd);
 db.close();db=new Database(join(root,"worker.sqlite"));layouts=new WorkerShadowLayouts(db,root);
 expect(layouts.context(a,"ctx-a")).toEqual(first);
 expect(()=>layouts.context(b,"ctx-a")).toThrow("context_shadow_conflict");
 expect(()=>layouts.ensure({...a,agentId:"other-agent"})).toThrow("shadow_layout_conflict");
 rmSync(first.cwd,{recursive:true});expect(()=>layouts.context(a,"ctx-a")).toThrow("context_storage_missing");
});
test("missing persisted HOME is an error, not a silent empty replacement",()=>{
 const first=layouts.ensure(a);rmSync(first.homeSource,{recursive:true});
 expect(()=>layouts.ensure(a)).toThrow("shadow_storage_missing");
 expect(existsSync(first.homeSource)).toBe(false);
});
test("container paths map only paths inside the Shadow HOME",async()=>{
 const {containerPath}=await import("../../apps/worker/src/shadow-layout");
 const layout=layouts.ensure(a);
 expect(containerPath(layout,layout.homeSource)).toBe("/home/luna");
 expect(containerPath(layout,join(layout.homeSource,"runners/x"))).toBe("/home/luna/runners/x");
 expect(()=>containerPath(layout,layout.resourceRoot)).toThrow("shadow_directory_unsafe");
 expect(()=>containerPath(layout,join(layout.homeSource,".."))).toThrow("shadow_directory_unsafe");
});
test("rejects traversal and symlinked HOME, contexts and control directories",()=>{
 expect(()=>layouts.ensure({...a,shadowId:"../bad"})).toThrow("invalid_shadow_path_id");
 expect(()=>layouts.executorDirectory(a,"../bad")).toThrow("invalid_shadow_path_id");
 const first=layouts.ensure(a);layouts.ensure(b);
 symlinkSync(layouts.ensure(b).homeSource,join(first.runnersSource,"ctx"));
 expect(()=>layouts.context(a,"ctx")).toThrow("shadow_directory_unsafe");
 rmSync(first.homeSource,{recursive:true});symlinkSync(layouts.ensure(b).homeSource,first.homeSource);
 expect(()=>layouts.ensure(a)).toThrow("shadow_directory_unsafe");
 rmSync(join(root,"agents"),{recursive:true});symlinkSync(tmpdir(),join(root,"agents"));
 expect(()=>layouts.ensure(c)).toThrow("shadow_directory_unsafe");
});
