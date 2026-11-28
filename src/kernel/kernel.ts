import { AgentMemoryStore } from "@/agents/agent-memory-store";
import {InvocationResources} from "@/runners/invocation-resources";
import {AgentWorkerAccessStore} from "@/agents/agent-worker-access-store";
import {ShadowWorkerRoutingStore} from "@/agents/shadow-worker-routing-store";
import {AgentResourceBuilder} from "@/runners/agent-resource-builder";
import {InvocationStore} from "@/runners/invocation-store";
import {AgentError, type AgentScope} from "@/agents/agent-store";
import {ExecutionError} from "@luna/execution-store";
import {AgentLifecycleStore} from "@/agents/agent-lifecycle-store";
import {sessionConfigForAgent} from "@/agents/agent-settings-store";
import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {TaskScopeResolver} from "@/agents/task-scope";
import { Runtime, runtimeConfigFile } from "@/runtime/runtime";
import { join } from "node:path";
import { RuntimeAgentTransport } from "@/runners/runtime-agent-transport";
import { verifyRuntimeContexts } from "@/runners/runtime-context-preflight";
import { TaskReportService } from "@/tasks/task-report-service";
import { RunnerOperationService } from "@/runners/operation-service";
import { ChannelConfigStore } from "@/channels/config-store";
import { SessionReplyDispatcher } from "@/messaging/session-reply-dispatcher";
import { DashboardChannel, DASHBOARD_CHANNEL_ID } from "@/channels/dashboard/dashboard-channel";
import { SessionCommandService, registerSessionCommands } from "@/messaging/session-command-service";
import { createSessionTriggerExecutor } from "@/sessions/trigger-executor";
import { createScheduledTaskRunExecutor } from "@/tasks/scheduled-task-executor";

import { DataConnection, ProcessDataRetentionScheduler } from "@/data";
import * as lunaSchema from "@/data/schema";
import { TaskRunSupervisor } from "@/tasks/task-run-supervisor";
import {
  TaskRunNotificationService,
} from "@/tasks/task-run-notification-service";
import {
  TaskRunNotificationRecovery,
} from "@/tasks/task-run-notification-recovery";
import type { TaskRunNotification } from "@/tasks/task-run-notification-store";
import {
  ChannelAdapterRegistry,
  type ChannelAdapter,
  type ChannelConfig,
  type RegisteredChannelRuntimeStatus,
} from "@/channels";
import { FeishuMessageChannel } from "../../extensions/channels/feishu";
import {
  LunaMessageIngress,
} from "@/messaging/gateway/luna-message-ingress";
import { TaskResultEventPublisher } from "@/main-runner/task-result-events";
import { MainRunner } from "@/main-runner/main-runner";
import type { TaskResultForMainRunner } from "@/main-runner/types";
import {
  assertStoredRunnerRoots,
  RunnerContextStore,
} from "@/runners/runner-context-store";
import { SessionRunnerAttemptStore } from "@/sessions/session-runner-attempt-store";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import { config, createLogger, DEFAULT_SESSION_CONFIG, type AgentRunner } from "@/shared";
import {
  ActiveAgentConfigService,
  AgentSecretCipher,
  type AgentExecutionSnapshot,
} from "@/agent-config";
import {
  createAgentRunnerForConfig,
} from "@/kernel/agents";
import type { ReplyChannel } from "@/channels/outbound";
import { SessionInboundRouter } from "@/sessions/inbound/session-inbound-router";
import {
  registerPluginOperations,
} from "@/operations/operation-registry";
import {
  OperationAuditRetentionScheduler,
  OperationInvocationAuditStore,
  materializeRunnerPrompts,
  materializeRunnerSkills,
  PluginRegistry,
} from "@/plugins";
import { loadPluginsForBoot } from "@/plugins/loader";
import { materializeRunnerBin } from "@/plugins/runner-bin";
import { PluginMarketplaceService } from "@/plugins/marketplace/marketplace-service";

import { HonoServer } from "../server";

/**
 * The kernel is the main entry point for the Luna agent runtime.
 * Lazy-creation singleton: the instance is created on first `getInstance()`.
 */
class Kernel {
  private _logger = createLogger("kernel");
  private _database!: DataConnection;
  private _sessionCommands!: SessionCommandService;
  private _started = false;
  private _stopped = false;
  private _lunaMessageIngress!: LunaMessageIngress;
  private _honoServer!: HonoServer;
  private _taskRunSupervisor!: TaskRunSupervisor;
  private _activeAgentConfig!: ActiveAgentConfigService;
  private _agentRunner: AgentRunner | undefined;
  private _executionRuntime: Runtime | undefined;
  private _runtimeAgentTransport: RuntimeAgentTransport | undefined;
  private _runtimeRecovery: Promise<void> | undefined;
  private _agentRunnerKey: string | undefined;
  private _operationAuditRetention:
    | OperationAuditRetentionScheduler
    | undefined;
  private _processDataRetention:
    | ProcessDataRetentionScheduler
    | undefined;
  private _pluginRegistry = new PluginRegistry();
  private readonly _channelAdapterRegistry = new ChannelAdapterRegistry();

  private readonly _lunaChannels = new Map<string, ChannelAdapter>();

  constructor() {
    this._initChannelAdapterRegistry();
    this._initDatabase();
    this._initTaskRunSupervisor();
    this._initLunaMessageIngress();
    this._initServer();
  }

  get database(): DataConnection {
    return this._database;
  }

  get executionRuntime(): Runtime | undefined { return this._executionRuntime; }

  get agentResourceBuilder(): AgentResourceBuilder {
    return new AgentResourceBuilder(this._database.db, config.paths.home, this._pluginRegistry);
  }

  get runtimeAgentTransport(): RuntimeAgentTransport {
    if (this._runtimeAgentTransport) return this._runtimeAgentTransport;
    if (!this._executionRuntime) throw new Error("Runtime has not started");
    return this._runtimeAgentTransport = new RuntimeAgentTransport(this._database.db, this._executionRuntime);
  }

  get honoServer(): HonoServer {
    return this._honoServer;
  }

  dashboardChannel(): DashboardChannel {
    const channel = this._lunaChannels.get(DASHBOARD_CHANNEL_ID);
    if (!(channel instanceof DashboardChannel)) throw new Error("Dashboard channel is not registered");
    return channel;
  }

  replyChannel(id: string): ReplyChannel | undefined {
    return new SessionReplyDispatcher(this._database.db, key => this._lunaChannels.get(key)).channel(id);
  }

  private readonly _channelReloads = new Map<string, Promise<void>>();
  private _channelReloadsClosed = false;
  private _lifecycleTimer?: ReturnType<typeof setInterval>;
  private _lifecycleWork: Promise<void> | undefined;
  /** Enabled channels skipped because their saved App Secret cannot be decrypted. */
  private readonly _unreadableChannels = new Map<string, string>();
  private _lastShadowPurgeSweep = 0;
  private _orphanWork: Promise<void> | undefined;

  reloadChannel(id: string): Promise<void> {
    if (this._channelReloadsClosed) return Promise.reject(new Error("Kernel is stopping"));
    const prior = this._channelReloads.get(id) ?? Promise.resolve();
    const change = prior.catch(() => {}).then(() => this._reloadChannel(id));
    this._channelReloads.set(id, change);
    void change.finally(() => { if (this._channelReloads.get(id) === change) this._channelReloads.delete(id); }).catch(() => {});
    return change;
  }

  private async _reloadChannel(id: string): Promise<void> {
    const runtime = new ChannelConfigStore(this._database.db).runtimeChannels();
    const configured = runtime.configs.find(row => row.id === id);
    const unreadable = runtime.unreadable.find(row => row.id === id);
    if (unreadable) this._unreadableChannels.set(id, unreadable.type); else this._unreadableChannels.delete(id);
    const adapter = configured ? this._channelAdapterRegistry.create({type:configured.type,id,options:configured.params},{db:this._database.db,logger:this._logger}) : undefined;
    const previous = this._lunaChannels.get(id);
    if(adapter)this._lunaChannels.set(id,adapter);else this._lunaChannels.delete(id);
    try {
      await this._lunaMessageIngress.replaceChannel(id,adapter);

    } catch(error) { if(previous)this._lunaChannels.set(id,previous);else this._lunaChannels.delete(id); throw error; }
  }

  channelStatuses(): RegisteredChannelRuntimeStatus[] {
    return [...this._lunaMessageIngress.channelStatuses(), ...[...this._unreadableChannels].map(([id, type]) => ({
      id, type, inbound: { state: "credentials_invalid", lastError: "已保存的 App Secret 无法解密" },
    }))];
  }

  prepareForRuntimeStart(): void {
    if (this._started) {
      return;
    }

    try {
      this._database.close();
    } catch {
      // The kernel can be imported before the boot loader resolves LUNA_HOME.
      // Startup still needs a fresh database connection for the resolved home.
    }
    this._initDatabase();
    this._initTaskRunSupervisor();
    this._initLunaMessageIngress();
    this._initServer();
    this._stopped = false;
  }

  taskReports(): TaskReportService {
    return new TaskReportService(this._database.db, result =>
      this._publishTaskResultEvent(result, subscription => this.replyChannel(subscription.channel_id)));
  }

  runnerOperations(): RunnerOperationService {
    return new RunnerOperationService(this._database.db, this._taskRunSupervisor, this._createTaskRunNotificationService());
  }

  createSessionInboundRouter(channel: ReplyChannel): SessionInboundRouter {
    return new SessionInboundRouter({
      db: this._database.db,
      channel,
      runnerType: "unconfigured",
      mainRunner: this._createMainRunner(),
      taskRunSupervisor: this._taskRunSupervisor,
    });
  }

  resolveAgentExecutionSnapshot(scope: AgentScope, invocationId?:string): AgentExecutionSnapshot {
    new TaskScopeResolver(this._database.db).active(scope);
    if(invocationId) {
      const invocation=new InvocationStore(this._database.db).find(invocationId);
      if(invocation) {
        if(invocation.state!=="active" || invocation.settledAt!==null) throw new Error("Invocation is no longer active");
        new TaskScopeResolver(this._database.db).assertSame(scope,invocation);
        if(!invocation.agentConfig) throw new Error("Invocation model configuration is missing");
        return this._activeAgentConfig.resolvePinnedSnapshot(scope.agentId,invocation.agentConfig);
      }
    }
    return this._activeAgentConfig.resolveShadowExecutionSnapshot(scope);
  }

  async registerLunaInboundChannel(channel: ChannelAdapter): Promise<void> {
    await this._lunaMessageIngress.registerChannel(channel);
    this._lunaChannels.set(channel.id, channel);
  }

  async handleInboundMessageForTest(
    channel: ChannelAdapter,
    message: Parameters<LunaMessageIngress["handleInboundMessageForTest"]>[1],
  ): Promise<void> {
    const existingChannel = this._lunaChannels.get(channel.id);
    if (existingChannel === undefined) {
      this._lunaChannels.set(channel.id, channel);
    }
    try {
      await this._lunaMessageIngress.handleInboundMessageForTest(
        channel,
        message,
      );
      await this._sessionCommands.waitForIdle();
    } finally {
      if (existingChannel === undefined) {
        this._lunaChannels.delete(channel.id);
      } else {
        this._lunaChannels.set(channel.id, existingChannel);
      }
    }
  }

  private _initDatabase(): void {
    this._runtimeAgentTransport = undefined;
    this._agentRunner = undefined;
    this._agentRunnerKey = undefined;
    this._database = new DataConnection(lunaSchema);
    this._sessionCommands = new SessionCommandService({ db: this._database.db, channelFor: id => this.replyChannel(id),
      executeTrigger: createSessionTriggerExecutor(this._database.db, () => this._createMainRunner(), (sessionId) => this._runnerTypeForSession(sessionId)),
      executeTaskRun: createScheduledTaskRunExecutor(this._database.db, () => this._taskRunSupervisor),
      memory: () => new PlatformSettingsStore(this._database.db).get().memory });
    // Entries imported by a migration have no search terms until they are indexed here.
    new AgentMemoryStore(this._database.db).reindex();
    registerSessionCommands(this._database.db, this._sessionCommands);
    this._activeAgentConfig = new ActiveAgentConfigService(
      this._database.db,
      AgentSecretCipher.tryFromEnvironment(),
    );
    assertStoredRunnerRoots(this._database.db);
  }

  private _initServer(): void {
    this._honoServer = new HonoServer({
      db: this._database.db,
      pluginRegistry: this._pluginRegistry,
      resumeChannels: async job => {
        for (const id of new AgentLifecycleStore(this._database.db).channels(job)) {
          if (!this._lunaChannels.has(id)) await this.reloadChannel(id);
        }
      },
    });
    this._operationAuditRetention = new OperationAuditRetentionScheduler({
      store: new OperationInvocationAuditStore(this._database.db),
    });
    this._processDataRetention = new ProcessDataRetentionScheduler({
      db: this._database.db,
    });
  }

  private _initChannelAdapterRegistry(): void {
    registerFeishuChannelAdapterFactory(this._channelAdapterRegistry);
  }

  private _initTaskRunSupervisor(): void {
    this._taskRunSupervisor = new TaskRunSupervisor({
      db: this._database.db,
      runnerType: "unconfigured",
      resolveRunnerType: (taskId, taskRunId) => {
        const prior=taskRunId ? new InvocationStore(this._database.db).findActive({runnerKind:"task",taskRunId}) : undefined;
        return this.resolveAgentExecutionSnapshot(new TaskScopeResolver(this._database.db).task(taskId),prior?.id).agentType;
      },
      runNotifications: this._createTaskRunNotificationService(),
      onTaskResult: (result) =>
        this._publishTaskResultEvent(result, (subscription) =>
          this.replyChannel(subscription.channel_id),
        ),
    });
  }

  private _initLunaMessageIngress(): void {
    this._lunaMessageIngress = new LunaMessageIngress({
      onChannelStarted: (channel, bindingId) => {
        const identity=channel.getBotIdentity?.();
        if(channel.type === "feishu" && identity && bindingId) new ChannelConfigStore(this._database.db).recordIdentity(channel.id,identity,bindingId);
      },
      db: this._database.db,
      runnerType: "unconfigured",
      mainRunner: this._createMainRunner(),
      taskRunSupervisor: this._taskRunSupervisor,
    });
  }

  /**
   * Start the kernel.
   */
  async start(): Promise<void> {
    if (this._started) {
      return;
    }
    if (this._stopped) {
      this._initDatabase();
      this._initTaskRunSupervisor();
      this._initLunaMessageIngress();
      this._initServer();
      this._stopped = false;
    }
    this._channelReloadsClosed = false;
    let honoServerStarted = false;
    let lunaIngressStarted = false;
    let lunaIngressNeedsStop = false;
    try {
      await this._loadInstalledPluginsForBoot();
      await this._prepareContainerRuntimeForStartup();
      this._initServer();
      this._operationAuditRetention?.start();
      await this._honoServer.start();
      honoServerStarted = true;
      this._refreshMarketplaceAfterServerStart();
      await this._registerConfiguredLunaChannels();
      await this._recoverExplicitTaskRuns();
      await this.runnerOperations().recoverPending();
      await this._recoverTaskRunNotifications();
      this._runtimeRecovery = this._recoverPendingTaskResultEvents().catch(error => {
        this._logger.warn({ error }, "Runtime Task result recovery remains pending");
      });
      lunaIngressNeedsStop = true;
      await this._recoverSessionQueue();
      await this._lunaMessageIngress.start();
      lunaIngressStarted = true;
      this._sessionCommands.start();
      this._processDataRetention?.start();
      this._lifecycleTimer = setInterval(() => {
        this._lifecycleWork ??= this._reconcileAgentLifecycle()
          .catch(error => this._logger.warn({error}, "Agent lifecycle reconciliation remains pending"))
          .finally(() => {this._lifecycleWork = undefined;});
        // Apart from lifecycle work: a Worker may take minutes to remove orphaned data.
        this._orphanWork ??= this._reconcileWorkerOrphans()
          .catch(error => this._logger.warn({error}, "Worker orphan reconciliation failed"))
          .finally(() => {this._orphanWork = undefined;});
      }, 1000);
      this._started = true;
    } catch (err) {
      this._logger.error({ err }, "kernel startup failed; rolling back");
      this._channelReloadsClosed = true;
      await Promise.allSettled([...this._channelReloads.values()]);
      const cleanupErrors: unknown[] = [];
      await this._runtimeAgentTransport?.detach();
      await this._runtimeRecovery;

      if (lunaIngressStarted || lunaIngressNeedsStop) {
        try {
          await this._lunaMessageIngress.stop();
        } catch (cleanupErr) {
          cleanupErrors.push(cleanupErr);
        }
      }
      if (honoServerStarted) {
        try {
          await this._taskRunSupervisor.abortAndWait(
            "Runtime startup failed.",
          );
        } catch (cleanupErr) {
          cleanupErrors.push(cleanupErr);
        }
      }
      if (honoServerStarted) {
        try {
          await this._honoServer.stop();
        } catch (cleanupErr) {
          cleanupErrors.push(cleanupErr);
        }
      }
      this._processDataRetention?.stop();
      this._operationAuditRetention?.stop();
      try { await this._executionRuntime?.close(); } catch (cleanupErr) { cleanupErrors.push(cleanupErr); }
      this._executionRuntime = undefined;
      try {
        this._database.close();
      } catch (cleanupErr) {
        cleanupErrors.push(cleanupErr);
      }

      this._started = false;
      this._stopped = true;
      this._runtimeAgentTransport = undefined;
      this._runtimeRecovery = undefined;
      if (cleanupErrors.length > 0) {
        this._logger.warn(
          { cleanup_errors: cleanupErrors },
          "kernel startup rollback completed with cleanup errors",
        );
      }
      throw err;
    }
  }

  private async _registerConfiguredLunaChannels(): Promise<void> {
    await this.registerLunaInboundChannel(new DashboardChannel(this._database.db));

    const runtime = new ChannelConfigStore(this._database.db).runtimeChannels();
    for (const row of runtime.unreadable) {
      this._unreadableChannels.set(row.id, row.type);
      this._logger.error({ channel_id: row.id }, "channel App Secret cannot be decrypted; this channel stays offline");
    }
    for (const channelConfig of runtime.configs) {
      const adapter = this._channelAdapterRegistry.create(
        {
          type: channelConfig.type,
          id: channelConfig.id,
          options: channelConfig.params,
        },
        { logger: this._logger, db: this._database.db },
      );
      await this._lunaMessageIngress.registerChannel(adapter);
      this._lunaChannels.set(channelConfig.id, adapter);
      this._logger.info(
        { channel_id: channelConfig.id, channel_type: channelConfig.type },
        "registered channel adapter with Luna ingress",
      );
    }
  }

  private async _loadInstalledPluginsForBoot(): Promise<void> {
    this._pluginRegistry = await loadPluginsForBoot({
      db: this._database.db,
    });
    materializeRunnerSkills({
      pluginRegistry: this._pluginRegistry,
    });
    materializeRunnerBin({
      pluginRegistry: this._pluginRegistry,
    });
    materializeRunnerPrompts();
    this._agentRunner = undefined;
    this._agentRunnerKey = undefined;
    registerPluginOperations(
      this._database.db,
      this._pluginRegistry.listOperations(),
      this._pluginRegistry.listPlugins().map((plugin) => plugin.manifest.id),
      this._pluginRegistry,
    );
  }

  private _refreshMarketplaceAfterServerStart(): void {
    if (!new PlatformSettingsStore(this._database.db).get().marketplace.gitUrl) {
      return;
    }
    void new PluginMarketplaceService({ db: this._database.db })
      .refresh()
      .then((result) => {
        if (result.status === "success") {
          this._logger.info(
            {
              marketplace_id: result.marketplaceId,
              release_count: result.releaseCount,
              commit: result.commit,
            },
            "plugin marketplace startup refresh completed",
          );
          return;
        }
        this._logger.warn(
          {
            marketplace_id: result.marketplaceId,
            error: result.error,
          },
          "plugin marketplace startup refresh failed",
        );
      })
      .catch((err) => {
        this._logger.warn({ err }, "plugin marketplace startup refresh failed");
      });
  }

  private async _prepareContainerRuntimeForStartup(): Promise<void> {
    const file = runtimeConfigFile(config.paths.home, config.sandbox);
    const workerAccess=new AgentWorkerAccessStore(this._database.db);
    this._executionRuntime = await Runtime.start(file, (scope, options)=>{
      new TaskScopeResolver(this._database.db).active(scope);
      return workerAccess.allowed(scope.agentId, options);
    },(scope,digest)=>new InvocationResources(this._database.db,config.paths.home).download(scope,digest),
    id=>new InvocationStore(this._database.db).canReleasePreparation(id),
    ({ownerUserId,agentId},workerId)=>{
      try {
        workerAccess.setOwned(ownerUserId,agentId,workerId,"active");
      } catch (error) {
        if (error instanceof AgentError) throw new ExecutionError(error.status,error.code);
        throw error;
      }
    },scope=>{
      const routing=new ShadowWorkerRoutingStore(this._database.db).get(scope);
      return routing.mode==="bound" ? routing.workerId : undefined;
    });
    const transport = this.runtimeAgentTransport;
    await transport.client.verify();
    await verifyRuntimeContexts(this._database.db, transport.client);
    transport.recoverCancellations();
  }

  private async _recoverExplicitTaskRuns(): Promise<void> {
    const recoveredCount = await this._taskRunSupervisor.recoverRunningRuns();
    if (recoveredCount > 0) {
      this._logger.warn(
        { recovered_count: recoveredCount },
        "recovered interrupted explicit Task Runs",
      );
    }
  }

  private async _recoverPendingTaskResultEvents(): Promise<void> {
    const taskRunNotifications = this._createTaskRunNotificationService();
    const recoveredCount = await new TaskResultEventPublisher({
      resolveRunnerType: (sessionId) => this._runnerTypeForSession(sessionId),
      db: this._database.db,
      runnerType: "unconfigured",
      mainRunner: this._createMainRunner(),
      channelForSubscription: (subscription) =>
        this.replyChannel(subscription.channel_id),
      taskRunNotifications,
    }).recoverPending();
    if (recoveredCount > 0) {
      this._logger.warn(
        { recovered_count: recoveredCount },
        "recovered pending Task result notifications",
      );
    }
  }

  private async _recoverTaskRunNotifications(): Promise<void> {
    const recoveredCount = await new TaskRunNotificationRecovery({
      db: this._database.db,
      channelForNotification: (notification) =>
        this._channelForTaskRunNotification(notification),
    }).recoverPending();
    if (recoveredCount > 0) {
      this._logger.warn(
        { recovered_count: recoveredCount },
        "recovered pending Task Run status-card notifications",
      );
    }
  }

  private async _recoverSessionQueue(): Promise<void> {
    await this._lunaMessageIngress.recoverPending();
  }

  private async _publishTaskResultEvent(
    result: TaskResultForMainRunner,
    channelForSubscription: ConstructorParameters<
      typeof TaskResultEventPublisher
    >[0]["channelForSubscription"],
  ): Promise<void> {
    const taskRunNotifications = this._createTaskRunNotificationService();
    await new TaskResultEventPublisher({
      resolveRunnerType: (sessionId) => this._runnerTypeForSession(sessionId),
      db: this._database.db,
      runnerType: "unconfigured",
      mainRunner: this._createMainRunner(),
      channelForSubscription,
      taskRunNotifications,
    }).publish(result);
  }

  private _createTaskRunNotificationService(): TaskRunNotificationService {
    return new TaskRunNotificationService({
      db: this._database.db,
      channelForNotification: (notification) =>
        this._channelForTaskRunNotification(notification),
    });
  }

  private _channelForTaskRunNotification(
    notification: TaskRunNotification,
  ): ReplyChannel | undefined {
    return this.replyChannel(notification.channelId);
  }

  private _resolveAgentRunner(snapshot: AgentExecutionSnapshot): AgentRunner {
    const runnerKey = `${snapshot.agentId}:${snapshot.revisionId}:${snapshot.configFingerprint}`;
    if (
      !this._agentRunner ||
      this._agentRunnerKey !== runnerKey
    ) {
      this._agentRunner = createAgentRunnerForConfig(
        snapshot,
        this.runtimeAgentTransport,
      );
      this._agentRunnerKey = runnerKey;
    }
    return this._agentRunner;
  }

  private _createMainRunner(): MainRunner {
    return new MainRunner({
      resolveAgentExecution: (scope, invocationId) => {
        const snapshot = this.resolveAgentExecutionSnapshot(scope, invocationId);
        return { runner: this._resolveAgentRunner(snapshot), snapshot };
      },
      runnerContextStore: new RunnerContextStore(this._database.db),
      attemptStore: new SessionRunnerAttemptStore(this._database.db),
      serviceAuthDb: this._database.db,
    });
  }

  private _runnerTypeForSession(sessionId: string): string {
    return this.resolveAgentExecutionSnapshot(new TaskScopeResolver(this._database.db).session(sessionId)).agentType;
  }

  private async _reconcileAgentLifecycle(): Promise<void> {
    const runtime = this._executionRuntime;
    if (!runtime) return;
    const lifecycle = new AgentLifecycleStore(this._database.db);
    await Promise.all(lifecycle.pending().map(job => lifecycle.reconcile(job, async id => {
      if (this._lunaChannels.has(id)) await this.reloadChannel(id);
    }, scope => runtime.drainShadow(scope), scope => runtime.purgeShadow(scope))));
    // Shadows deleted before their data was purged (or while a Worker was away); once a minute.
    if (Date.now() - this._lastShadowPurgeSweep < 60_000) return;
    this._lastShadowPurgeSweep = Date.now();
    for (const scope of lifecycle.purgeable(runtime.placedShadows())) {
      try { await runtime.purgeShadow(scope); }
      catch (error) { this._logger.warn({error, ...scope}, "Deleted Shadow data purge remains pending"); }
    }
  }

  /**
   * Workers drop the data of Shadows this Service no longer knows, e.g. after its database
   * was replaced, as the platform's orphan cleanup setting says. Off means nothing is asked.
   */
  private async _reconcileWorkerOrphans(): Promise<void> {
    const runtime = this._executionRuntime;
    if (!runtime) return;
    const settings = runtime.orphanCleanup().get();
    if (!settings.enabled) return;
    const lifecycle = new AgentLifecycleStore(this._database.db);
    for (const report of await runtime.reconcileWorkerScopes(scopes => lifecycle.live(scopes),
      settings.intervalMinutes * 60_000, settings.retentionDays * 86_400_000)) {
      if (report.error) this._logger.warn(report, "Worker orphan reconciliation failed");
      else if (report.result && (report.result.stopped.length || report.result.purged.length || report.result.busy.length))
        this._logger.info(report, "Worker removed data of Shadows this Service does not know");
    }
  }

  /**
   * Stop the kernel and release runtime resources.
   */
  async stop(): Promise<void> {
    if (!this._started) {
      return;
    }
    this._channelReloadsClosed = true;
    clearInterval(this._lifecycleTimer);
    await this._lifecycleWork;
    await this._orphanWork;
    await Promise.allSettled([...this._channelReloads.values()]);
    await this._runtimeAgentTransport?.detach();
    await this._runtimeRecovery;
    this._runtimeRecovery = undefined;
    await this._lunaMessageIngress.stop();
    await this._sessionCommands.stop();
    this._operationAuditRetention?.stop();
    await this._taskRunSupervisor.abortAndWait("Runtime stopped.");
    await this._honoServer.stop();
    await this._executionRuntime?.close();
    this._executionRuntime = undefined;
    this._database.close();
    this._started = false;
    this._stopped = true;
    this._runtimeAgentTransport = undefined;
  }
}

function registerFeishuChannelAdapterFactory(
  registry: ChannelAdapterRegistry,
): void {
  registry.register({
    type: "feishu",
    create(channelConfig, deps): ChannelAdapter {
      const params = channelConfig.options ?? {};
      const appId = stringOption(params, "app_id");
      const appSecret = stringOption(params, "app_secret");
      const chatId = stringOption(params, "chat_id");
      if (!appId || !appSecret) {
        throw new Error(
          `Feishu channel "${channelConfig.id}" requires app_id and app_secret params.`,
        );
      }

      return new FeishuMessageChannel(channelConfig.id, {
        ...(deps.db === undefined
          ? {}
          : {
              developerId: () => {
                const developers = new PlatformSettingsStore(deps.db!).get().messaging.feishuDevelopers;
                return Object.hasOwn(developers, appId) ? developers[appId] : undefined;
              },
            }),
        chatId: chatId ?? "",
        appId,
        appSecret,
        ...(deps.db === undefined ? {} : { db: deps.db }),
        ...optionalStringOption(params, "bot_open_id", "botOpenId"),
        ...optionalStringOption(params, "bot_user_id", "botUserId"),
        ...optionalStringOption(params, "bot_union_id", "botUnionId"),
        // The bot's Agent may name its own aliases; without a database only the default ones apply.
        groupBotAliases: deps.db === undefined ? DEFAULT_SESSION_CONFIG.group_bot_aliases
          : () => sessionConfigForAgent(deps.db!, agentOfChannel(deps.db!, channelConfig.id), DEFAULT_SESSION_CONFIG).group_bot_aliases,
      });
    },
  });
}

/** The Agent a bot channel belongs to. */
function agentOfChannel(db: DrizzleDB, channelId: string): string | undefined {
  return db.select({agentId: lunaSchema.channelConfigs.agentId}).from(lunaSchema.channelConfigs)
    .where(eq(lunaSchema.channelConfigs.id, channelId)).get()?.agentId;
}

function stringOption(
  options: NonNullable<ChannelConfig["options"]>,
  key: string,
): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringOption(
  options: NonNullable<ChannelConfig["options"]>,
  sourceKey: string,
  targetKey: string,
): Record<string, string> {
  const value = stringOption(options, sourceKey);
  return value === undefined ? {} : { [targetKey]: value };
}

/**
 * Process-wide Luna kernel singleton used by the runtime server.
 */
export const kernel = new Kernel();
