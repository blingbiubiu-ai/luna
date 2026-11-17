import {afterEach,expect,test} from "bun:test";
import {chmodSync,existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createScopedResources,type ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import {ScopedResourceStore} from "@luna/host-runtime/scoped-resource-store";
import {materializeShadowMountSources} from "@luna/host-runtime/shadow-resource-mounts";
const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const scope={agentId:"agent-a",shadowId:"shadow-a"};
const file=(path:string,content="data",mode=0o644)=>({path,content:Buffer.from(content).toString("base64"),mode});
function fixture(files:ReturnType<typeof file>[],owner:ResourceScope=scope,home=mkdtempSync(join(tmpdir(),"shadow-mounts-"))){
 if(!homes.includes(home))homes.push(home);
 const bundle=createScopedResources(owner,files);new ScopedResourceStore(home).publish(bundle,owner,bundle.selection);
 return {home,bundle,mount:()=>materializeShadowMountSources(home,owner,bundle.selection)};
}
test("merges approved tools and prompts outside writable HOME",()=>{
 const f=fixture([file("public/skills/base/SKILL.md","public"),file("agent/tools/skills/plugin/SKILL.md","agent"),
  file("agent/tools/commands/runtime/cli.js","script",0o755),file("agent/tools/catalog.json","{}"),
  file("public/prompts/main-runner/instructions.md","role")]);
 const mounts=f.mount();
 expect(readFileSync(join(join(mounts,"skills","skills"),"base/SKILL.md"),"utf8")).toBe("public");
 expect(readFileSync(join(join(mounts,"skills","skills"),"plugin/SKILL.md"),"utf8")).toBe("agent");
 expect(readFileSync(join(join(mounts,"prompts"),"main-runner/instructions.md"),"utf8")).toBe("role");
 expect(readdirSync(mounts).sort()).toEqual([".agents","commands","prompts","skills","tools"]);
 expect(statSync(join(join(mounts,"commands"),"runtime/cli.js")).mode&0o777).toBe(0o555);
 expect(statSync(join(join(mounts,"prompts"),"main-runner/instructions.md")).mode&0o777).toBe(0o444);
 expect(mounts.startsWith(join(realpathSync(f.home),"agents/agent-a/shadow-resources/shadow-a/mounts/v4")+"/")).toBe(true);
 expect(statSync(mounts).mode&0o777).toBe(0o755);
 expect(existsSync(join(f.home,"agents/agent-a/shadows"))).toBe(false);
 expect(f.mount()).toEqual(mounts);
});
test("empty roots are materialized and older versions and other scopes remain independent",()=>{
 const first=fixture([file("public/prompts/history.md","old")]),old=first.mount();
 const next=fixture([file("public/prompts/history.md","new")],scope,first.home).mount();
 const other=fixture([file("agent/tools/commands/other","other",0o755)],{...scope,shadowId:"shadow-b"},first.home).mount();
 const foreign=fixture([],{agentId:"agent-b",shadowId:"shadow-c"},first.home).mount();
 expect(readFileSync(join(join(old,"prompts"),"history.md"),"utf8")).toBe("old");
 expect(readFileSync(join(join(next,"prompts"),"history.md"),"utf8")).toBe("new");
 expect(readdirSync(join(old,"commands"))).toEqual([]);
 expect(readdirSync(join(other,"prompts"))).toEqual([]);
 expect(readdirSync(join(foreign,"commands"))).toEqual([]);
 expect(new Set([join(old,"prompts"),join(next,"prompts"),join(other,"prompts"),join(foreign,"prompts")]).size).toBe(4);
});
test("rejects collisions introduced by merging public and Agent tool trees",()=>{
 for(const pair of [["a","a"],["a","a/b"],["a/b","a"],["A/one","a/two"]]){
  const f=fixture([file(`public/skills/${pair[0]}`),file(`agent/tools/skills/${pair[1]}`)]);
  expect(f.mount).toThrow("Conflicting");
 }
 expect(fixture([file("public/unknown")]).mount).toThrow("Unsupported");
});
test("refuses tampered or symlink mount views instead of repairing active snapshots",()=>{
 const f=fixture([file("public/prompts/history.md","original")]),mounts=f.mount(),path=join(join(mounts,"prompts"),"history.md");
 chmodSync(path,0o644);writeFileSync(path,"modified");expect(f.mount).toThrow("integrity");
 expect(readFileSync(path,"utf8")).toBe("modified");
 rmSync(path);symlinkSync(join(join(mounts,"commands"),"USER.md"),path);expect(f.mount).toThrow("Unsafe");
});
