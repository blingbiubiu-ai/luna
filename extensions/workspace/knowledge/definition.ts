import {lstatSync,mkdirSync,realpathSync,existsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import { resolve } from "node:path";

import { WorkspaceRepository } from "@/workspace/repository";

import { KNOWLEDGE_WORKSPACE_ID } from "@luna/service-client/knowledge";
export { KNOWLEDGE_WORKSPACE_ID } from "@luna/service-client/knowledge";
export const KNOWLEDGE_WORKSPACE_ROOT = "knowledge";
export const KNOWLEDGE_WORKSPACE_TARGET = "workspace:knowledge";

export const KNOWLEDGE_WORKSPACE_OPERATIONS = {
  read: "workspace.knowledge.read",
  write: "workspace.knowledge.write",
  gitCommit: "workspace.knowledge.git.commit",
} as const;

export const KNOWLEDGE_WORKSPACE_CONVENTIONS = {
  indexPath: "wiki/index.md",
  wikiGlob: "wiki/**/*.md",
  notesGlob: "notes/**/*.md",
  archiveGlob: "archive/**/*",
} as const;

export const KNOWLEDGE_WORKSPACE_ALLOWED_ROOTS = [
  "wiki",
  "notes",
  "archive",
  "policies",
] as const;

export type KnowledgeWorkspaceOperation = "read" | "write" | "git.commit";

export function knowledgeWorkspaceOperation(
  operation: KnowledgeWorkspaceOperation,
): string {
  switch (operation) {
    case "read":
      return KNOWLEDGE_WORKSPACE_OPERATIONS.read;
    case "write":
      return KNOWLEDGE_WORKSPACE_OPERATIONS.write;
    case "git.commit":
      return KNOWLEDGE_WORKSPACE_OPERATIONS.gitCommit;
  }
}

/** Each Agent has a separate Git repository; never discover a parent repository. */
export function createKnowledgeWorkspaceRepository(serviceHome: string, agentId:string): WorkspaceRepository {
  if(!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error("Invalid knowledge Agent identity");
  let root=realpathSync(serviceHome);
  for(const part of ["agents",agentId,KNOWLEDGE_WORKSPACE_ROOT]) {
    root=resolve(root,part);
    try { const stat=lstatSync(root);if(stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe knowledge root"); }
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;mkdirSync(root,{mode:0o700});}
  }
  const gitRoot=resolve(root,".git");
  if(existsSync(gitRoot)) {
    const stat=lstatSync(gitRoot);if(stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe knowledge Git directory");
  } else {
    // lstat rejects dangling links as well as links to an existing directory.
    try { lstatSync(gitRoot);throw new Error("Unsafe knowledge Git directory"); }
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const initialized=spawnSync("git",["init","--quiet",root],{encoding:"utf8",env:knowledgeGitEnvironment()});
    if(initialized.status!==0) throw new Error("Cannot initialize Agent knowledge repository");
  }
  const top=spawnSync("git",["-C",root,"rev-parse","--show-toplevel"],{encoding:"utf8",env:knowledgeGitEnvironment()});
  if(top.status!==0 || realpathSync(top.stdout.trim())!==realpathSync(root)) throw new Error("Knowledge Git repository escaped Agent root");
  return new WorkspaceRepository({workspaceId:KNOWLEDGE_WORKSPACE_ID,repoRoot:root,root,gitPath:".",
    allowedReadRoots:KNOWLEDGE_WORKSPACE_ALLOWED_ROOTS,allowedWriteRoots:KNOWLEDGE_WORKSPACE_ALLOWED_ROOTS});
}

function knowledgeGitEnvironment():NodeJS.ProcessEnv {
 return Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
}
