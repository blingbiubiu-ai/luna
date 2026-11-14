import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {fixtureScope} from "../helpers/platform-fixtures";
import {AgentStore} from "@/agents/agent-store";
import {AgentDocumentStore} from "@/agents/agent-document-store";
import {PluginRegistry} from "@/plugins/registry";
import {AgentPluginStore} from "@/plugins/agent-plugin-store";
import {AgentSecretCipher} from "@/agent-config/secret-cipher";
import {AgentResourceBuilder} from "@/runners/agent-resource-builder";
let home:string,connection:DataConnection<typeof schema>,registry:PluginRegistry,builder:AgentResourceBuilder,plugins:AgentPluginStore;
let a:ReturnType<typeof fixtureScope>,b:ReturnType<typeof fixtureScope>;
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-resource-builder-"));setLunaHome(home);connection=new DataConnection(schema);
 a=fixtureScope(connection.db,"alice");b=fixtureScope(connection.db,"bob");registry=new PluginRegistry();
 mkdirSync(join(home,"public-skills"));mkdirSync(join(home,"public-prompts"));writeFileSync(join(home,"public-prompts","MAIN.md"),"platform-template");
 writeFileSync(join(home,"shim"),"#!/bin/sh\necho hello");
 registry.registerPlugin({id:"alpha",displayName:"Alpha",version:"1",source:"bundled",agentScopeVersion:2,requestedHostPermissions:[],operations:[],
  skills:[{id:"alpha-help",description:"Alpha instructions"}],containerCommands:[{binary:"alpha",commandPath:["alpha"],shimScript:join(home,"shim")}]},
  ()=>({invoke:async()=>({status:"success",summary:{},artifacts:[]})}),{token:"global-secret"});
 plugins=new AgentPluginStore(connection.db,registry,AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:Buffer.alloc(32,9).toString("base64")}));
 builder=new AgentResourceBuilder(connection.db,home,registry,{bundledSkillsDirectory:join(home,"public-skills"),promptAssetsDirectory:join(home,"public-prompts"),repoRoot:home});
});
afterEach(()=>{connection.close();rmSync(home,{recursive:true,force:true});});
const contents=(bundle:ReturnType<AgentResourceBuilder["capture"]>)=>Object.fromEntries(bundle.files.map(f=>[f.path,Buffer.from(f.content,"base64").toString()]));
test("captures only enabled Agent tools, without global or Agent config and secrets",()=>{
 plugins.put("alice",a.agentId,"alpha",{expectedRevision:null,enabled:true,config:{hidden:"config-private"},secrets:{TOKEN:"alice-secret"}});
 const first=builder.capture("alice",a),second=builder.capture("bob",b);
 expect(Object.keys(contents(first))).toContain("agent/tools/skills/alpha-help/SKILL.md");
 expect(Object.keys(contents(first))).toContain("agent/tools/commands/alpha");
 expect(contents(second)["agent/tools/catalog.json"]).toBe("[]");
 for(const secret of ["global-secret","config-private","alice-secret","ciphertext"]){expect(JSON.stringify(contents(first))).not.toContain(secret);}
 expect(first.selection.publicRevision).toBe(second.selection.publicRevision);
 expect(first.selection.agentToolsRevision).not.toBe(second.selection.agentToolsRevision);
 expect(builder.capture("alice",a)).toEqual(first);
 const current=plugins.get("alice",a.agentId,"alpha");plugins.put("alice",a.agentId,"alpha",{expectedRevision:current.revision,enabled:false,config:{}});
 expect(Object.keys(contents(builder.capture("alice",a)))).not.toContain("agent/tools/commands/alpha");
 expect(Object.keys(contents(first))).toContain("agent/tools/commands/alpha");
});
test("same Agent shares memory while Shadow persona and snapshots remain independent",()=>{
 const shadows=new AgentStore(connection.db),other=shadows.createShadow("alice",a.agentId,{name:"Other"},"other-shadow");
 const scope={agentId:a.agentId,shadowId:other.id},documents=new AgentDocumentStore(connection.db,home);
 const initial=builder.capture("alice",a);
 expect(contents(initial)["shadow/config/USER.md"]).toBe("");expect(contents(initial)["shadow/config/SOUL.md"]).toBe("");
 documents.writeMemory("alice",a.agentId,{expectedRevision:null,path:"remember.md",content:"shared-memory"});
 documents.writePersona("alice",scope,{expectedRevision:documents.persona("alice",scope).revision!,user:"other-user",soul:"other-soul"});
 const first=builder.capture("alice",a),second=builder.capture("alice",scope);
 expect(first.selection.agentMemoryRevision).toBe(second.selection.agentMemoryRevision);
 expect(first.selection.agentToolsRevision).toBe(second.selection.agentToolsRevision);
 expect(contents(first)["agent/memory/remember.md"]).toBe("shared-memory");
 expect(contents(second)["shadow/config/SOUL.md"]).toBe("other-soul");
 expect(contents(first)["shadow/config/SOUL.md"]).toBe("");
 expect(contents(initial)["agent/memory/remember.md"]).toBeUndefined();
 expect(contents(builder.capture("bob",b))["agent/memory/remember.md"]).toBeUndefined();
});
test("accepts a Feishu participant and requires valid Shadow scope and rejects forged Shadow scope",()=>{
 expect(()=>builder.capture("bob",a)).not.toThrow();
 expect(()=>builder.capture("alice",{agentId:a.agentId,shadowId:b.shadowId})).toThrow("scope_mismatch");
});
test("changing plugin configuration changes only tools selection",()=>{
 const saved=plugins.put("alice",a.agentId,"alpha",{expectedRevision:null,enabled:true,config:{}});
 const first=builder.capture("alice",a);
 plugins.put("alice",a.agentId,"alpha",{expectedRevision:saved.revision,enabled:true,config:{setting:"new"}});
 const next=builder.capture("alice",a);
 expect(first.selection.agentToolsRevision).not.toBe(next.selection.agentToolsRevision);
 expect(first.selection.agentMemoryRevision).toBe(next.selection.agentMemoryRevision);
 expect(first.selection.shadowConfigRevision).toBe(next.selection.shadowConfigRevision);
});
test("rejects symlinks in source trees instead of packaging files outside the explicit source",()=>{
 writeFileSync(join(home,"secret"),"private");symlinkSync(join(home,"secret"),join(home,"public-skills","leak"));
 expect(()=>builder.capture("alice",a)).toThrow("Unsafe runner resource source");
});

test("rejects plugin and platform skill collisions before publication",()=>{
 mkdirSync(join(home,"public-skills","alpha-help"));writeFileSync(join(home,"public-skills","alpha-help","SKILL.md"),"public");
 plugins.put("alice",a.agentId,"alpha",{expectedRevision:null,enabled:true,config:{}});
 expect(()=>builder.capture("alice",a)).toThrow("Duplicate bundled/plugin skill");
});
