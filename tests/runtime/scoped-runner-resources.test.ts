import {expect,test} from "bun:test";
import {createScopedResources,validateScopedResources} from "@luna/host-runtime/scoped-runner-resources";
const scope={agentId:"agent-a",shadowId:"shadow-a"};
const file=(path:string,content="hello",mode=0o644)=>({path,content:Buffer.from(content).toString("base64"),mode});
test("resource revisions are deterministic, partitioned and bound to scope",()=>{
 const files=[file("shadow/config/SOUL.md"),file("agent/memory/note.md"),file("public/skills/test.md"),file("agent/tools/commands/test", "run",0o755)];
 const a=createScopedResources(scope,files),reordered=createScopedResources(scope,[...files].reverse());
 expect(reordered).toEqual(a);
 const shadow=createScopedResources({...scope,shadowId:"shadow-b"},files);
 expect(shadow.selection.publicRevision).toBe(a.selection.publicRevision);
 expect(shadow.selection.agentMemoryRevision).toBe(a.selection.agentMemoryRevision);
 expect(shadow.selection.agentToolsRevision).toBe(a.selection.agentToolsRevision);
 expect(shadow.selection.shadowConfigRevision).not.toBe(a.selection.shadowConfigRevision);
 expect(shadow.selection.digest).not.toBe(a.selection.digest);
 const agent=createScopedResources({...scope,agentId:"agent-b"},files);
 expect(agent.selection.agentMemoryRevision).not.toBe(a.selection.agentMemoryRevision);
 expect(agent.selection.agentToolsRevision).not.toBe(a.selection.agentToolsRevision);
 expect(validateScopedResources(a,scope,a.selection)).toEqual(a);
});
test("empty resources have explicit scoped revisions",()=>{
 const a=createScopedResources(scope,[]);
 expect(Object.values(a.selection).every(x=>/^[a-f0-9]{64}$/.test(x))).toBe(true);
 expect(()=>validateScopedResources(a,{...scope,shadowId:"other"},a.selection)).toThrow("scope");
 expect(()=>validateScopedResources(a,scope,{...a.selection,digest:"0".repeat(64)})).toThrow("selection");
});
test("rejects legacy, tampered, extra and incomplete manifests",()=>{
 const a=createScopedResources(scope,[file("agent/memory/a")]);
 for(const invalid of [{revision:a.selection.digest,files:a.files},{...a,version:1},{...a,secret:"bad"},{...a,selection:{...a.selection,extra:1}},{...a,files:[file("agent/memory/a","changed")]},{...a,files:[{...a.files[0],secret:"bad"}]},null]){
  expect(()=>validateScopedResources(invalid,scope,a.selection)).toThrow();
 }
});
test("rejects traversal, ambiguous paths, noncanonical encodings and special modes",()=>{
 for(const path of ["agent/memory/../x","/public/a","public//a","agent/credentials/key","shadow/config/../../x","public/a\\b","public/a\n","public/.","public/é","public/e\u0301"]){
  if(path==="public/é") continue;
  expect(()=>createScopedResources(scope,[file(path)])).toThrow();
 }
 for(const files of [[file("public/a"),file("public/a/b")],[file("public/A"),file("public/a")],[file("public/A/one"),file("public/a/two")],[file("public/a"),file("public/a")],[{...file("public/a"),content:"Zh=="}],[file("public/a","x",0o777)]]) expect(()=>createScopedResources(scope,files)).toThrow();
 expect(()=>createScopedResources({agentId:"../other",shadowId:"s"},[])).toThrow();
});

import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync,symlinkSync,existsSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {ScopedResourceStore} from "@luna/host-runtime/scoped-resource-store";
test("publishes immutable versions, retains old snapshots and verifies after restart",()=>{
 const home=mkdtempSync(join(tmpdir(),"luna-resources-"));
 try{
  const store=new ScopedResourceStore(home),first=createScopedResources(scope,[file("agent/memory/a","old")]);
  const path=store.publish(first,scope,first.selection);
  const next=createScopedResources(scope,[file("agent/memory/a","new")]);
  const nextPath=store.publish(next,scope,next.selection);
  expect(path).not.toBe(nextPath);
  expect(readFileSync(join(path,"agent/memory/a"),"utf8")).toBe("old");
  expect(store.publish(first,scope,first.selection)).toBe(path);
  expect(new ScopedResourceStore(home).read(scope,next.selection)).toEqual(next);
  const other={...scope,shadowId:"shadow-b"},otherBundle=createScopedResources(other,first.files);
  expect(store.publish(otherBundle,other,otherBundle.selection)).not.toBe(path);
  expect(()=>store.publish(first,other,first.selection)).toThrow("scope");
  chmodSync(join(path,"agent/memory/a"),0o644);writeFileSync(join(path,"agent/memory/a"),"tampered");
  expect(()=>store.read(scope,first.selection)).toThrow("integrity");
  expect(()=>store.publish(first,scope,first.selection)).toThrow("integrity");
  expect(store.read(scope,next.selection)).toEqual(next);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test("rejects symlink roots and corrupt manifest without overwriting targets",()=>{
 const home=mkdtempSync(join(tmpdir(),"luna-resources-")),outside=mkdtempSync(join(tmpdir(),"luna-outside-"));
 try{
  const store=new ScopedResourceStore(home),bundle=createScopedResources(scope,[file("public/skill.md")]);
  symlinkSync(outside,join(home,"agents"));
  expect(()=>store.publish(bundle,scope,bundle.selection)).toThrow("Unsafe");
  expect(existsSync(join(outside,scope.agentId))).toBe(false);
  rmSync(join(home,"agents"));
  const path=store.publish(bundle,scope,bundle.selection),manifest=join(dirname(path),"manifest.json");
  rmSync(manifest);writeFileSync(join(outside,"manifest.json"),JSON.stringify(bundle));symlinkSync(join(outside,"manifest.json"),manifest);
  expect(()=>store.read(scope,bundle.selection)).toThrow("Unsafe");
  expect(()=>store.publish(bundle,scope,bundle.selection)).toThrow("Unsafe");
 }finally{rmSync(home,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
