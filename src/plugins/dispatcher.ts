import {AgentError,AgentStore,type AgentScope} from "@/agents/agent-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import {AgentPluginStore} from "./agent-plugin-store";
import { GatewayError } from "@/server/gateway-error";
import { realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runnerRootBase } from "@/shared/config/paths";

import {
  operationPolicy,
  type OperationPolicy,
} from "@/operations/operation-registry";
import type { DrizzleDB } from "@/data";
import { uuid } from "@/shared";
import { evaluateOperationPolicy } from "@/server/policy/operation-policy";
import { AuthorizationRuleStore } from "@/server/policy/authorization-rule-store";
import {
  RunnerContextStore,
  RunnerRootError,
  runnerContextRuntime,
} from "@/runners/runner-context-store";

import {
  OperationInvocationAuditStore,
  type OperationInvocationAuditStatus,
} from "./audit-store";
import type {
  OperationDefinition,
  OperationInvocationResult,
  OperationInvocationSource,
} from "./manifest";
import { PluginRegistry } from "./registry";
import {
  createPluginRuntimeContext,
  PluginHostPermissionError,
} from "./runtime-context";

export interface OperationDispatcherInput {
  readonly db: DrizzleDB;
  readonly registry: PluginRegistry;
  readonly auditStore?: OperationInvocationAuditStore;
}

export interface OperationInvokeInput {
  readonly scope?:AgentScope;
  readonly operationId: string;
  readonly input: unknown;
  readonly subject: {
    readonly userId?: string;
    readonly source: OperationInvocationSource;
  };
  readonly invocationId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly messageId?: string;
  readonly runnerContextId?: string;
  readonly validateInvocation?: () => void;
}

export type OperationDispatchResult =
  | {
    readonly status: "success";
    readonly invocationId: string;
    readonly summary: unknown;
    readonly output?: unknown;
    readonly artifacts: readonly unknown[];
  }
  | {
    readonly status: "error";
    readonly invocationId?: string;
    readonly errorCode: string;
    readonly message: string;
    readonly output?: unknown;
  };

export class OperationDispatcher {
  private readonly _auditStore: OperationInvocationAuditStore;

  constructor(private readonly _input: OperationDispatcherInput) {
    this._auditStore = _input.auditStore ??
      new OperationInvocationAuditStore(_input.db);
  }

  async invoke(input: OperationInvokeInput): Promise<OperationDispatchResult> {
    const operation = this._input.registry.getOperation(input.operationId);
    if (operation === undefined) {
      return errorResult("operation_not_found", `Operation not found: ${input.operationId}`);
    }
    const pluginId = operation.pluginId;
    if (pluginId === undefined) {
      return errorResult(
        "operation_not_plugin_backed",
        `Operation is not plugin backed: ${input.operationId}`,
      );
    }
    if (input.subject.userId === undefined) {
      return errorResult(
        "operation_subject_missing",
        `Operation invocation requires a resolved user subject: ${input.operationId}`,
      );
    }
    if(!input.scope) return errorResult("agent_scope_required","Plugin invocation requires Agent/Shadow scope");
    const scope=input.scope;
    let scopedConfig:ReturnType<AgentPluginStore["requireEnabled"]>;
    const configurations=new AgentPluginStore(this._input.db,this._input.registry);
    const validateScope=()=>{
      input.validateInvocation?.();
      new AgentStore(this._input.db).requireScope(input.subject.userId!,scope);
      const resolver=new TaskScopeResolver(this._input.db);
      if(input.sessionId) resolver.assertSame(scope,resolver.session(input.sessionId));
      if(input.taskId) resolver.assertSame(scope,resolver.task(input.taskId));
      if(input.runnerContextId){
        const context=new RunnerContextStore(this._input.db).getById(input.runnerContextId);
        if(!context) throw new AgentError("runner_context_not_found",404);
        resolver.assertSame(scope,{agentId:context.agent_id,shadowId:context.shadow_id});
      }
    };
    try {validateScope();scopedConfig=configurations.requireEnabled(scope.agentId,pluginId);}
    catch(error){return errorResult(error instanceof AgentError || error instanceof GatewayError ? error.code : error instanceof RunnerRootError ? "runner_root_mismatch" : "plugin_scope_invalid",error instanceof Error ? error.message : "Plugin scope invalid");}
    let executing=true;
    let executionRoot: string | undefined;
    const validate=()=>{
      if(!executing)throw new AgentError("plugin_invocation_inactive",409);
      validateScope();
      if (resolvePluginExecutionRoot(this._input.db, input.runnerContextId) !== executionRoot)
        throw new PluginRunnerContextError("runner_root_mismatch", "Runner root changed during the operation");
      if(configurations.requireEnabled(scope.agentId,pluginId).revision!==scopedConfig.revision) throw new AgentError("plugin_config_changed",409);
      const decision=evaluateOperationPolicy({operation:operationPolicy(operation),grants:new AuthorizationRuleStore(this._input.db,{kind:"agent",agentId:scope.agentId}).getEffectiveGrantsForUser(input.subject.userId!)});
      if(decision.decision!=="allow")throw new AgentError("operation_not_granted",403);
    };
    const invocationId = input.invocationId ?? `cinv_${uuid()}`;
    this._auditStore.recordStarted({
      scope,
      invocationId,
      operationId: operation.id,
      providerType: operation.providerType ?? "plugin",
      pluginId,
      ...(input.subject.userId === undefined
        ? {}
        : { subjectType: "user", subjectId: input.subject.userId }),
      source: input.subject.source,
      ...optionalField("sessionId", input.sessionId),
      ...optionalField("taskId", input.taskId),
      ...optionalField("messageId", input.messageId),
    });

    const plugin = this._input.registry.getPlugin(pluginId);
    if (plugin === undefined) {
      return this.reject(invocationId, "plugin_not_enabled", `Plugin is not enabled: ${pluginId}`);
    }
    const policy = operationPolicy(operation);
    const grantError = this.checkGrant(policy, {...input, invocationId});
    if (grantError !== undefined) {
      return this.reject(invocationId, grantError, "operation grant missing");
    }
    const validationError = validateInputSchema(operation, input.input);
    if (validationError !== undefined) {
      return this.completeError(invocationId, "invalid_input", validationError);
    }

    try {
      executionRoot = resolvePluginExecutionRoot(
        this._input.db,
        input.runnerContextId,
      );
      const runtime = plugin.createRuntime({
        manifest: plugin.manifest,
        config: scopedConfig.config,
      });
      const invocationInput = {
        operationId: operation.id,
        input: input.input,
        source: input.subject.source,
        ...optionalField("subjectId", input.subject.userId),
        runtimeContext: createPluginRuntimeContext({
          db: this._input.db,
          scope,validate,
          ...(input.runnerContextId ? {resourceOwner:(()=>{const ctx=new RunnerContextStore(this._input.db).getById(input.runnerContextId!)!;return {type:ctx.owner_type,id:ctx.owner_id};})()} : {}),
          secret:key=>configurations.secret(scope.agentId,pluginId,scopedConfig.revision,key),
          hostPermissions: plugin.manifest.requestedHostPermissions,
          manifest: plugin.manifest,
          config: scopedConfig.config,
          invocation: {
            pluginId,
            operationId: operation.id,
            invocationId,
            subject: input.subject,
            ...optionalField("messageId", input.messageId),
          },
          ...optionalField("executionRoot", executionRoot),
        }),
      };
      const result = await runtime.invoke({
        ...invocationInput,
      });
      validate();
      this._auditStore.recordCompleted(invocationId, {
        status: result.status === "success" ? "success" : "error",
        artifactCount: result.artifacts.length,
        ...(result.status === "success" ? {} : { errorCode: "plugin_error" }),
      });
      return result.status === "success"
        ? successResult(invocationId, result)
        : {
          status: "error",
          invocationId,
          errorCode: "plugin_error",
          message: pluginFailureMessage(result),
          ...(result.output === undefined ? {} : { output: result.output }),
        };
    } catch (error) {
      return this.completeError(
        invocationId,
        error instanceof PluginHostPermissionError || error instanceof AgentError || error instanceof GatewayError
          ? error.code
          : error instanceof PluginRunnerContextError
            ? error.code
          : "plugin_exception",
        error instanceof Error ? error.message : "Plugin operation failed",
      );
    } finally {executing=false;}
  }

  private checkGrant(
    policy: OperationPolicy,
    input: OperationInvokeInput,
  ): string | undefined {
    const grants = new AuthorizationRuleStore(this._input.db,{kind:"agent",agentId:input.scope!.agentId})
      .getEffectiveGrantsForUser(input.subject.userId!);
    const decision = evaluateOperationPolicy({
      operation: policy,
      grants,
    });
    this._auditStore.recordAuthorization(input.invocationId!, decision);
    return decision.decision === "allow"
      ? undefined
      : "operation_not_granted";
  }

  private reject(
    invocationId: string,
    errorCode: string,
    message: string,
  ): OperationDispatchResult {
    this._auditStore.recordCompleted(invocationId, {
      status: "rejected" as Exclude<OperationInvocationAuditStatus, "started">,
      errorCode,
      artifactCount: 0,
    });
    return {
      status: "error",
      invocationId,
      errorCode,
      message,
    };
  }

  private completeError(
    invocationId: string,
    errorCode: string,
    message: string,
  ): OperationDispatchResult {
    this._auditStore.recordCompleted(invocationId, {
      status: "error",
      errorCode,
      artifactCount: 0,
    });
    return {
      status: "error",
      invocationId,
      errorCode,
      message,
    };
  }
}

class PluginRunnerContextError extends Error {
  constructor(
    readonly code:
      | "runner_context_not_found"
      | "runner_root_unavailable"
      | "runner_root_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "PluginRunnerContextError";
  }
}

function resolvePluginExecutionRoot(
  db: DrizzleDB,
  runnerContextId: string | undefined,
): string | undefined {
  if (runnerContextId === undefined) {
    return undefined;
  }

  let context;
  try {
    context = new RunnerContextStore(db).getById(runnerContextId);
  } catch (error) {
    if (error instanceof RunnerRootError) {
      throw new PluginRunnerContextError("runner_root_mismatch", error.message);
    }
    throw error;
  }
  if (context === undefined) {
    throw new PluginRunnerContextError(
      "runner_context_not_found",
      `Runner context "${runnerContextId}" was not found.`,
    );
  }

  const runtime = runnerContextRuntime(db);
  const prepared = runtime?.preparedContext?.(runnerContextId);
  if (runtime && !prepared) throw new PluginRunnerContextError("runner_root_unavailable", "Runner context has not been prepared by the Worker");
  if (prepared && (prepared.scope.agentId !== context.agent_id || prepared.scope.shadowId !== context.shadow_id))
    throw new PluginRunnerContextError("runner_root_mismatch", "Prepared Runner root belongs to another Shadow");
  if (prepared?.local === false) return undefined;

  let physicalRoot: string;
  let expectedRoot: string;
  try {
    physicalRoot = realpathSync(prepared?.cwd ?? context.runner_root_path);
    expectedRoot = prepared?.cwd ?? join(realpathSync(runnerRootBase), relative(runnerRootBase, context.runner_root_path));
    if (!statSync(physicalRoot).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new PluginRunnerContextError(
      "runner_root_unavailable",
      `Runner root "${context.runner_root_path}" is unavailable.`,
    );
  }
  if (physicalRoot !== expectedRoot) throw new PluginRunnerContextError("runner_root_mismatch", "Runner root resolves through a different directory");
  return physicalRoot;
}

function successResult(
  invocationId: string,
  result: OperationInvocationResult,
): OperationDispatchResult {
  return {
    status: "success",
    invocationId,
    summary: result.summary,
    ...(result.output === undefined ? {} : { output: result.output }),
    artifacts: result.artifacts,
  };
}

function pluginFailureMessage(result: OperationInvocationResult): string {
  if (isRecord(result.output)) {
    const stderr = result.output.stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) {
      return stderr.trim();
    }
  }
  return "Plugin operation invocation failed";
}

function errorResult(errorCode: string, message: string): OperationDispatchResult {
  return { status: "error", errorCode, message };
}

function validateInputSchema(
  operation: OperationDefinition,
  input: unknown,
): string | undefined {
  const schema = operation.inputSchema;
  if (!isRecord(schema)) {
    return undefined;
  }
  if (schema.type === "object" && !isRecord(input)) {
    return "Operation input must be an object.";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]: V } | {} {
  return value === undefined ? {} : { [key]: value } as { [P in K]: V };
}
