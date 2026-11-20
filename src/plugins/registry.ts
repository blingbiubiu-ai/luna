import { isOperationPattern, matchesOperation } from "@/operations/operation-pattern";
import type {
  BundledPluginDefinition,
  OperationDefinition,
  CommandContribution,
  HostPermission,
  PluginManifest,
  PluginRuntimeFactory,
  RunnerToolContribution,
  SkillContribution,
} from "./manifest";
import { isHostPermission } from "./manifest";

export class PluginManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManifestValidationError";
  }
}

export interface RegisteredPlugin {
  readonly manifest: PluginManifest;
  readonly createRuntime: PluginRuntimeFactory;
  readonly parseCommandInput?: import("./manifest").PluginCommandInputParser;
  readonly config: unknown;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly operations = new Map<string, OperationDefinition>();
  private readonly commands = new Map<string, CommandContribution>();
  private readonly tools = new Map<string, RunnerToolContribution>();
  private readonly skills = new Map<string, SkillContribution>();

  registerPlugin(
    manifest: PluginManifest,
    createRuntime: PluginRuntimeFactory,
    config: unknown,
    parseCommandInput?: import("./manifest").PluginCommandInputParser,
  ): RegisteredPlugin {
    validateManifestShape(manifest);
    this.assertNamespaces(manifest);
    this.assertPluginCanRegister(manifest);

    const registered = {
      manifest,
      createRuntime,
      ...(parseCommandInput === undefined ? {} : { parseCommandInput }),
      config,
    } satisfies RegisteredPlugin;
    this.plugins.set(manifest.id, registered);

    for (const operation of manifest.operations) {
      this.operations.set(operation.id, {
        ...operation,
        defaultDecision: resolveDefaultDecision(manifest, operation),
        providerType: operation.providerType ?? "plugin",
        pluginId: operation.pluginId ?? manifest.id,
      });
    }
    for (const command of manifest.commands ?? []) {
      this.commands.set(commandPathKey(command.path), command);
    }
    for (const tool of manifest.tools ?? []) {
      this.tools.set(tool.name, tool);
    }
    for (const skill of manifest.skills ?? []) {
      this.skills.set(skill.id, skill);
    }

    return registered;
  }

  getPlugin(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id);
  }

  listPlugins(): RegisteredPlugin[] {
    return [...this.plugins.values()];
  }

  getOperation(id: string): OperationDefinition | undefined {
    const exact=this.operations.get(id);
    if (exact) return exact;
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(id)) return undefined;
    const plugin=this.listPlugins().find(p=>p.manifest.operationNamespaces?.some(n=>id.startsWith(`${n.namespace}.`)));
    if (!plugin) return undefined;
    const definition: OperationDefinition={id,pluginId:plugin.manifest.id,providerType:"plugin",title:id,inputSchema:{type:"object"},riskLevel:"medium",artifactPolicy:"none"};
    return {...definition,defaultDecision:resolveDefaultDecision(plugin.manifest,definition)};
  }

  listDynamicNamespaces(): string[] {
    return this.listPlugins().flatMap(p=>p.manifest.operationNamespaces?.map(n=>n.namespace) ?? []);
  }

  commandOwner(path: readonly string[]): string | undefined {
    return this.listPlugins().find(p=>p.manifest.commands?.some(c=>commandPathKey(c.path)===commandPathKey(path)))?.manifest.id;
  }

  private assertNamespaces(manifest: PluginManifest): void {
    const owned=new Set([...manifest.operations.map(o=>o.id.split(".")[0]!),...(manifest.operationNamespaces ?? []).map(n=>n.namespace)]);
    const existing=new Set(this.listPlugins().flatMap(p=>[...p.manifest.operations.map(o=>o.id.split(".")[0]!),...(p.manifest.operationNamespaces ?? []).map(n=>n.namespace)]));
    for (const namespace of owned) {
      if (["workspace","system","memory","chat"].includes(namespace) || existing.has(namespace) || !/^[a-z][a-z0-9_-]*$/.test(namespace)) throw new PluginManifestValidationError(`Namespace is reserved or already owned: ${namespace}`);
    }
    if ((manifest.operationNamespaces ?? []).some(n=>n.mode !== "dynamic")) throw new PluginManifestValidationError("Unsupported namespace mode");
  }

  listOperations(): OperationDefinition[] {
    return [...this.operations.values()];
  }

  resolveCommand(path: readonly string[]): CommandContribution | undefined {
    return this.commands.get(commandPathKey(path));
  }

  listCommands(): CommandContribution[] {
    return [...this.commands.values()];
  }

  getTool(name: string): RunnerToolContribution | undefined {
    return this.tools.get(name);
  }

  listTools(): RunnerToolContribution[] {
    return [...this.tools.values()];
  }

  getSkill(id: string): SkillContribution | undefined {
    return this.skills.get(id);
  }

  listSkills(): SkillContribution[] {
    return [...this.skills.values()];
  }

  private assertPluginCanRegister(manifest: PluginManifest): void {
    if (this.plugins.has(manifest.id)) {
      throw new PluginManifestValidationError(
        `Plugin id "${manifest.id}" is already registered.`,
      );
    }

    const operationIds = new Set<string>();
    for (const operation of manifest.operations) {
      assertUnique(
        operationIds,
        operation.id,
        `Duplicate operation id "${operation.id}" in plugin "${manifest.id}".`,
      );
      if (this.operations.has(operation.id)) {
        throw new PluginManifestValidationError(
          `Operation id "${operation.id}" is already registered.`,
        );
      }
      if (
        operation.pluginId !== undefined &&
        operation.pluginId !== manifest.id
      ) {
        throw new PluginManifestValidationError(
          `Operation "${operation.id}" declares pluginId "${operation.pluginId}" but belongs to plugin "${manifest.id}".`,
        );
      }
    }

    const commandPaths = new Set<string>();
    for (const command of manifest.commands ?? []) {
      if (!(command.operationId && operationIds.has(command.operationId)) && !manifest.operationNamespaces?.some(n=>n.namespace===command.namespace)) {
        throw new PluginManifestValidationError(
          `Command "${commandPathKey(command.path)}" references unknown operation "${command.operationId}".`,
        );
      }
      const key = commandPathKey(command.path);
      assertUnique(
        commandPaths,
        key,
        `Duplicate command path "${key}" in plugin "${manifest.id}".`,
      );
      if (this.commands.has(key)) {
        throw new PluginManifestValidationError(
          `Command path "${key}" is already registered.`,
        );
      }
    }

    const containerBinaries = new Set(
      this.listPlugins().flatMap(plugin => (plugin.manifest.containerCommands ?? []).map(command => command.binary)),
    );
    for (const { binary } of manifest.containerCommands ?? []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binary)) {
        throw new PluginManifestValidationError(`Invalid container command binary: ${binary}`);
      }
      assertUnique(containerBinaries, binary, `Container command "${binary}" is already registered.`);
    }

    const toolNames = new Set<string>();
    for (const tool of manifest.tools ?? []) {
      if (!operationIds.has(tool.operationId)) {
        throw new PluginManifestValidationError(
          `Tool "${tool.name}" references unknown operation "${tool.operationId}".`,
        );
      }
      assertUnique(
        toolNames,
        tool.name,
        `Duplicate tool name "${tool.name}" in plugin "${manifest.id}".`,
      );
      if (this.tools.has(tool.name)) {
        throw new PluginManifestValidationError(
          `Tool name "${tool.name}" is already registered.`,
        );
      }
    }

    const skillIds = new Set<string>();
    for (const skill of manifest.skills ?? []) {
      assertUnique(
        skillIds,
        skill.id,
        `Duplicate skill id "${skill.id}" in plugin "${manifest.id}".`,
      );
      if (this.skills.has(skill.id)) {
        throw new PluginManifestValidationError(
          `Skill id "${skill.id}" is already registered.`,
        );
      }
    }
  }
}

export type { BundledPluginDefinition };

function validateManifestShape(manifest: PluginManifest): void {
  assertNonEmpty(manifest.id, "Plugin id is required.");
  assertNonEmpty(manifest.displayName, `Plugin "${manifest.id}" displayName is required.`);
  assertNonEmpty(manifest.version, `Plugin "${manifest.id}" version is required.`);
  if (manifest.source !== "bundled" && manifest.source !== "marketplace") {
    throw new PluginManifestValidationError(
      `Plugin "${manifest.id}" has unsupported source "${manifest.source}".`,
    );
  }
  if (
    manifest.source === "marketplace" &&
    (manifest.runtime?.entrypoint ?? "").trim().length === 0
  ) {
    throw new PluginManifestValidationError(
      `Plugin "${manifest.id}" marketplace manifest runtime entrypoint is required.`,
    );
  }

  if (!Array.isArray(manifest.operations)) {
    throw new PluginManifestValidationError(
      `Plugin "${manifest.id}" must declare operations; legacy capabilities manifests are no longer supported.`,
    );
  }

  if (manifest.defaultPermissionRules !== undefined) {
    if (!Array.isArray(manifest.defaultPermissionRules)) {
      throw new PluginManifestValidationError("defaultPermissionRules must be an array.");
    }
    for (const rule of manifest.defaultPermissionRules) {
      if (rule === null || typeof rule !== "object"
        || typeof rule.pattern !== "string"
        || (!isOperationPattern(rule.pattern)
          && !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(rule.pattern))
        || ![...manifest.operations.map(o=>o.id.split(".")[0]!),...(manifest.operationNamespaces ?? []).map(n=>n.namespace)].some(n=>rule.pattern.startsWith(`${n}.`))
        || (rule.effect !== "allow" && rule.effect !== "deny")) {
        throw new PluginManifestValidationError(
          `Plugin "${manifest.id}" defaultPermissionRules require an exact ID or prefix.* in a declared operation namespace and an allow/deny effect.`,
        );
      }
    }
  }

  for (const permission of manifest.requestedHostPermissions) {
    assertNonEmpty(
      permission,
      `Plugin "${manifest.id}" requestedHostPermissions cannot include empty values.`,
    );
    if (!isHostPermission(permission)) {
      throw new PluginManifestValidationError(
        `Plugin "${manifest.id}" requested unknown host permission "${permission as HostPermission}".`,
      );
    }
  }

  for (const operation of manifest.operations) {
    assertNonEmpty(
      operation.id,
      `Plugin "${manifest.id}" operation id is required.`,
    );
    if (operation.defaultDecision !== undefined
      && operation.defaultDecision !== "allow" && operation.defaultDecision !== "deny") {
      throw new PluginManifestValidationError(
        `Operation "${operation.id}" defaultDecision must be allow or deny.`,
      );
    }
    assertNonEmpty(
      operation.title,
      `Operation "${operation.id}" title is required.`,
    );
  }

  for (const command of manifest.commands ?? []) {
    if (command.path.length === 0) {
      throw new PluginManifestValidationError(
        `Plugin "${manifest.id}" command path cannot be empty.`,
      );
    }
    for (const part of command.path) {
      assertNonEmpty(
        part,
        `Plugin "${manifest.id}" command path cannot include empty values.`,
      );
    }
    assertNonEmpty(
      command.operationId ?? command.namespace ?? "",
      `Plugin "${manifest.id}" command requires an operationId or namespace.`,
    );
  }

  for (const tool of manifest.tools ?? []) {
    assertNonEmpty(tool.name, `Plugin "${manifest.id}" tool name is required.`);
    assertNonEmpty(
      tool.operationId,
      `Tool "${tool.name}" operationId is required.`,
    );
  }

  for (const skill of manifest.skills ?? []) {
    assertNonEmpty(skill.id, `Plugin "${manifest.id}" skill id is required.`);
  }
}

function assertUnique(
  seen: Set<string>,
  value: string,
  message: string,
): void {
  if (seen.has(value)) {
    throw new PluginManifestValidationError(message);
  }
  seen.add(value);
}

function assertNonEmpty(value: string, message: string): void {
  if (value.trim().length === 0) {
    throw new PluginManifestValidationError(message);
  }
}

function commandPathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function resolveDefaultDecision(
  manifest: PluginManifest,
  operation: OperationDefinition,
): "allow" | "deny" {
  if (operation.defaultDecision !== undefined) return operation.defaultDecision;
  const rules = (manifest.defaultPermissionRules ?? [])
    .filter((rule) => matchesOperation(rule.pattern, operation.id));
  if (rules.some((rule) => rule.effect === "deny")) return "deny";
  return rules.some((rule) => rule.effect === "allow") ? "allow" : "deny";
}
