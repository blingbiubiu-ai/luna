import {ChannelBindingGuard} from "@/channels/channel-binding-guard";
import { SessionReplyDispatcher } from "@/messaging/session-reply-dispatcher";
import { and, eq } from "drizzle-orm";
import { sessions } from "@/data/schema";
import { bindSessionBot } from "@/channels/session-bot";
import type {
  ChannelAdapter,
  NormalizedInboundMessage,
  RegisteredChannelRuntimeStatus,
} from "@/channels";
import { TaskRunSupervisor } from "@/tasks/task-run-supervisor";
import { SessionQueue } from "@/sessions/session-queue";
import type { DrizzleDB } from "@/data";

import { MainRunner } from "@/main-runner/main-runner";
import { config, type SessionConfig } from "@/shared";
import { SessionTurnProcessor, SessionInboundRouter } from "@/work/session-inbound-router";
import { WorkRunner } from "@/work/work-runner";
import { InboundCommandRouter } from "./inbound-command-router";

/**
 * Represents Luna Inbound Handler values used by inbound message ingestion.
 */
export type LunaInboundHandler = (
  message: NormalizedInboundMessage,
) => Promise<void>;

/**
 * Configuration options for message ingestion luna message ingress behavior in inbound.
 */
export interface LunaMessageIngressOptions {
  readonly onChannelStarted?: (channel: ChannelAdapter, bindingId: string | null) => void;
  readonly db: DrizzleDB;
  readonly runnerType: string;
  readonly mainRunner?: MainRunner;
  readonly taskRunSupervisor?: Pick<TaskRunSupervisor, "waitForIdle">;
  readonly sessionQueue?: SessionQueue;
  readonly sessionConfig?: SessionConfig;
}

/**
 * Coordinates Luna Message Ingress responsibilities in inbound message ingestion.
 */
export class LunaMessageIngress {
  private readonly _onChannelStarted: ((channel: ChannelAdapter, bindingId: string | null) => void) | undefined;
  private readonly _replies: SessionReplyDispatcher;
  private readonly _db: DrizzleDB;
  private readonly _runnerType: string;
  private readonly _mainRunner: MainRunner | undefined;
  private readonly _taskRunSupervisor: Pick<TaskRunSupervisor, "waitForIdle">;
  private readonly _sessionQueue: SessionQueue;
  private readonly _channels = new Map<string, ChannelAdapter>();
  private readonly _bindingGuards = new WeakMap<ChannelAdapter, ChannelBindingGuard>();
  private readonly _channelChanges = new Map<string, Promise<void>>();
  private _stopping = false;

  constructor(options: LunaMessageIngressOptions) {
    this._db = options.db;
    this._onChannelStarted = options.onChannelStarted;
    this._replies = new SessionReplyDispatcher(options.db, id => this._channels.get(id));
    this._runnerType = options.runnerType;
    this._mainRunner = options.mainRunner;
    this._taskRunSupervisor =
      options.taskRunSupervisor ??
      new TaskRunSupervisor({
        db: options.db,
        runnerType: options.runnerType,
      });
    this._sessionQueue = options.sessionQueue ??
      new SessionQueue({
        db: options.db,
        config: options.sessionConfig ?? config.session,
        executeTurn: (input, signal) =>
          new SessionTurnProcessor({
            db: options.db,
            runnerType: options.runnerType,
            channelForMessage: (message) => this._replies.channel(message.channel.id),
            ...(options.mainRunner !== undefined ? { mainRunner: options.mainRunner } : {}),
            taskRunSupervisor: this._taskRunSupervisor,
            workRunner: new WorkRunner({
              db: options.db,
              runnerType: options.runnerType,
              channelForMessage: (channelId: string) => this._replies.channel(channelId),
            }),
          }).execute(input, signal),
      });
  }

  async registerChannel(channel: ChannelAdapter): Promise<void> {
    if (this._channels.has(channel.id)) {
      throw new Error(
        `Luna inbound channel "${channel.id}" is already registered.`,
      );
    }

    const guard = new ChannelBindingGuard(this._db, channel);
    this._bindingGuards.set(channel, guard);
    const router = new SessionInboundRouter({
      db: this._db,
      channel,
      prepareSession: id => this._replies.prepare(id),
      runnerType: this._runnerType,
      ...(this._mainRunner !== undefined ? { mainRunner: this._mainRunner } : {}),
      taskRunSupervisor: this._taskRunSupervisor,
      sessionQueue: this._sessionQueue,
    });
    const commandRouter = new InboundCommandRouter({
      db: this._db,
      channel,
      schedule: (id) => this._sessionQueue.schedule(id),
    });
    try { await channel.subscribeInbound(async (message) => {
      guard.assertCurrent(message.channel);
      if (await commandRouter.handle(message)) {
        return;
      }
      guard.assertCurrent(message.channel);
      await router.route(message);
    }); } catch (error) { guard.retire(); throw error; }
    this._channels.set(channel.id, channel);
  }

  replaceChannel(id: string, replacement?: ChannelAdapter): Promise<void> {
    if (this._stopping) return Promise.reject(new Error("Luna ingress is stopping"));
    const previous = this._channelChanges.get(id) ?? Promise.resolve();
    const change = previous.catch(() => {}).then(() => this._replaceChannel(id, replacement));
    this._channelChanges.set(id, change);
    void change.finally(() => { if (this._channelChanges.get(id) === change) this._channelChanges.delete(id); }).catch(() => {});
    return change;
  }

  private async _replaceChannel(id: string, replacement?: ChannelAdapter): Promise<void> {
    const previous = this._channels.get(id);
    if (previous) this._bindingGuards.get(previous)?.retire();
    await previous?.stop?.();
    this._channels.delete(id);
    try {
      if (replacement) { await this.registerChannel(replacement); await replacement.start(); this.channelStarted(replacement); }
    } catch (error) {
      if (replacement) this._bindingGuards.get(replacement)?.retire();
      await replacement?.stop?.();
      this._channels.delete(id);
      if (previous) { this._bindingGuards.get(previous)?.restore(); this._channels.set(id, previous); await previous.start(); this.channelStarted(previous); }
      throw error;
    }
  }

  channelStatuses(): RegisteredChannelRuntimeStatus[] {
    return [...this._channels.values()].map((channel) => ({
      id: channel.id,
      type: channel.type,
      ...(channel.getStatus?.() ?? {}),
    }));
  }

  async handleInboundMessageForTest(
    channel: ChannelAdapter,
    message: NormalizedInboundMessage,
  ): Promise<void> {
    const existingChannel = this._channels.get(channel.id);
    const activeChannel = existingChannel ?? channel;
    const guard = this._bindingGuards.get(activeChannel) ?? new ChannelBindingGuard(this._db, activeChannel);
    guard.assertCurrent(message.channel);
    if (existingChannel === undefined) {
      this._channels.set(channel.id, channel);
    }
    const router = new SessionInboundRouter({
      db: this._db,
      channel: activeChannel,
      prepareSession: id => this._replies.prepare(id),
      runnerType: this._runnerType,
      ...(this._mainRunner !== undefined ? { mainRunner: this._mainRunner } : {}),
      taskRunSupervisor: this._taskRunSupervisor,
      sessionQueue: this._sessionQueue,
    });
    const commandRouter = new InboundCommandRouter({
      db: this._db,
      channel: activeChannel,
      schedule: (id) => this._sessionQueue.schedule(id),
    });
    try {
      if (!(await commandRouter.handle(message))) {
        guard.assertCurrent(message.channel);
        await router.route(message);
      }
      await this.waitForIdle();
    } finally {
      if (existingChannel === undefined) {
        this._channels.delete(channel.id);
      }
    }
  }

  async waitForIdle(): Promise<void> {
    await this._sessionQueue.waitForIdle();
    await this._taskRunSupervisor.waitForIdle();
  }

  async recoverPending(): Promise<void> {
    await this._sessionQueue.recoverPending();
  }

  private channelStarted(channel: ChannelAdapter): void {
    const guard = this._bindingGuards.get(channel);
    if (!guard) throw new Error("Channel registration is missing its binding");
    guard.assertCurrent();
    this._onChannelStarted?.(channel, guard.bindingId);
  }

  async start(): Promise<void> {
    const startedChannels: ChannelAdapter[] = [];
    for (const channel of this._channels.values()) {
      try {
        await channel.start();
        this.channelStarted(channel);
        const identity = channel.getBotIdentity?.();
        if (identity) for (const session of this._db.select().from(sessions).where(and(eq(sessions.channel_id, channel.id), eq(sessions.status, "active"), this._bindingGuards.get(channel)?.bindingId ? eq(sessions.binding_id, this._bindingGuards.get(channel)!.bindingId!) : undefined)).all()) {
          bindSessionBot(this._db, session.id, { type: channel.type, id: channel.id }, identity);
        }
        startedChannels.push(channel);
      } catch (err) {
        this._bindingGuards.get(channel)?.retire();
        for (const startedChannel of startedChannels) this._bindingGuards.get(startedChannel)?.retire();
        const cleanupErrors: unknown[] = [];
        try {
          await channel.stop?.();
        } catch (cleanupErr) {
          cleanupErrors.push(cleanupErr);
        }
        for (const startedChannel of startedChannels.reverse()) {
          try {
            await startedChannel.stop?.();
          } catch (cleanupErr) {
            cleanupErrors.push(cleanupErr);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [err, ...cleanupErrors],
            "Luna ingress startup failed; rollback also failed",
          );
        }
        throw err;
      }
    }
  }

  async stop(): Promise<void> {
    this._stopping = true;
    await Promise.allSettled([...this._channelChanges.values()]);
    for (const channel of this._channels.values()) this._bindingGuards.get(channel)?.retire();
    const cleanupErrors: unknown[] = [];
    for (const channel of this._channels.values()) {
      try {
        await channel.stop?.();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    try {
      await this._sessionQueue.stop();
    } catch (err) {
      cleanupErrors.push(err);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Luna ingress stop failed.");
    }
  }
}
