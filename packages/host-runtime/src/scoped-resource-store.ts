import {join} from "node:path";
import {validateScopedResources,type ResourceScope,type ResourceSelection,type ScopedResourceBundle} from "./scoped-runner-resources";
import {ImmutableResourceDirectory,type ImmutableResourceFile} from "./immutable-resource-directory";

/** Immutable download staging. Placement authorization and active mount selection belong to the caller. */
export class ScopedResourceStore {
 private readonly trees:ImmutableResourceDirectory;
 constructor(home:string){this.trees=new ImmutableResourceDirectory(home);}
 publish(input:unknown,scope:ResourceScope,selection:ResourceSelection):string {
  const bundle=validateScopedResources(input,scope,selection);
  return join(this.trees.publish(this.relative(scope,selection),this.entries(bundle),["files"]),"files");
 }
 /** Reopening after restart verifies both the manifest and every materialized byte. */
 read(scope:ResourceScope,selection:ResourceSelection):ScopedResourceBundle {
  const relative=this.relative(scope,selection);
  const bundle=validateScopedResources(JSON.parse(this.trees.read(relative,"manifest.json").toString("utf8")),scope,selection);
  this.trees.verify(relative,this.entries(bundle),["files"]);return bundle;
 }
 private relative(scope:ResourceScope,selection:ResourceSelection):string {
  for(const value of [scope.agentId,scope.shadowId])if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new Error("Invalid resource scope");
  if(!/^[a-f0-9]{64}$/.test(selection.digest))throw new Error("Invalid resource selection");
  return `agents/${scope.agentId}/shadow-resources/${scope.shadowId}/bundles/${selection.digest}`;
 }
 private entries(bundle:ScopedResourceBundle):ImmutableResourceFile[]{
  return [{path:"manifest.json",content:Buffer.from(JSON.stringify(bundle)),mode:0o400},...bundle.files.map(file=>({path:`files/${file.path}`,content:Buffer.from(file.content,"base64"),mode:(file.mode===0o755 ? 0o555 : 0o444) as 0o555|0o444}))];
 }
}
