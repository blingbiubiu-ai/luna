import {GatewayError} from "../gateway-error";
import {AgentPluginStore} from "@/plugins/agent-plugin-store";
import {pluginRequestScope} from "../policy/plugin-scope";
import {AgentError} from "@/agents/agent-store";
import { operationDispatchStatus } from "@/plugins/dispatch-status";
import { Hono } from "hono";

import { PluginCommandInputError } from "@luna/plugin-contracts";

import type { DrizzleDB } from "@/data";
import {
  OperationDispatcher,
  type OperationInvocationSource,
  PluginRegistry,
  type CommandContribution,
} from "@/plugins";
import type { PluginMarketplaceService } from "@/plugins/marketplace/marketplace-service";
import {
  dashboardAuthSessionFromContext,
  lunaAccessTokenClaimsFromContext,
} from "../auth";
import { getKernel } from "./kernel";
import { createPluginMarketplaceRoutes } from "./plugin-marketplace";

export interface PluginsRouteOptions {
  readonly db?: DrizzleDB;
  readonly registry?: PluginRegistry;
  readonly marketplaceService?: PluginMarketplaceService;
}

export function createPluginsRoutes(options: PluginsRouteOptions = {}) {
  const getRegistry = () => options.registry ?? defaultPluginRegistry();
  const getDb = () => options.db ?? maybeKernelDb();
  return new Hono()
    .route(
      "/",
      createPluginMarketplaceRoutes({
        ...(options.db === undefined ? {} : { db: options.db }),
        ...(options.marketplaceService === undefined
          ? {}
          : { service: options.marketplaceService }),
      }),
    )
    .post("/commands/resolve-and-invoke", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const request = parseCommandRequest(body);
      if (request === undefined) {
        return c.json({
          status: "error",
          code: "invalid_request",
          message: "path and args are required",
        }, 400);
      }
      const registry = getRegistry();
      if (request.help) {
        const help = resolvePluginCommandHelp(registry, request);
        if (help === undefined) {
          return c.json({
            status: "error",
            code: "plugin_command_not_found",
            message: `Plugin command not found: ${request.path.join(" ")}`.trim(),
          }, 404);
        }
        return c.json({
          status: "ok",
          output: help,
        });
      }
      const resolved = resolvePluginCommand(registry, request);
      if (resolved === undefined) {
        return c.json({
          status: "error",
          code: "plugin_command_not_found",
          message: `Plugin command not found: ${request.path.join(" ")}`.trim(),
        }, 404);
      }
      const plugin = registry.getPlugin(resolved.pluginId);
      if (plugin?.parseCommandInput === undefined) {
        return c.json({
          status: "error",
          code: "plugin_command_parser_missing",
          message: `Plugin "${resolved.pluginId}" does not provide a CLI command parser`,
        }, 400);
      }
      const db = getDb();
      if (db === undefined) {
        return c.json({
          status: "error",
          code: "database_unavailable",
          message: "database is unavailable",
        }, 500);
      }
      try {
        const {actorUserId,...authorized}=pluginRequestScope(c,db);
        new AgentPluginStore(db,registry).requireEnabled(authorized.scope.agentId,resolved.pluginId);
        const raw = plugin.parseCommandInput({
          command: resolved.command,
          args: resolved.args,
          env: {},
          ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        });
        const parsed =
          isRecord(raw) && "input" in raw && isRecord((raw as { input: unknown }).input)
            ? (raw as { input: Record<string, unknown>; operationId?: string })
            : { input: raw as unknown as Record<string, unknown> };

        const overrideOperationId = parsed.operationId;
        if (overrideOperationId !== undefined) {
          const overrideCap = registry.getOperation(overrideOperationId);
          if (overrideCap?.pluginId !== resolved.pluginId) {
            return c.json({
              status: "error",
              code: "forbidden",
              message: `override operation ${overrideOperationId} does not belong to plugin ${resolved.pluginId}`,
            }, 403);
          }
        }

        const mainOperationId = overrideOperationId ?? resolved.command.operationId;
        if (mainOperationId === undefined) throw new Error("Command parser did not resolve an operation");

        const result = await new OperationDispatcher({ db, registry }).invoke({
          ...authorized,
          operationId: mainOperationId,
          input: parsed.input,
          subject: {
            source: invocationSource(c),
            userId: actorUserId,
          },


          ...optionalField("messageId", requestHeader(c, "x-luna-message-id")),

        });
        return c.json(result, result.status === "success" ? 200 : operationDispatchStatus(result.errorCode));
      } catch (error) {
        if(error instanceof GatewayError)return c.json({status:"error",code:error.code},error.status as 400|401|403|404|409|500);
        if(error instanceof AgentError)return c.json({status:"error",code:error.code},error.status);
        if (isPluginCommandInputError(error)) {
          return c.json({
            status: "error",
            code: error.code,
            message: error.message,
          }, 400);
        }
        throw error;
      }
    });
}

function isPluginCommandInputError(
  error: unknown,
): error is PluginCommandInputError {
  return error instanceof PluginCommandInputError ||
    (error instanceof Error &&
      error.name === "PluginCommandInputError" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string");
}

export const pluginsRoutes = createPluginsRoutes();

function defaultPluginRegistry(): PluginRegistry {
  return new PluginRegistry();
}

function maybeKernelDb(): DrizzleDB | undefined {
  try {
    return getKernel().database.db;
  } catch {
    return undefined;
  }
}

interface PluginCommandRouteRequest {
  readonly path: readonly string[];
  readonly args: readonly string[];
  readonly help: boolean;
  readonly stdin?: string;
}

interface ResolvedPluginCommand {
  readonly pluginId: string;
  readonly command: CommandContribution;
  readonly args: readonly string[];
}

function parseCommandRequest(body: unknown): PluginCommandRouteRequest | undefined {
  if (!isRecord(body) || !isStringArray(body.path) || !isStringArray(body.args)) {
    return undefined;
  }
  if (body.path.length === 0) {
    return undefined;
  }
  const stdin = typeof (body as { stdin?: unknown }).stdin === "string"
    ? (body as { stdin?: string }).stdin
    : undefined;
  return {
    path: body.path,
    args: body.args,
    help: body.help === true,
    ...(stdin === undefined ? {} : { stdin }),
  };
}

function resolvePluginCommandHelp(
  registry: PluginRegistry,
  request: PluginCommandRouteRequest,
): string | undefined {
  const helpPath = [...request.path, ...request.args].filter((part) =>
    part !== "--help" && part !== "-h" && part !== "help"
  );
  const commands = registry.listCommands()
    .filter((command) => isPathPrefix(helpPath, command.path))
    .sort((left, right) => left.path.join(" ").localeCompare(right.path.join(" ")));
  if (commands.length === 0) {
    return undefined;
  }
  if (
    commands.length === 1 &&
    commands[0] !== undefined &&
    arraysEqual(commands[0].path, helpPath)
  ) {
    return [
      "Usage:",
      `  luna ${commands[0].path.join(" ")} [options]`,
      "",
      commands[0].help ?? "Plugin command.",
      "",
      `Operation: ${commands[0].operationId}`,
    ].join("\n");
  }
  const displayName = pluginDisplayName(registry, helpPath[0]);
  const relativeCommands = commands.map((command) => ({
    path: command.path.slice(helpPath.length),
    help: commandHelpSummary(command.help),
  }));
  return [
    `Luna ${displayName}${pluginPathSuffix(helpPath)} plugin CLI`,
    "",
    "Usage:",
    ...commands.map((command) => `  luna ${command.path.join(" ")} [options]`),
    "",
    "Commands:",
    ...relativeCommands.map((command) =>
      `  ${padRight(command.path.join(" "), 28)}${command.help ?? ""}`.trimEnd()
    ),
  ].join("\n");
}

function commandHelpSummary(help: string | undefined): string {
  return help?.split(/\r?\n/, 1)[0] ?? "";
}

function resolvePluginCommand(
  registry: PluginRegistry,
  request: PluginCommandRouteRequest,
): ResolvedPluginCommand | undefined {
  const argv = [...request.path, ...request.args];
  let match: CommandContribution | undefined;
  for (const command of registry.listCommands()) {
    if (!isPathPrefix(command.path, argv)) {
      continue;
    }
    if (match === undefined || command.path.length > match.path.length) {
      match = command;
    }
  }
  if (match === undefined) {
    return undefined;
  }
  const pluginId = registry.commandOwner(match.path);
  if (pluginId === undefined) {
    return undefined;
  }
  return {
    pluginId,
    command: match,
    args: argv.slice(match.path.length),
  };
}

function isPathPrefix(path: readonly string[], argv: readonly string[]): boolean {
  if (path.length > argv.length) {
    return false;
  }
  return path.every((segment, index) => argv[index] === segment);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function padRight(value: string, length: number): string {
  return value.length >= length ? `${value}  ` : value.padEnd(length, " ");
}

function pluginDisplayName(
  registry: PluginRegistry,
  pluginId: string | undefined,
): string {
  if (pluginId === undefined) {
    return "Plugin";
  }
  return registry.getPlugin(pluginId)?.manifest.displayName ?? titleCase(pluginId);
}

function pluginPathSuffix(path: readonly string[]): string {
  const suffix = path.slice(1).join(" ");
  return suffix.length === 0 ? "" : ` ${suffix}`;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function invocationSource(c: Parameters<typeof dashboardAuthSessionFromContext>[0]): OperationInvocationSource {
  const claims = lunaAccessTokenClaimsFromContext(c);
  if (claims?.source === "cli") {
    return "cli";
  }
  if (claims?.source === "runner" && claims.runnerKind === "main") {
    return "main_runner";
  }
  if (claims?.source === "runner" && claims.runnerKind === "task") {
    return "task_runner";
  }
  if (dashboardAuthSessionFromContext(c)?.authenticated === true) {
    return "dashboard";
  }
  return "service_api";
}

function requestHeader(
  c: Parameters<typeof dashboardAuthSessionFromContext>[0],
  name: string,
): string | undefined {
  const value = c.req.header(name)?.trim() ?? "";
  return value.length === 0 ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]: V } | {} {
  return value === undefined ? {} : { [key]: value } as { [P in K]: V };
}
