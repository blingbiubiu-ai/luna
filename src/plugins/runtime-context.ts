import {TaskScopeResolver} from "@/agents/task-scope";
import {SessionAccessPolicy} from "@/agents/session-access";
import {TaskAccessPolicy} from "@/agents/task-access";
import {AgentError,type AgentScope} from "@/agents/agent-store";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join,relative,isAbsolute } from "node:path";

import type {
  ArtifactAttributionInput,
  RegisterArtifactContentInput,
  RegisterArtifactInput,
} from "@/artifacts/artifact-registry";
import { ArtifactRegistry } from "@/artifacts/artifact-registry";
import { parseArtifactRef } from "@luna/service-client/artifact-ref";
import type { DrizzleDB } from "@/data";
import { config, createLogger, uuid } from "@/shared";
import type {
  HostPermission,
  PluginInvocationIdentity,
  PluginRuntimeContext,
} from "@luna/plugin-contracts";

export class PluginHostPermissionError extends Error {
  readonly code = "host_permission_denied";

  constructor(
    readonly pluginId: string,
    readonly permission: HostPermission,
  ) {
    super(
      `Plugin "${pluginId}" lacks required host permission "${permission}".`,
    );
    this.name = "PluginHostPermissionError";
  }
}

export function createPluginRuntimeContext(input: {
  readonly db: DrizzleDB;
  readonly scope?:AgentScope;
  readonly resourceOwner?:{type:string;id:string};
  readonly validate?:()=>void;
  readonly secret?:(key:string)=>string|undefined;
  readonly invocation: PluginInvocationIdentity;
  readonly hostPermissions: readonly HostPermission[];
  readonly manifest: {
    readonly allowedExecutables?: readonly string[];
    readonly allowedEnvKeys?: readonly string[];
  };
  readonly config?: unknown;
  readonly executionRoot?: string;
}): PluginRuntimeContext {
  if(!input.scope || !input.validate) throw new AgentError("plugin_scope_required",400);
  const scope=input.scope,validate=input.validate;
  validate();
  const registry = new ArtifactRegistry(input.db);
  const attribution = artifactAttribution(input.invocation);
  const logger = createLogger(`plugin:${input.invocation.pluginId}`);
  const workspaceRoot = join(
    config.paths.home,
    "agents",scope.agentId,"shadows",scope.shadowId,"plugins",
    "workspaces",
    input.invocation.pluginId,
    input.invocation.invocationId,
  );
  const requireArtifactOwner=(type:string,id:string)=>{
    validate();new TaskScopeResolver(input.db).assertSame(scope,new TaskScopeResolver(input.db).owner(type,id));
    if(input.invocation.subject.source.endsWith("_runner")) {
      if(input.resourceOwner?.type!==type || input.resourceOwner.id!==id)throw new AgentError("plugin_artifact_owner_denied",403);
    } else {
      const actor=input.invocation.subject.userId;if(!actor)throw new AgentError("plugin_subject_missing",403);
      if(type==="session")new SessionAccessPolicy(input.db).requireAccess(actor,id);
      else new TaskAccessPolicy(input.db).requireAccess(actor,id);
    }
  };
  return {
    scope,
    secrets:{get:key=>{validate();return input.secret?.(key);}},
    invocation: input.invocation,
    config: input.config ?? {},
    logger: {
      info: (logInput, message) => logger.info(logInput, message),
      warn: (logInput, message) => logger.warn(logInput, message),
      error: (logInput, message) => logger.error(logInput, message),
    },
    workspace: {
      tempDir: ({ prefix }) => {
        validate();
        requireHostPermission(input, "workspace.tempFile");
        const path = join(workspaceRoot, `${safePathPart(prefix)}-${uuid()}`);
        mkdirSync(path, { recursive: true });
        return path;
      },
      tempFile: ({ prefix, suffix = "" }) => {
        validate();
        requireHostPermission(input, "workspace.tempFile");
        mkdirSync(workspaceRoot, { recursive: true });
        const path = join(
          workspaceRoot,
          `${safePathPart(prefix)}-${uuid()}${safeSuffix(suffix)}`,
        );
        writeFileSync(path, new Uint8Array());
        return path;
      },
    },
    artifacts: {
      registerContent: (artifact) => {
        validate();
        requireHostPermission(input, "artifact.create");
        requireArtifactOwner(artifact.scopeType,artifact.scopeId);
        return registry.registerContent({
          ...artifact,
          producer: `plugin:${input.invocation.pluginId}`,
          ...optionalField("relatedUserId", input.invocation.subject.userId),
          attribution,
        });
      },
      registerLocalFile: (artifact) => {
        validate();
        requireHostPermission(input, "artifact.create");
        requireArtifactOwner(artifact.scopeType,artifact.scopeId);
        const path=realpathSync(artifact.path);
        if(![workspaceRoot,...(input.executionRoot ? [input.executionRoot] : [])].some(root=>{
          try {const rel=relative(realpathSync(root),path);return rel!==".." && !rel.startsWith("../") && !isAbsolute(rel);}catch{return false;}
        }))throw new AgentError("plugin_artifact_path_denied",403);
        return registry.registerLocalFile({
          ...artifact,
          producer: `plugin:${input.invocation.pluginId}`,
          ...optionalField("relatedUserId", input.invocation.subject.userId),
          attribution,
        });
      },
      materializeLocalFile: ({ ref }) => {
        validate();
        requireHostPermission(input, "artifact.materialize");
        const artifactId = parseArtifactRef(ref);
        if (artifactId === undefined) {
          throw new Error(`Invalid artifact ref: ${ref}`);
        }
        const artifact = registry.getActive(artifactId);
        if (artifact === undefined) {
          throw new Error(`Artifact not found: ${ref}`);
        }
        requireArtifactOwner(artifact.scope_type,artifact.scope_id);
        return {
          artifactId,
          path: artifact.storage_key,
          name: artifact.name,
          mimeType: artifact.mime_type,
          sizeBytes: artifact.size_bytes,
        };
      },
    },
    host: {
      exec: ({ cmd, args, stdin, env }) =>
        new Promise((resolve, reject) => {
          validate();
          requireHostPermission(input, "host.exec");
          const allowed = input.manifest.allowedExecutables ?? [];
          if (!allowed.includes(cmd)) {
            reject(new Error(`Executable not allowed: ${cmd}`));
            return;
          }
          const allowedEnv = input.manifest.allowedEnvKeys ?? [];
          mkdirSync(workspaceRoot,{recursive:true});
          const childEnv: Record<string, string> = {PATH:process.env.PATH ?? "/usr/bin:/bin",HOME:workspaceRoot,LANG:"C.UTF-8"};
          if (env !== undefined) {
            for (const key of Object.keys(env)) {
              if (allowedEnv.includes(key) && !["HOME","LUNA_HOME","LUNA_AGENT_CONFIG_MASTER_KEY","LUNA_ACCESS_TOKEN_SECRET"].includes(key)) {
                childEnv[key] = env[key] as string;
              }
            }
          }
          validate();
          const child = spawn(cmd, [...args], {
            cwd:input.executionRoot ?? workspaceRoot,
            env: childEnv,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
          child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
          child.on("error", reject);
          child.on("close", (code) => {
            resolve({ exitCode: code ?? -1, stdout, stderr });
          });
          if (stdin !== undefined && stdin.length > 0) {
            child.stdin?.end(stdin);
          } else {
            child.stdin?.end();
          }
        }),
    },
  };
}

function requireHostPermission(
  input: {
    readonly invocation: PluginInvocationIdentity;
    readonly hostPermissions: readonly HostPermission[];
  },
  permission: HostPermission,
): void {
  if (!input.hostPermissions.includes(permission)) {
    throw new PluginHostPermissionError(
      input.invocation.pluginId,
      permission,
    );
  }
}

function artifactAttribution(
  invocation: PluginInvocationIdentity,
): ArtifactAttributionInput {
  return {
    pluginId: invocation.pluginId,
    operationId: invocation.operationId,
    invocationId: invocation.invocationId,
    source: invocation.subject.source,
    ...optionalField("subjectId", invocation.subject.userId),
    ...optionalField("messageId", invocation.messageId),
  };
}

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]: V } | {} {
  return value === undefined ? {} : { [key]: value } as { [P in K]: V };
}

function safePathPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return safe.length === 0 ? "tmp" : safe;
}

function safeSuffix(value: string): string {
  if (value.length === 0) {
    return "";
  }
  return value.startsWith(".") ? safePathPart(value) : `.${safePathPart(value)}`;
}
