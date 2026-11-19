import { describe, expect, test } from "bun:test";

import {
  ChannelAdapterRegistry,
  type ChannelAdapter,
  type ChannelAdapterFactory,
  type ChannelConfig,
  type ChannelRuntimeDeps,
} from "../../src/channels";
import type { OutboundChannelOperation } from "../../src/channels/outbound";

class TestAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "test";

  constructor(id: string) {
    this.id = id;
  }

  async start(): Promise<void> {}

  async subscribeInbound(): Promise<void> {}

  async send(): Promise<OutboundChannelOperation> {
    return { id: "op-1", replyMode: "channel_message", channelId: this.id, content: "ok" };
  }
}

describe("ChannelAdapterRegistry", () => {
  test("registered factory can create adapter", () => {
    const registry = new ChannelAdapterRegistry();
    const factory: ChannelAdapterFactory = {
      type: "test",
      create(config: ChannelConfig, _deps: ChannelRuntimeDeps) {
        return new TestAdapter(config.id);
      },
    };

    registry.register(factory);
    const adapter = registry.create({ type: "test", id: "test-main" }, {} as ChannelRuntimeDeps);

    expect(adapter.type).toBe("test");
    expect(adapter.id).toBe("test-main");
  });

  test("unknown type error includes registered type names", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      type: "feishu",
      create() {
        return new TestAdapter("feishu-main");
      },
    });

    expect(() =>
      registry.create({ type: "slack", id: "slack-main" }, {} as ChannelRuntimeDeps),
    ).toThrow(
      'Unknown channel type "slack" for channel "slack-main". Registered channel types: feishu. Configure a matching ChannelAdapterFactory before runtime startup.',
    );
  });

  test("duplicate register reports adapter type", () => {
    const registry = new ChannelAdapterRegistry();
    const factory: ChannelAdapterFactory = {
      type: "test",
      create(config: ChannelConfig, _deps: ChannelRuntimeDeps) {
        return new TestAdapter(config.id);
      },
    };

    registry.register(factory);

    expect(() => registry.register(factory)).toThrow(
      'Channel adapter factory for type "test" is already registered.',
    );
  });
});
